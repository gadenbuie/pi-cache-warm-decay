/**
 * pi-cache-warm-decay
 *
 * Replaces pi's flat idle continuation probability with a configurable
 * probability table (interpolated over idle time, stretched by session
 * engagement), boosted while subagents run, and records local telemetry so the
 * table can be recalibrated from real outcomes.
 *
 * "Running work" (subagents, background tasks, ...) raises p, because its
 * completion will wake the main thread. Work is tracked by configurable
 * trackers: pi.events names, tool results, or custom messages.
 *
 * Decision rule (same shape as pi's): warm iff
 *     p * missCost - warmCost >= minSavings
 *
 * Files (under <agentDir>/cache-warm-decay/):
 *   settings.json   tunable constants; re-read on every decision, no reload needed
 *   outcomes.jsonl  telemetry: "decision" and "return" records
 *
 * Commands:
 *   /cache-warm-calibrate   inject a prompt that teaches the agent to read the
 *                           telemetry and update settings.json
 *   /cache-warm-status      show active settings and telemetry counts
 *
 * Pi still enforces its own hard 30-minute idle cap; extensions cannot change it.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------- settings

export interface Group {
	/** Continuation probability while any entry of this group is running. */
	probability: number;
	/** Entries older than this are assumed lost (missed end signal) and dropped. */
	maxAgeMinutes: number;
}

/**
 * A tracker turns an observable signal into "work started" / "work ended" for a group.
 *  - source "event":         pi.events name (exact `match`); id read from payload[idField ?? "id"].
 *  - source "toolResult":    tool name (regex, full match); text = result content.
 *  - source "customMessage": message customType (regex, full match); text = message content.
 * For text sources, `idPattern` (regex, multiline) must match for the signal to count; capture group 1 is the id.
 * Without an id, starts get a synthetic id and ends remove the group's oldest entry.
 * Event names are subscribed at load, so adding one needs /reload; everything else is hot.
 */
export interface Tracker {
	group: string;
	source: "event" | "toolResult" | "customMessage";
	role: "start" | "end";
	match: string;
	idField?: string;
	idPattern?: string;
}

export interface Settings {
	enabled: boolean;
	telemetry: boolean;
	/** Warm only if p * missCost - warmCost >= minSavings (dollars). */
	minSavings: number;
	/** [idleMinutes, probability] points, ascending; linearly interpolated, clamped at both ends. */
	probabilityTable: [number, number][];
	/** Idle time is divided by an engagement factor derived from the user-message count. */
	engagement: { pivotMessages: number; min: number; max: number };
	groups: Record<string, Group>;
	/** Added to the built-in trackers. */
	trackers: Tracker[];
	disableDefaultTrackers: boolean;
}

export const DEFAULT_GROUPS: Record<string, Group> = {
	subagents: { probability: 0.9, maxAgeMinutes: 60 },
	"bg-tasks": { probability: 0.8, maxAgeMinutes: 30 },
};

export const DEFAULT_TRACKERS: Tracker[] = [
	// @tintinweb/pi-subagents
	{ group: "subagents", source: "event", role: "start", match: "subagents:started" },
	{ group: "subagents", source: "event", role: "end", match: "subagents:completed" },
	{ group: "subagents", source: "event", role: "end", match: "subagents:failed" },
	// pi-bg-tasks: bash backgrounded explicitly, by timeout, or by the user
	{ group: "bg-tasks", source: "toolResult", role: "start", match: "bash", idPattern: "background[^\\n]*? with ID: ([\\w-]+)" },
	// ...ended: completion notification, or the agent read/stopped the task itself
	{ group: "bg-tasks", source: "customMessage", role: "end", match: "bg-task-notification", idPattern: "<task_id>([\\w-]+)</task_id>" },
	{ group: "bg-tasks", source: "toolResult", role: "end", match: "bg_output|bg_stop", idPattern: "^Task: ([\\w-]+)\\nStatus: (?!running)" },
];

export const DEFAULT_SETTINGS: Settings = {
	enabled: true,
	telemetry: true,
	minSavings: 0.05,
	probabilityTable: [
		[0, 0.5],
		[15, 0.5],
		[20, 0.3],
		[25, 0.15],
		[30, 0.07],
	],
	engagement: { pivotMessages: 5, min: 0.5, max: 4 },
	groups: DEFAULT_GROUPS,
	trackers: [],
	disableDefaultTrackers: false,
};

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const DIR = join(AGENT_DIR, "cache-warm-decay");
const SETTINGS_FILE = join(DIR, "settings.json");
const OUTCOMES_FILE = join(DIR, "outcomes.jsonl");

function sanitize(raw: any): Settings {
	const d = DEFAULT_SETTINGS;
	const num = (v: any, fallback: number, lo = -Infinity, hi = Infinity) =>
		typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
	let table = d.probabilityTable;
	if (Array.isArray(raw?.probabilityTable)) {
		const pts = raw.probabilityTable
			.filter((r: any) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]))
			.map((r: any) => [Math.max(0, r[0]), Math.min(1, Math.max(0, r[1]))] as [number, number])
			.sort((a: [number, number], b: [number, number]) => a[0] - b[0]);
		if (pts.length > 0) table = pts;
	}
	const e = raw?.engagement ?? {};

	// groups: defaults, overlaid by user values. Legacy `subagentProbability` maps to groups.subagents.
	const groups: Record<string, Group> = {};
	for (const [name, g] of Object.entries(DEFAULT_GROUPS)) groups[name] = { ...g };
	if (typeof raw?.subagentProbability === "number") {
		groups.subagents.probability = num(raw.subagentProbability, groups.subagents.probability, 0, 1);
	}
	if (raw?.groups && typeof raw.groups === "object") {
		for (const [name, g] of Object.entries<any>(raw.groups)) {
			const base = groups[name] ?? { probability: 0.8, maxAgeMinutes: 60 };
			groups[name] = {
				probability: num(g?.probability, base.probability, 0, 1),
				maxAgeMinutes: num(g?.maxAgeMinutes, base.maxAgeMinutes, 1),
			};
		}
	}

	const trackers: Tracker[] = Array.isArray(raw?.trackers)
		? raw.trackers.filter(
				(t: any) =>
					t &&
					typeof t.group === "string" &&
					typeof t.match === "string" &&
					["event", "toolResult", "customMessage"].includes(t.source) &&
					["start", "end"].includes(t.role),
			)
		: [];
	for (const t of trackers) if (!groups[t.group]) groups[t.group] = { probability: 0.8, maxAgeMinutes: 60 };

	return {
		enabled: raw?.enabled !== false,
		telemetry: raw?.telemetry !== false,
		minSavings: num(raw?.minSavings, d.minSavings, 0),
		probabilityTable: table,
		engagement: {
			pivotMessages: num(e.pivotMessages, d.engagement.pivotMessages, 1),
			min: num(e.min, d.engagement.min, 0.01),
			max: num(e.max, d.engagement.max, 0.01),
		},
		groups,
		trackers,
		disableDefaultTrackers: raw?.disableDefaultTrackers === true,
	};
}

export function effectiveTrackers(s: Settings): Tracker[] {
	return [...(s.disableDefaultTrackers ? [] : DEFAULT_TRACKERS), ...s.trackers];
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((c: any) => (typeof c === "string" ? c : c?.type === "text" ? c.text ?? "" : "")).join("\n");
	}
	return "";
}

function fullMatch(pattern: string, value: string): boolean {
	try {
		return new RegExp(`^(?:${pattern})$`).test(value);
	} catch {
		return false;
	}
}

/** Result of running a tracker's id extraction. `matched: false` means the signal does not count. */
export function extractId(t: Tracker, payload: any, text: string): { matched: boolean; id?: string } {
	if (t.source === "event") {
		const v = payload?.[t.idField ?? "id"];
		return { matched: true, id: v === undefined || v === null ? undefined : String(v) };
	}
	if (!t.idPattern) return { matched: true };
	try {
		const m = new RegExp(t.idPattern, "m").exec(text);
		return m ? { matched: true, id: m[1] ?? undefined } : { matched: false };
	} catch {
		return { matched: false };
	}
}

let cached: { mtime: number; settings: Settings } | undefined;
export function loadSettings(): Settings {
	try {
		if (!existsSync(SETTINGS_FILE)) {
			mkdirSync(DIR, { recursive: true });
			writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n");
		}
		const mtime = statSync(SETTINGS_FILE).mtimeMs;
		if (cached?.mtime === mtime) return cached.settings;
		const settings = sanitize(JSON.parse(readFileSync(SETTINGS_FILE, "utf8")));
		cached = { mtime, settings };
		return settings;
	} catch {
		return cached?.settings ?? DEFAULT_SETTINGS;
	}
}

/** Piecewise-linear interpolation of the probability table at `minutes` of (engagement-adjusted) idle time. */
export function interpolate(table: [number, number][], minutes: number): number {
	if (minutes <= table[0][0]) return table[0][1];
	for (let i = 1; i < table.length; i++) {
		const [x1, y1] = table[i];
		if (minutes <= x1) {
			const [x0, y0] = table[i - 1];
			return x1 === x0 ? y1 : y0 + ((y1 - y0) * (minutes - x0)) / (x1 - x0);
		}
	}
	return table[table.length - 1][1];
}

export function engagementFactor(userMessages: number, s: Settings["engagement"]): number {
	const f = 1 + Math.log2(Math.max(1, userMessages) / s.pivotMessages);
	return Math.min(s.max, Math.max(s.min, f));
}

// --------------------------------------------------------------- telemetry

function record(settings: Settings, row: Record<string, unknown>) {
	if (!settings.telemetry) return;
	try {
		mkdirSync(DIR, { recursive: true });
		appendFileSync(OUTCOMES_FILE, JSON.stringify({ ts: new Date().toISOString(), ...row }) + "\n");
	} catch {
		// telemetry must never break a session
	}
}

function countUserMessages(ctx: any): number {
	try {
		return ctx.sessionManager
			.getBranch()
			.filter((e: any) => e.type === "message" && e.message?.role === "user").length;
	} catch {
		return 0;
	}
}

const modelName = (ctx: any) => (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null);
const sessionId = (ctx: any) => {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return null;
	}
};

interface PendingDecision {
	at: number;
	row: Record<string, unknown>;
}

// --------------------------------------------------------------- extension

export default function cacheWarmDecay(pi: ExtensionAPI) {
	const running = new Map<string, { group: string; at: number }>();
	let anon = 0;
	let settledAt = Date.now();
	let pending: PendingDecision[] = [];
	let decisionsSinceSettle = 0;
	let lastAction: string | null = null;
	let userInputSeen = false;
	const unsubscribes: Array<() => void> = [];

	const flushPending = (returnedAt: number | null, censored?: string) => {
		const s = loadSettings();
		for (const d of pending) {
			record(s, {
				...d.row,
				returnedAfterMs: returnedAt === null ? null : returnedAt - d.at,
				...(censored ? { censored } : {}),
			});
		}
		pending = [];
	};

	const expire = (s: Settings) => {
		const now = Date.now();
		for (const [k, v] of running) {
			const maxAge = (s.groups[v.group]?.maxAgeMinutes ?? 60) * 60_000;
			if (now - v.at > maxAge) running.delete(k);
		}
	};

	const apply = (t: Tracker, id: string | undefined) => {
		if (t.role === "start") {
			running.set(`${t.group}:${id ?? `anon-${anon++}`}`, { group: t.group, at: Date.now() });
			return;
		}
		if (id !== undefined) {
			running.delete(`${t.group}:${id}`);
			return;
		}
		for (const [k, v] of running) {
			// no id on the end signal: retire the group's oldest entry
			if (v.group === t.group) {
				running.delete(k);
				return;
			}
		}
	};

	const runningBy = () => {
		const by: Record<string, number> = {};
		for (const v of running.values()) by[v.group] = (by[v.group] ?? 0) + 1;
		return by;
	};

	// Event trackers are subscribed once, at load; the tracker list is re-read on each event.
	const eventNames = new Set(
		effectiveTrackers(loadSettings())
			.filter((t) => t.source === "event")
			.map((t) => t.match),
	);
	for (const name of eventNames) {
		const off = pi.events.on(name, (payload: any) => {
			for (const t of effectiveTrackers(loadSettings())) {
				if (t.source !== "event" || t.match !== name) continue;
				const r = extractId(t, payload, "");
				if (r.matched) apply(t, r.id);
			}
		});
		if (typeof off === "function") unsubscribes.push(off);
	}
	{
		const off = pi.events.on("subagents:disposed", () => {
			for (const [k, v] of running) if (v.group === "subagents") running.delete(k);
		});
		if (typeof off === "function") unsubscribes.push(off);
	}

	pi.on("tool_result", (event: any) => {
		const text = textOf(event.content);
		for (const t of effectiveTrackers(loadSettings())) {
			if (t.source !== "toolResult" || !fullMatch(t.match, String(event.toolName))) continue;
			if (t.role === "start" && event.isError) continue;
			const r = extractId(t, undefined, text);
			if (r.matched) apply(t, r.id);
		}
	});

	const onMessage = (event: any) => {
		const m = event?.message;
		if (!m?.customType) return;
		const text = textOf(m.content);
		for (const t of effectiveTrackers(loadSettings())) {
			if (t.source !== "customMessage" || !fullMatch(t.match, String(m.customType))) continue;
			const r = extractId(t, undefined, text);
			if (r.matched) apply(t, r.id);
		}
	};
	pi.on("message_start", onMessage);
	pi.on("message_end", onMessage);

	pi.on("session_start", (_e, ctx) => {
		running.clear();
		settledAt = Date.now();
		pending = [];
		decisionsSinceSettle = 0;
		lastAction = null;
		loadSettings(); // materialize settings.json on first run
	});

	pi.on("session_shutdown", () => {
		flushPending(null, "shutdown");
		// pi.events is shared across reloads: drop our subscriptions so a replaced runtime stops reacting.
		for (const off of unsubscribes.splice(0)) off();
		running.clear();
	});

	pi.on("input", (e: any) => {
		if (e?.source === "interactive") userInputSeen = true;
		return { action: "continue" as const };
	});

	pi.on("agent_start", (_e, ctx) => {
		const now = Date.now();
		const s = loadSettings();
		const idleMs = now - settledAt;
		if (idleMs > 30_000) {
			record(s, {
				type: "return",
				session: sessionId(ctx),
				model: modelName(ctx),
				idleMs,
				userMessages: countUserMessages(ctx),
				subagentsRunning: running.size,
				runningBy: runningBy(),
				wokenBy: userInputSeen ? "user" : "other",
				decisions: decisionsSinceSettle,
				lastAction,
			});
		}
		flushPending(now);
		userInputSeen = false;
		decisionsSinceSettle = 0;
		lastAction = null;
	});

	pi.on("agent_settled", () => {
		settledAt = Date.now();
	});

	pi.on("cache_warming_decision", (event, ctx) => {
		const s = loadSettings();
		if (!s.enabled) return;
		if (event.warmCost <= 0 && event.missCost <= 0) return; // economics unavailable: leave to pi

		const idleMs = Math.max(0, Date.now() - settledAt);
		const userMessages = countUserMessages(ctx);
		const factor = engagementFactor(userMessages, s.engagement);
		expire(s);
		const subagents = running.size;
		let groupP = 0;
		for (const g of Object.keys(runningBy())) groupP = Math.max(groupP, s.groups[g]?.probability ?? 0);
		const tableP = interpolate(s.probabilityTable, idleMs / 60_000 / factor);
		const p = Math.max(tableP, groupP);
		const expectedSavings = p * event.missCost - event.warmCost;
		const action = expectedSavings >= s.minSavings ? "warm" : "stop";

		decisionsSinceSettle++;
		lastAction = action;
		let promptTokens: number | null = null;
		try {
			promptTokens = ctx.getContextUsage?.()?.tokens ?? null;
		} catch {}
		pending.push({
			at: Date.now(),
			row: {
				type: "decision",
				session: sessionId(ctx),
				model: modelName(ctx),
				idleMs,
				userMessages,
				engagement: Number(factor.toFixed(3)),
				subagentsRunning: subagents,
				runningBy: runningBy(),
				promptTokens,
				warmCost: event.warmCost,
				missCost: event.missCost,
				piProbability: event.continuationProbability,
				piAction: event.action,
				p: Number(p.toFixed(4)),
				expectedSavings: Number(expectedSavings.toFixed(5)),
				minSavings: s.minSavings,
				action,
			},
		});
		// A "stop" ends warming until the next real request; nothing further to observe.
		return { action };
	});

	// ------------------------------------------------------------ commands

	pi.registerCommand("cache-warm-status", {
		description: "Show cache-warm-decay settings and telemetry counts",
		handler: async (_args, ctx) => {
			const s = loadSettings();
			let decisions = 0;
			let returns = 0;
			try {
				for (const l of readFileSync(OUTCOMES_FILE, "utf8").split("\n")) {
					if (l.includes('"type":"decision"')) decisions++;
					else if (l.includes('"type":"return"')) returns++;
				}
			} catch {}
			const msg = [
				`cache-warm-decay ${s.enabled ? "enabled" : "DISABLED"} (telemetry ${s.telemetry ? "on" : "off"})`,
				`minSavings $${s.minSavings}`,
				`groups: ${JSON.stringify(s.groups)}`,
				`running now: ${JSON.stringify(runningBy())}; trackers: ${effectiveTrackers(s).length} (${s.trackers.length} custom)`,
				`table [idle min, p]: ${JSON.stringify(s.probabilityTable)}`,
				`engagement: ${JSON.stringify(s.engagement)}`,
				`telemetry: ${decisions} decisions, ${returns} returns in ${OUTCOMES_FILE}`,
				`settings: ${SETTINGS_FILE}`,
			].join("\n");
			ctx.ui.notify(msg, "info");
		},
	});

	pi.registerCommand("cache-warm-calibrate", {
		description: "Ask the agent to analyze cache-warm telemetry and update the probability table",
		handler: async (_args, _ctx) => {
			pi.sendUserMessage(calibrationPrompt());
		},
	});
}

// ------------------------------------------------------------------ prompt

function calibrationPrompt(): string {
	return `Recalibrate the pi-cache-warm-decay extension from its local telemetry.

## Background
The extension decides, before each idle prompt-cache refresh, whether to warm:
  warm iff  p * missCost - warmCost >= minSavings
where p is the probability that a real request arrives before the refreshed cache entry expires (the model's promptCache.short window, typically 600-1200 s). It chooses p from a table of [idleMinutes, p] points, linearly interpolated, where idle time is divided by an engagement factor (1 + log2(userMessages / pivotMessages), clamped to [min, max]). While tracked work is running (groups, e.g. subagents or bg-tasks; see runningBy in the telemetry) it uses the highest groups.<name>.probability if that exceeds the table value. Pi itself caps idle warming at 30 minutes.

## Files
- Settings (edit this): ${SETTINGS_FILE}
- Telemetry (read-only, JSONL): ${OUTCOMES_FILE}

## Telemetry records
\`decision\` (one per refresh decision):
  ts, session, model, idleMs (since the agent last settled), userMessages, engagement, subagentsRunning,
  promptTokens, warmCost, missCost, piProbability/piAction (pi's own estimate), p (what we used),
  expectedSavings, minSavings, action ("warm"|"stop"),
  returnedAfterMs: ms from this decision until the next real agent run began, or null if none did
  (censored: true outcome unknown; \`censored\` says why, e.g. "shutdown").
\`return\` (one per agent run that begins after > 30 s idle):
  ts, session, model, idleMs, userMessages, subagentsRunning, wokenBy ("user" = typed input, "other" = e.g. subagent
  completion), decisions (how many decisions preceded it), lastAction.

## How to estimate probabilities
1. Load the JSONL (python or jq). Ignore \`return\` rows with wokenBy "other" when estimating the human return rate, but use them to understand subagent behavior.
2. A decision "hit" means returnedAfterMs is non-null and <= the model's cache window in ms (use 1200000 if unsure; check promptCache for the model in ~/.pi/agent/models.json). A null returnedAfterMs is a miss only if the session ended ("shutdown"); treat other nulls as unknown and drop them.
3. Bucket decisions by idle minutes after engagement adjustment (idleMs / 60000 / engagement), e.g. 0-5, 5-10, 10-15, 15-20, 20-25, 25-30. Compute hit rate per bucket with n. Separately compute the rate per group present in runningBy (subagentsRunning is the total count of tracked work).
4. Beware selection effects: you only observe outcomes of the "warm" and "stop" actions actually taken. After a "stop" the cache goes cold, and the user may avoid resuming a cold session, which depresses observed return rates. Prefer decisions with action "warm" for unbiased hit rates, and compare "stop" outcomes separately.
5. Past money spent is not evidence; do not raise p because a refresh already cost money (sunk cost). Only observed return behavior should move p.

## How to update
- Require at least 30 decisions per bucket before changing that bucket; otherwise keep the existing value.
- Change values gradually: move each p at most halfway toward the observed rate per calibration run, round to 2 decimals, keep the table monotone non-increasing in idle minutes, and stay within [0.01, 0.99].
- Update groups.<name>.probability only from decisions where runningBy contains that group, with at least 30 samples. Long-lived background tasks (dev servers, watchers) never end on their own, so also check whether groups.<name>.maxAgeMinutes should shrink.
- Break-even sanity check: warming pays off roughly when p > warmCost / missCost; report how often decisions flipped warm/stop under the new table (replay telemetry against the new settings).
- Copy ${SETTINGS_FILE} to ${SETTINGS_FILE}.bak-<timestamp> before editing. Settings are re-read on every decision, so no reload is needed.
- minSavings is a risk margin for estimation error, not a probability; only change it if the user asks.

## Deliverable
Report: sample sizes, observed vs. current p per bucket, the exact diff you applied to settings.json, and any buckets left unchanged for lack of data. If there is too little telemetry to justify any change, say so and change nothing.`;
}
