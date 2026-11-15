# Rig session files

The in-window module of the `agent-rig-window` plugin (`plugins/agent-rig-window/mod/`) gives rig two things for each
running Claude Code session: a snapshot of its usage, and a request queue through which rig asks the session to do
something only the session itself can do. Everything lives under `~/.agent-rig/sessions/<session id>/`.

The module learns the home directory (`HOME`, else `USERPROFILE`) and the session id from the engine's API
(`$.env.get`, `$.session.id`). It stays off when either is missing or the id is not a safe file name
(`[A-Za-z0-9_-]{1,64}`); it never depends on anything outside the plugin folder.

## `rig session`

Rig validates session ids against the shared queue identifier pattern before using them as paths, then reads and validates the corresponding record written by the session hook. A session is live only if it has not ended and its process still has the recorded creation time; a missing PID or creation time is not live. Process lookup failures are reported rather than treated as a stopped process.

The queue client checks process liveness before publishing a request and atomically publishes it. It polls for its matching response and rereads the session record using the runtime clock; an `ended_at` value ends the wait. At the deadline it checks process liveness once more, returning `session-ended` if the process is gone and `session-timeout` otherwise. It tolerates one malformed response read, removes a consumed response and removes its request when finished, including on timeout or process exit. A missing module folder requires restarting the session. After one poll it emits `session-waiting` once. Read-only operations wait three seconds (three module polls); compact and rename wait ten minutes, matching the hub's `CLEANUP_COMPACT_MS` and allowing the current turn to finish.

Failures use `session-bad-id`, `session-unknown`, `session-invalid`, `session-io`, `session-ended`, `session-no-module`, `session-timeout`, `session-module-error` and `session-bad-response`. Module errors carry the module's text.

`rig session list` returns `{ "sessions": [{ "id", "cwd", "transcriptPath", "pid", "startedAt", "live", "module" } | { "id", "error": { "code", "message" } }] }`. Valid entries are sorted by start time newest first; entries with errors follow them. A failed record or session lookup has its own error entry and does not prevent the other sessions from being listed. The fields are raw record data, with `module` indicating the session directory exists. Creation times are queried in one batch. An absent records directory yields an empty list.

`rig session stop <id>` returns `{session, stopped: false, reason: "not-running"}` if the recorded process is no longer live. Otherwise it requests fresh usage and compacts above 120,000 context tokens, then checks process creation time again and terminates the tree. It returns `{session, stopped: true, compacted}` where `compacted` is null, `{tokensBefore, tokensAfter}`, `{skip}`, or `{error}`. Compaction failure does not prevent stopping. A process still alive after 15 seconds gives `session-stop-timeout`.

`rig session cleanup <id>` requests compaction and requires `tokensAfter < tokensBefore` without a skip; otherwise it returns `session-cleanup-not-compacted` without stopping or editing. It then stops the process without a second compact and resets invoked skill attachments in the session transcript, saving an undo file beside it and retaining the newest three. It returns `{session, compacted: {tokensBefore, tokensAfter}, backup, skillsRemoved}`. Locked replacements are retried ten times at 200 ms intervals. Both commands can return the common session errors above and `usage`, and emit `session-waiting` while waiting for the window.

`rig session compact <id> [--instructions <text>]` checks that the session is live, then requests `compact` using `COMPACT_TIMEOUT_MS` (ten minutes, sourced from the hub's `CLEANUP_COMPACT_MS`). It returns `{session, tokensBefore, tokensAfter}` from the window, or `{session, skip}` when a hook vetoes compaction. The skip is success data. It can fail with `usage` or the common session errors; it emits `session-waiting` while waiting.

`rig session rename <id> <name...>` joins the remaining arguments with one space and requires a non-empty trimmed name. It checks that the session is live, then requests `rename` using `RENAME_TIMEOUT_MS`, the same ten-minute allowance as compaction. It returns `{session, name}` as answered by the window. It can fail with `usage` or the common session errors; it emits `session-waiting` while waiting.

`rig session run <id> [--mode <mode>] [--account <n>]` resumes a stopped session with its recorded directory and cswap account unless overridden. The mode defaults to the last permission-mode record in the transcript, with `default` mapped to `manual`; a missing mode is null. It returns `{session, pid, mode, account}` after a new live process is recorded. Rig builds the launch command: cswap uses the account and shared history when available, otherwise Claude runs directly; an account, requested or recorded, requires cswap. The whole launch, account included, is resolved before anything else; a recorded account is looked up through the allowlist helper, and a failed lookup is `launch-account-lookup` (with the helper reason) when cswap is present, and is ignored when cswap is absent. Enabled Telegram plugins and their marketplace supply the channels arguments. Windows uses Windows Terminal, macOS uses Terminal.app, and Linux uses x-terminal-emulator with a display or falls back to tmux. Values are validated, including Windows command metacharacters in the directory. The launched process gets the environment without `CLAUDE*`, `TELEGRAM_HUB_*` and `ANTHROPIC_*` variables (the cleaning of rig-exec-design.md), so the new session neither inherits the caller's account nor the hub's secrets; cswap and Claude pick the account from their own arguments and state. The detached launch is checked for failure for two seconds, then liveness is polled for 90 seconds. Launch stderr files live in `~/.agent-rig/launch-stderr`: rig attempts to remove each after the grace check and retries older files on later launches. Files still held open on Windows remain until a later launch after their handles close. Errors include `usage`, common session errors, `state-unreadable`, `launch-unavailable`, `launch-invalid`, `launch-account-lookup`, `launch-failed`, `launch-timeout` and `session-running`. It emits no progress events.

`rig session mode <id> <mode>` accepts `manual`, `auto`, `acceptEdits`, `plan` or `dontAsk`. If the transcript already records that mode, it returns `{session, mode, changed: false}`. Otherwise it resolves the whole launch (account included, so a failed lookup leaves the session running), stops the session and resumes it with the requested mode, returning `{session, mode, pid}`. It can return the run and stop errors, including `session-stop-timeout`, and emits `session-waiting` when the stop operation waits on the window.

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
  be determined; it is `null` also when the allowlist helper failed (then `claude` carries the failure).
- `claude`: the freshest `usage.json` `rateLimits` among the sessions whose config dir has the same cswap account
  (`account-allowlist.py batch`); an account that cannot be determined means only the session's own. A failed helper makes this block a `script-failed` error.
  `at` is the time of that reading, `sessionId` the session it came from, `limits` keep the source order (`kind` is the
  source's own name, e.g. `five_hour`, `seven_day`); `resetsAt` is `null` when the source has none.
- `codex`: the key is absent unless the feature `codex` is on in rig state and the `batch` answer (see below) allows
  `codex` for the session's config dir. Limits come from `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` (`~/.codex` when
  `CODEX_HOME` is unset or empty): date directories newest first, at most 20 files, ordered by modification time (then
  name). Each file is read backwards in 64 KiB blocks (stat plus ranged reads, never the whole file) until the last
  rate-limit event. `at` is the event's time; `windowMinutes` and `usedPercent` are the event's values, a window whose
  reset has passed is **not** zeroed (the client knows `resetsAt` and the clock).
- `volunteers`: the key is absent unless the feature `volunteers` is on and the same allowlist gate allows it. The value
  is the reading of `volunteer-models.py limits --json` with its fields in camelCase and its times as ISO strings: `at`,
  `source`, `dayPercent`, `used`, `cap`, `resetsAt` (each of the last three may be `null`) and `providers` (name to
  `{used, cap}`). The script and the allowlist tool call is bounded by a 5 s timeout (the process tree is killed).
- `context`: this session's `usage.json` context: `at`, `tokens`, `window` (`at` and `window` may be `null`);
  `threshold`, `autocompact` and `estimated` only when `usage.json` carries them.
- One helper process per pass: `account-allowlist.py batch --config-dir <dir>... --category <name>...` answers the accounts of every
  session directory and the category checks (only the features that are on) in one JSON object
  `{accounts: {dir: {present, account}}, categories: {name: {allowed, reason}}}`. A helper that fails (spawn error,
  timeout, non-zero exit, bad JSON) makes `claude`, `codex` and `volunteers` (the last two only when their feature is on)
  `script-failed` block errors naming the reason; never an absent block. `allowed: false` still omits the block.
- Errors are isolated per item. The helper answers `{error: text}` in place of one directory's `{present, account}` or
  one category's `{allowed, reason}` when that check raised; the other items keep their answers. A directory that failed
  or whose entry is malformed: for the session's own directory, `claude` is a `script-failed` error and `account` is
  `null`; for another session, that session is left out of the `claude` candidates and listed in `claude.skipped` as
  `{sessionId, error:{code,message}}` (the key is present only when there are any). A failed category makes only its own
  block (`codex` or `volunteers`) a `script-failed` error.
- A block that cannot be read is `{"error":{"code","message"}}` in the place of its data; a failing source never fails
  the command. Block codes: `no-data` (nothing recorded yet), `no-rollout` (no Codex rollout with a rate-limit event),
  `script-missing`, `script-failed`, `bad-output` (volunteer script), `no-source`. `message` is written in the rig
  language (`rig language`), from the catalogue in `src/messages.ts`.
- A block the session may not use is absent, not an error.
- Command failure (nothing else on stdout, exit code 1): `bad-session` (a malformed session id), `unknown-session`,
  `state-unreadable`, `usage` (wrong arguments).

## Reload

The module keeps no state on disk besides the files above. Its own variables start over when the engine reloads the
plugin or a session starts; the timer of an earlier load is cancelled at `session.start`.
