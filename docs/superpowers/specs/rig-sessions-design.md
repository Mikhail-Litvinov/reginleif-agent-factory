# Rig session files

The in-window module of the `agent-rig-window` plugin (`plugins/agent-rig-window/mod/`) gives rig two things for each
running Claude Code session: a snapshot of its usage, and a request queue through which rig asks the session to do
something only the session itself can do. Everything lives under `~/.agent-rig/sessions/<session id>/`.

The module learns the home directory (`HOME`, else `USERPROFILE`) and the session id from the engine's API
(`$.env.get`, `$.session.id`). It stays off when either is missing or the id is not a safe file name
(`[A-Za-z0-9_-]{1,64}`); it never depends on anything outside the plugin folder.

## Files

```
~/.agent-rig/sessions/<id>/
  usage.json            latest usage snapshot, replaced whole
  requests/<req>.json   one request, written by rig
  responses/<req>.json  the answer, written by the module
```

## Snapshot: `usage.json`

Written once when the session starts and again on every `session.measure`.

| Field | Meaning |
| --- | --- |
| `at` | ISO time the snapshot was taken |
| `context` | the engine's `SessionContextUsage` as `$.session.usage` reports it (tokens, window, ...) |
| `rateLimits` | the account's rate-limit windows exactly as the last `session.measure` read them; before the first measure, those of `$.session.usage` |
| `cost` | the engine's `SessionCost`, when the host keeps a ledger; otherwise absent |

The file is written to a temporary neighbour and moved over, so a reader normally sees a whole file. The engine's
`$.fs` has no rename, so the move runs through `$.process.run` (`mv -f`, or `cmd /c move /Y` on a drive-letter home).
Where that fails, the module writes the file in place, which is not atomic: a reader must tolerate one unparsable
read and retry.

## Request queue

Rig writes `requests/<req>.json` containing `{ "id": "<req>", "op": "...", "args": { ... } }`. The file name is the
id the answer goes to; `id` in the body must equal it. Rig writes the file atomically (temporary name, then rename),
because the module reads each file once it appears. The module lists the folder once a second.

For every request the module writes `responses/<req>.json`, either `{ "id", "ok": true, "result": ... }` or
`{ "id", "ok": false, "error": "..." }`, and then removes the request. A response stays until rig removes it. An id is
handled once; a request whose response or removal failed is not run again by the same session.

| Op | Args | Result |
| --- | --- | --- |
| `usage` | none | a fresh snapshot, same fields as `usage.json` |
| `compact` | optional `instructions` (string) | `{ tokensBefore, tokensAfter }`, or `{ skip }` when a hook vetoed the compaction |
| `rename` | `name` (non-empty string; whitespace collapsed) | `{ name }`; runs the session's own `/rename` |
| `mode` | none | always an error: the engine API does not expose the permission mode |

`usage` and `mode` are read-only and answered at once, even during a turn. `compact` and `rename` wait until no turn
of the main loop runs, are executed one at a time in file-name order, and a `compact` the engine rejects is retried
for up to three polls before the error is answered.

Rejected without running: a body that is not JSON, not an object, with a different `id`, an unknown `op`, or `args`
that is not an object get an error response. A file whose name is not `<safe id>.json` is ignored entirely: no
response, no removal.

## `rig info --session <id>`

Prints the raw data of the hub's `/info` for one session as one JSON object (the contract is in `agent-rig-design.md`,
"API output"). rig formats nothing: no texts, no names of limits, no ages or durations, no rounding. The client (the
hub) decides the language, the display names, "5 hours" or "Week", "resets in 1 h", "data 10 min old" and whether
old data is shown at all. Every time is an ISO-8601 UTC string (`2026-11-15T11:50:00.000Z`); every percent is the number
as the source gave it.

```json
{
  "session": "213aedea-5ca6-40b7-bf06-3fb2e2c0a698",
  "account": 1,
  "claude": { "at": "...", "sessionId": "...", "limits": [{ "kind": "five_hour", "percentUsed": 10, "resetsAt": "..." }] },
  "codex": { "at": "...", "limits": [{ "windowMinutes": 300, "usedPercent": 6, "resetsAt": "..." }] },
  "volunteers": { "at": "...", "source": "...", "dayPercent": 42, "used": 4, "cap": 10, "resetsAt": "...", "providers": { "openrouter": { "used": 3, "cap": 10 } } },
  "context": { "at": "...", "tokens": 35243, "window": 1000000, "threshold": 300000, "autocompact": true }
}
```

Key order is `session`, `account`, `claude`, `codex`, `volunteers`, `context`.

- `session`: the id asked for. `account`: the cswap account number of the session's config dir, `null` when it cannot
  be determined.
- `claude`: the freshest `usage.json` `rateLimits` among the sessions whose config dir has the same cswap account
  (`account-allowlist.py account --config-dir <dir>`); an account that cannot be determined means only the session's own.
  `at` is the time of that reading, `sessionId` the session it came from, `limits` keep the source order (`kind` is the
  source's own name, e.g. `five_hour`, `seven_day`); `resetsAt` is `null` when the source has none.
- `codex`: the key is absent unless the feature `codex` is on in rig state and `account-allowlist.py check codex
  --config-dir <dir>` allows it. Limits come from `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (`~/.codex` when
  `CODEX_HOME` is unset or empty): date directories newest first, at most 20 files, ordered by modification time (then
  name). Each file is read backwards in 64 KiB blocks (stat plus ranged reads, never the whole file) until the last
  rate-limit event. `at` is the event's time; `windowMinutes` and `usedPercent` are the event's values, a window whose
  reset has passed is **not** zeroed (the client knows `resetsAt` and the clock).
- `volunteers`: the key is absent unless the feature `volunteers` is on and the same allowlist gate allows it. The value
  is the reading of `volunteer-models.py limits --json` with its fields in camelCase and its times as ISO strings: `at`,
  `source`, `dayPercent`, `used`, `cap`, `resetsAt` (each of the last three may be `null`) and `providers` (name to
  `{used, cap}`). The script and the allowlist tool calls are each bounded by a 5 s timeout (the process tree is killed).
- `context`: this session's `usage.json` context: `at`, `tokens`, `window` (`at` and `window` may be `null`);
  `threshold`, `autocompact` and `estimated` only when `usage.json` carries them.
- A block that cannot be read is `{"error":{"code","message"}}` in the place of its data; a failing source never fails
  the command. Block codes: `no-data` (nothing recorded yet), `no-rollout` (no Codex rollout with a rate-limit event),
  `script-missing`, `script-failed`, `bad-output` (volunteer script), `no-source`. `message` is an English text for
  logs, not for display.
- A block the session may not use is absent, not an error.
- Command failure (nothing else on stdout, exit code 1): `bad-session` (a malformed session id), `unknown-session`,
  `state-unreadable`, `usage` (wrong arguments).

## Reload

The module keeps no state on disk besides the files above. Its own variables start over when the engine reloads the
plugin or a session starts; the timer of an earlier load is cancelled at `session.start`.
