# Rig session files

The in-window module of the `agent-rig-window` plugin (`plugins/agent-rig-window/mod/`) gives rig two things for each
running Claude Code session: a snapshot of its usage, and a request queue through which rig asks the session to do
something only the session itself can do. Everything lives under `~/.agent-rig/sessions/<session id>/`.

The module learns the home directory (`HOME`, else `USERPROFILE`) and the session id from the engine's API
(`$.env.get`, `$.session.id`). It stays off when either is missing or the id is not a safe file name
(`[A-Za-z0-9_-]{1,64}`); it never depends on anything outside the plugin folder.

## `rig session`

Rig validates session ids against the shared queue identifier pattern before using them as paths, then reads and validates the corresponding record written by the session hook. A session has one process file per Claude Code process (`<id>/processes/<pid>.json`, written by the hook) and is live while at least one of them names a running process with the recorded creation time; a session with no process file, or whose process files all name gone or reused pids, is not live. A legacy record that still holds `pid`, `pid_created` and no `ended_at` counts as one process. Creation times are queried once per session. Process lookup failures are reported rather than treated as a stopped process.

A session record lives as long as its transcript. When no transcript exists at the named path or under the configured projects directory, no session process is live, and no ending marker owner is live by process identity, readers remove both the record and its session folder and treat the session as missing. A failed process query prevents removal; a stale ending marker does not.

The queue client checks process liveness before publishing a request and atomically publishes it. It polls for its matching response and rereads the session's process files using the runtime clock; the wait ends as soon as no process of the session is live by identity. Each poll makes at most one process creation-time query. The first poll reuses the pre-publish session identity result and queries only any claimant or newly checkable session pids; later polls batch the claimant pid with checkable session pids. A poll with nothing to check makes no query. It returns `session-ended` at the first poll where no process of the session is live, even if the claimant is dead; a lost claimant yields `session-claim-lost` while another session process remains live. It returns `session-timeout` when the deadline is reached while one remains live. It tolerates one malformed response read, removes a consumed response and removes its request when finished, including on timeout or process exit. A missing module folder requires restarting the session. Progress comes from the claiming module's `claims/<id>/state` (read on each poll; a missing file means no state): rig emits `session-waiting` when the state becomes `waiting` (a turn runs, another request is ahead, or a rejected compaction awaits a retry) and `session-running` when it becomes `running` after a `session-waiting`, never the same code twice in a row, and nothing when the op ran without waiting. Elapsed time never produces a progress code. Read-only operations wait three seconds (three module polls); compact, rename and autocompact wait ten minutes (`COMPACT_TIMEOUT_MS` in `src/session-core.ts`) and allowing the current turn to finish.

Failures use `session-bad-id`, `session-unknown`, `session-invalid`, `session-io`, `session-ended`, `session-no-module`, `session-timeout`, `session-claim-lost`, `session-module-error` and `session-bad-response`. Module errors carry the module's text.

`rig session list` returns `{ "sessions": [{ "id", "cwd", "transcriptPath", "pid", "processes", "startedAt", "live", "module" } | { "id", "error": { "code", "message" } }] }`. Valid entries are sorted by start time newest first; entries with errors follow them. A failed record or session lookup has its own error entry and does not prevent the other sessions from being listed. `processes` lists the live processes as `[{pid, startedAt}]`, earliest started first, and `pid` is the first of them or null. `transcriptPath` is the session's transcript, resolved when the record is loaded: the record keeps the path Claude Code named after the session's cwd at its start, which is wrong once the session is resumed in another cwd, so every reader (list, cleanup, run and mode) uses the named path when it is a file, otherwise the existing `<config_dir or ~/.claude>/projects/*/<id>.jsonl` (the most recently modified when several), and the named path when no such file exists (a new session). The other fields are raw record data, with `module` indicating that the window module's `<id>/usage.json` is readable (the hooks also create `<id>/processes/`, so the folder alone is not the marker). Creation times are queried in one batch. An absent records directory yields an empty list.

`rig session stop <id>` returns `{session, stopped: false, reason: "not-running"}` if no process of the session is live. Stop, cleanup and mode serialize their entire ending operation with the per-session `~/.agent-rig/sessions/<id>/ending.json` marker, atomically created with the rig owner's `pid`, process creation time `pidCreated` from `process.createdAt`, an ownership `token`, a `takenOver` flag and `otherOwners` holding the identities and tokens of operations still finishing after interruption. Each operation releases its token on success or failure; the marker remains until all operations finish. Dead owners and pids with another creation time are discarded, and a marker with no live owner is taken over. Marker transitions use the short-lived `ending.json.lock` to prevent competing stale takeovers from deleting fresh ownership; process-exit waits run outside that lock. A stop finding a live owner records `takenOver: true`, registers itself as the current owner and immediately terminates the session's process trees without requesting usage or compaction, abandoning any running compaction with the window; it returns `{session, stopped: true, compacted: null}` or `not-running` according to the termination result. Otherwise it requests fresh usage and compacts above 120,000 context tokens, then checks each process creation time again and terminates the tree of every live process, never a reused pid. A stop emits `session-compacting` immediately before that compaction request when it compacts, and `session-terminating` immediately before it starts ending processes; a stop that compacts emits those codes in that order, with any window `session-waiting` or `session-running` events between them. A stop with nothing live emits neither. It returns `{session, stopped: true, compacted}` where `compacted` is null, `{tokensBefore, tokensAfter}`, `{skip}`, or `{error}`. Compaction failure does not prevent stopping; an owner interrupted by another stop keeps this same result contract, including the compaction error when present and `stopped` according to its own termination result. It waits until no process of the session is live; a process still alive after 15 seconds gives `session-stop-timeout`.

`rig session cleanup <id>` takes the ending marker before starting and holds it through transcript cleanup, releasing it on success or failure; a live owner causes an immediate `session-ending` error without compaction or editing. It emits `session-compacting` before its compaction request and requires `tokensAfter < tokensBefore` without a skip; otherwise it returns `session-cleanup-not-compacted` without stopping or editing. A stop taking over during compaction ends the session: cleanup returns the compaction error and leaves the transcript untouched; a takeover observed after a successful compaction returns `session-ended` without cleaning. It emits `session-terminating` before it stops the process without a second compact, then resets invoked skill attachments in the session transcript, saving an undo file beside it and retaining the newest three. It returns `{session, compacted: {tokensBefore, tokensAfter}, backup, skillsRemoved}`. Locked replacements are retried ten times at 200 ms intervals. Both commands can return the common session errors above and `usage`; cleanup emits `session-compacting`, then window `session-waiting`/`session-running` events if applicable, then `session-terminating`.

`rig session compact <id> [--instructions <text>]` checks that the session is live, then requests `compact` using `COMPACT_TIMEOUT_MS` (ten minutes, the wait rig allows a compaction, defined in `src/session-core.ts`). It returns `{session, tokensBefore, tokensAfter}` from the window, or `{session, skip}` when a hook vetoes compaction. The skip is success data. It can fail with `usage` or the common session errors; it emits `session-waiting` while waiting.

`rig session rename <id> <name...>` joins the remaining arguments with one space and requires a non-empty trimmed name. It checks that the session is live, then requests `rename` using `RENAME_TIMEOUT_MS`, the same ten-minute allowance as compaction. It returns `{session, name}` as answered by the window. It can fail with `usage` or the common session errors; it emits `session-waiting` while waiting.

`rig session autocompact <id> <N|auto>` sets the session's auto-compact window, the same as typing `/autocompact N` (or `/autocompact auto`) in its terminal. `<N>` is a positive integer in decimal digits only (no `333k`: the client converts); anything else, or a wrong argument count, is `usage`. It checks that the session is live, then requests `autocompact` using `AUTOCOMPACT_TIMEOUT_MS` (the same ten minutes as rename: the command runs once the turn ends). It returns `{session, window: N | "auto", text?}`, where `window` is as answered by the window and `text` is the command's output, present only when the command returned any. It can fail with `usage` or the common session errors; it emits `session-waiting` while waiting. A window answer without the requested `window` is `session-bad-response`.

`rig session run <id> [--mode <mode>] [--account <n>]` resumes a stopped session with its recorded directory and cswap account unless overridden. The mode defaults to the last permission-mode record in the transcript, with `default` mapped to `manual`; a missing mode is null. It returns `{session, pid, mode, account}` after a new live process is recorded. Rig builds the launch command: cswap uses the account and shared history when available, otherwise Claude runs directly; an account, requested or recorded, requires cswap. The whole launch, account included, is resolved before anything else; a recorded account is looked up through the allowlist helper, and a failed lookup is `launch-account-lookup` (with the helper reason) when cswap is present, and is ignored when cswap is absent. Enabled Telegram plugins and their marketplace supply the channels arguments. Windows uses Windows Terminal, macOS uses Terminal.app, and Linux uses x-terminal-emulator with a display or falls back to tmux. Values are validated before the launch line is built. The account, plugin id and marketplace name must match `[A-Za-z0-9_.@-]`; the session id and mode keep their own allowlists. The directory is checked per platform, because each launch parser reads different characters as syntax. Windows refuses `& | < > ^ % " !` and control characters, and escapes each `;` as `\;` (Windows Terminal separates subcommands on `;`, and a run of backslashes before `;` is escaped with one more backslash). macOS refuses control characters, since the terminal acts on them. Linux refuses `;` and `#`, because tmux parses them in `-c`. Each launcher runs from the full path its lookup found: cswap, x-terminal-emulator and tmux are looked up as files over the `PATH` of the launch. The cswap lookup happens once per launch, and its result serves both the account decision (a failed account lookup matters only when cswap was found) and the launch, so the file checked is the file started. On Windows the lookup tries `cswap.exe`, `.com`, `.cmd` and `.bat` in each `PATH` directory in turn, so a `.cmd` shim counts, and the launch line carries the found full path in quotes (`"<path>" run ...`; the line is not wrapped in a further pair of quotes, which was probed to run nothing under the `wt.exe` layer). The cswap path goes through the same per-platform check as the directory; a path the line cannot carry is `launch-unavailable`. On Windows the launch is a detached start outside the caller's job object (the one mechanism of rig-exec-design.md), so a session started by the hub survives the hub's restart. The launched process gets the environment without `CLAUDE*`, `TELEGRAM_HUB_*` and `ANTHROPIC_*` variables (the cleaning of rig-exec-design.md), so the new session neither inherits the caller's account nor the hub's secrets; cswap and Claude pick the account from their own arguments and state. The detached launch is checked for failure for two seconds, then liveness is polled for 90 seconds. Launch stderr files live in `~/.agent-rig/launch-stderr`: rig attempts to remove each after the grace check and retries older files on later launches. Files still held open on Windows remain until a later launch after their handles close. Errors include `usage`, common session errors, `state-unreadable`, `launch-unavailable`, `launch-invalid`, `launch-account-lookup`, `launch-failed`, `launch-timeout` and `session-running`. It emits no progress events.

`rig session mode <id> <mode>` accepts `manual`, `auto`, `acceptEdits`, `plan` or `dontAsk`. It takes the ending marker before checking or changing the mode and holds it through the stop and relaunch, releasing it on success or failure; a live owner causes an immediate `session-ending` error. If the transcript already records that mode, it returns `{session, mode, changed: false}`. Otherwise it resolves the whole launch (account included, so a failed lookup leaves the session running), stops the session and resumes it with the requested mode, returning `{session, mode, pid}`. When another stop takes over its stop, mode returns `session-ending` and never relaunches: the stop wins. Launch authorization and the spawn call are one guarded marker transition, so a takeover during launch preparation also prevents spawning; the launch grace wait runs outside the guard. It can return the run and stop errors, including `session-stop-timeout`, and emits `session-compacting` when it starts compaction, then any window `session-waiting`/`session-running` events, then `session-terminating` when it starts stopping the session processes.

## Files

```
~/.agent-rig/sessions/<id>/
  processes/<pid>.json  one Claude Code process (pid, pid_created, started_at, source, config_dir), written by the hook
  usage.json            latest usage snapshot, replaced whole
  requests/<req>.json   one request, written by rig
  responses/<req>.json  the answer, written by the module
  claims/<req>/pid      the claim on a request (a directory) and the claiming Claude pid, written by the claiming module
  claims/<req>/state    `waiting` or `running`, written by the claiming module on every change
```

## Snapshot: `usage.json`

Written once when the session starts, again on every `session.measure`, and after every completed compaction of the main
conversation (manual, automatic, or plugin requested; not precompute, subagent compaction, or a skipped compaction). The
window rewrites it immediately after its own compaction for a rig `compact` request, before writing the answer; other
compactions rewrite it through the `session.compact` hook.

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

One request is run by one process. Several Claude processes can carry the same session id (a window plus a
`claude -p --resume <id>`, two windows), each with its own module polling this folder, so a module first claims a
request: it makes the directory `claims/<req>` with the one atomic step the engine offers, `mkdir` through
`$.process.run` (`mkdir <dir>`, or `cmd /c mkdir <dir>` on a drive-letter home), which fails when the directory exists
on POSIX and on NTFS. The engine's `$.fs` has no exclusive create, no mkdir and no rename, so nothing else in it is
atomic. The module that made the directory reads the request (after the claim, so a request already answered and
removed is dropped and its claim removed), runs it and answers; a module whose `mkdir` fails skips the request and
forgets its id once the file is gone. A claim is never taken over.

At registration the module learns its own Claude pid: Claude Code sets `CLAUDE_PID` in its children's environment, so
the module runs one command through `$.process.run` that prints it (`cmd /c echo %CLAUDE_PID%` on a drive-letter home,
`sh -c 'printf %s "$CLAUDE_PID"'` otherwise); anything but a positive integer means the module records no pid. After a
successful claim the module writes `claims/<req>/pid` (that pid). Rig's wait reads the pid file on each poll until it
finds one, then looks the pid's creation time up (`process.createdAt`) on that poll and every later one: the first
reading is the claimant's identity (unless that process was created after the claim directory's last change: the claimant
existed before it made the directory, so such a process is a stranger that reused the pid before the first read, and the
wait ends with `session-claim-lost` at once), and a pid that no longer exists or whose creation time differs (the pid was reused)
ends the wait with `session-claim-lost` (the claiming process died mid-request; the request is not run by another
process and the caller may send it again). Elapsed time never decides it: a claimant busy with a long step is still
waited on. A claim with no usable pid file (the module could not learn its pid, or died between making the directory and
writing the file) is waited on until the operation's own timeout, `session-timeout`.
The module also writes `claims/<req>/state` (atomically, only when it changes): `waiting` when a claimed turn-gated
request cannot start now (a turn runs, another request is ahead of it, or a compaction was rejected and awaits a retry),
`running` right before the op starts. A request that starts at once is never marked `waiting`, and the immediate ops
(usage, mode) write no state. A failed state write is ignored, like the pid write. When the wait ends for any reason
rig removes the request and then the claim directory, in that order: a module that listed the request earlier and claims
late then finds the request gone.

| Op | Args | Result |
| --- | --- | --- |
| `usage` | none | a fresh snapshot, same fields as `usage.json` |
| `compact` | optional `instructions` (string) | `{ tokensBefore, tokensAfter }`, or `{ skip }` when a hook vetoed the compaction |
| `rename` | `name` (non-empty string; whitespace collapsed) | `{ name }`; runs the session's own `/rename` |
| `autocompact` | `window` (a positive integer, or the string `"auto"`) | `{ window, text? }`; runs the session's own `/autocompact`, `text` is the command's output (trimmed) when it returns any |
| `mode` | none | always an error: the engine API does not expose the permission mode |

`usage` and `mode` are read-only and answered at once, even during a turn. `compact`, `rename` and `autocompact` wait until no turn
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
