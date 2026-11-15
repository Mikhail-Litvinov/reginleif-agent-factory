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

Prints the finished text of the hub's `/info` for one session, in rig's language; the hub shows it unchanged. One
`writeLine` call, blocks separated by one empty line, only the headers in **bold**:

```
**Claude limits** (data 10 min old)
5 hours: 25.5% (resets in 1 h)
Week: 41% (resets in 3 d)

**Codex limits** (data 1 h old)
5 hours: 12% (resets in 30 min)
Week: 0%

**Volunteer limits** (data 6 min old)
Day: 42% (resets in 1 h 54 min)
OpenRouter: 3/10

**Context**
120/300k
```

- Claude limits: the freshest `usage.json` `rateLimits` among the sessions whose config dir has the same cswap account
  (`account-allowlist.py account --config-dir <dir>`). An account that cannot be determined means only the session's own.
- Codex block: only when the feature `codex` is on in rig state and `account-allowlist.py check codex --config-dir <dir>`
  allows it. Limits come from `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (`~/.codex` when `CODEX_HOME` is unset or
  empty): date directories newest first, at most 20 files, ordered by modification time (then name). Each file is
  read backwards in 64 KiB blocks (stat plus ranged reads, never the whole file) until the last rate-limit event; a window
  whose reset has passed reads 0%.
- Volunteer block: the same gate with the feature `volunteers`; data from `volunteer-models.py limits --json`. The script
  and the allowlist tool calls are each bounded by a 5 s timeout (the process tree is killed); a timeout gives the
  `no data, <reason>` line and the command still exits 0.
- Context: this session's `usage.json` context (`120/300k`, `≈` when estimated, `1.5M` without auto-compact).
- "(data N old)" appears when the data is 5 minutes old or more.
- A block without data is one line: `<Name>: no data, <reason>`. A failing source never fails the command.
- Exit codes: 0 on success (also with no-data blocks); 1 for a malformed session id, an unknown session or wrong usage.

## Reload

The module keeps no state on disk besides the files above. Its own variables start over when the engine reloads the
plugin or a session starts; the timer of an earlier load is cancelled at `session.start`.
