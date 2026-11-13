# pi-cache-warm-decay

A [pi](https://pi.dev) extension that replaces pi's flat idle **continuation probability** (15%) for prompt-cache warming with a configurable, telemetry-calibrated model.

Pi refreshes an idle session's prompt cache when `p × missCost − warmCost ≥ minSavings`, where `p` is the chance a real request arrives before the cache expires. This extension answers pi's `cache_warming_decision` hook with its own `p`.

## How `p` is chosen

- **Subagents running:** `subagentProbability` (default 0.9).
- **Otherwise:** a `probabilityTable` of `[idleMinutes, p]` points, linearly interpolated and clamped at both ends. Idle time is first divided by an **engagement** factor, `1 + log2(userMessages / pivotMessages)` clamped to `[min, max]`, so busy sessions decay more slowly.
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
  "subagentProbability": 0.9,
  "probabilityTable": [[0, 0.5], [15, 0.5], [20, 0.3], [25, 0.15], [30, 0.07]],
  "engagement": { "pivotMessages": 5, "min": 0.5, "max": 4 }
}
```

The defaults are a cautious prior. Measured data from sessions recorded *without* warming under-states return rates, because you avoid resuming sessions you believe are cold, so calibrate from telemetry collected with warming on.

## Telemetry

Appended to `~/.pi/agent/cache-warm-decay/outcomes.jsonl` (local only, no prompt content):

- `decision`: idle time, user-message count, engagement, subagents running, prompt tokens, pi's and our probability, costs, action, and `returnedAfterMs` (time until the next real run, or `null` if none came).
- `return`: each agent run beginning after more than 30 s idle, with `wokenBy` (`user` or `other`, e.g. a subagent completion).

Set `"telemetry": false` to stop recording.

## Commands

- `/cache-warm-status`: show active settings and telemetry counts.
- `/cache-warm-calibrate`: send the agent a prompt explaining the telemetry schema, selection-bias caveats and update rules, so it can analyze the log and edit `settings.json`.

## Subagent detection

Running subagents are tracked through the `subagents:started`, `subagents:completed` and `subagents:failed` events of [`@tintinweb/pi-subagents`](https://www.npmjs.com/package/@tintinweb/pi-subagents). Without that package the subagent boost never applies.

## License

MIT
