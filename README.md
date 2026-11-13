# pi-cache-warm-decay

A [pi](https://pi.dev) extension that replaces pi's flat idle **continuation probability** (15%) for prompt-cache warming with a configurable, telemetry-calibrated model.

Pi refreshes an idle session's prompt cache when `p × missCost − warmCost ≥ minSavings`, where `p` is the chance a real request arrives before the cache expires. This extension answers pi's `cache_warming_decision` hook with its own `p`.

## How `p` is chosen

- **Tracked work running** (subagents, background tasks, anything you add): the group's `probability`, used if it exceeds the table value. Its completion will wake the main thread, so a refresh is likely to pay off.
- **Always:** a `probabilityTable` of `[idleMinutes, p]` points, linearly interpolated and clamped at both ends. Idle time is first divided by an **engagement** factor, `1 + log2(userMessages / pivotMessages)` clamped to `[min, max]`, so busy sessions decay more slowly.
- Warm iff `p × missCost − warmCost ≥ minSavings` (default `$0.05`; pi's built-in is also `$0.05`).

Pi still enforces its own 30-minute idle cap; extensions cannot change it.

## Install

```sh
pi install git:github.com/gadenbuie/pi-cache-warm-decay
# or from a checkout
pi install /path/to/pi-cache-warm-decay
```

Pi's `cacheWarming` setting must be `"idle"` for idle refreshes to happen.

## Settings

`~/.pi/agent/cache-warm-decay/settings.json` is created on first run and re-read on every decision (no reload needed):

```json
{
  "enabled": true,
  "telemetry": true,
  "minSavings": 0.05,
  "probabilityTable": [[0, 0.5], [15, 0.5], [20, 0.3], [25, 0.15], [30, 0.07]],
  "engagement": { "pivotMessages": 5, "min": 0.5, "max": 4 },
  "groups": {
    "subagents": { "probability": 0.9, "maxAgeMinutes": 60 },
    "bg-tasks": { "probability": 0.8, "maxAgeMinutes": 30 }
  },
  "trackers": [],
  "disableDefaultTrackers": false
}
```

The old `subagentProbability` key is still read and maps to `groups.subagents.probability`.

The defaults are a cautious prior. Measured data from sessions recorded *without* warming under-states return rates, because you avoid resuming sessions you believe are cold, so calibrate from telemetry collected with warming on.

## Telemetry

Appended to `~/.pi/agent/cache-warm-decay/outcomes.jsonl` (local only, no prompt content):

- `decision`: idle time, user-message count, engagement, subagents running, prompt tokens, pi's and our probability, costs, action, and `returnedAfterMs` (time until the next real run, or `null` if none came).
- `return`: each agent run beginning after more than 30 s idle, with `wokenBy` (`user` or `other`, e.g. a subagent or background-task completion). Both row types carry `subagentsRunning` (total tracked work) and `runningBy` (per group).

Set `"telemetry": false` to stop recording.

## Commands

- `/cache-warm-status`: show active settings and telemetry counts.
- `/cache-warm-calibrate`: send the agent a prompt explaining the telemetry schema, selection-bias caveats and update rules, so it can analyze the log and edit `settings.json`.

## Tracking running work

A **tracker** turns a signal into "work started" or "work ended" for a group. Entries older than the group's `maxAgeMinutes` are dropped, so a missed end signal cannot keep the probability high forever. Long-lived background tasks (dev servers, watchers) never end by themselves, which is what `maxAgeMinutes` is for.

| `source` | `match` | Text / id |
|---|---|---|
| `event` | exact `pi.events` name | id from `payload[idField ?? "id"]` |
| `toolResult` | tool name (regex, full match) | `idPattern` runs on the result text |
| `customMessage` | message `customType` (regex, full match) | `idPattern` runs on the message text |

`idPattern` (multiline regex) must match for the signal to count, and capture group 1 is the id. With no id, a start gets a synthetic id and an end retires the group's oldest entry.

Built in:

- `@tintinweb/pi-subagents`: `subagents:started` / `completed` / `failed` events.
- `pi-bg-tasks`: a `bash` result saying the command went to the background starts a task. The `bg-task-notification` message, or a `bg_output` / `bg_stop` result showing a non-running status, ends it.

Add your own in `settings.json` (they are added to the built-ins; set `disableDefaultTrackers` to drop those):

```json
"trackers": [
  { "group": "subagents", "source": "event", "role": "start", "match": "myagents:spawned", "idField": "agentId" },
  { "group": "subagents", "source": "event", "role": "end",   "match": "myagents:done",    "idField": "agentId" }
]
```

New event names need `/reload`, because pi.events subscriptions are made at load. Tool-result and custom-message trackers apply immediately. `runningBy` in the telemetry shows what was tracked at each decision, and `/cache-warm-status` shows what is running now.

## License

MIT
