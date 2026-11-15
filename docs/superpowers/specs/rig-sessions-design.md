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

## Reload

The module keeps no state on disk besides the files above. Its own variables start over when the engine reloads the
plugin or a session starts; the timer of an earlier load is cancelled at `session.start`.
