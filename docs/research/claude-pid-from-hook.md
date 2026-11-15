# Finding the Claude Code PID from a SessionStart hook (Windows)

Question: can a SessionStart command hook reliably find the PID of the Claude Code process that runs it? Rig needs that PID so that `rig session stop` can end the session's process by PID.

**Short answer: yes on Windows, with Claude Code 2.1.325. Use the `CLAUDE_PID` environment variable, checked against the process ancestry.**

## Setup

- Windows 11, Git Bash, Claude Code 2.1.325 (native `claude.exe`, installed under `~/.local/bin/`).
- Hook: a Python script run with `python -I`, which walks the Windows process table (one `Get-CimInstance Win32_Process` call per hook) and records the ancestor chain, the environment variables whose names contain `CLAUDE` or `PID` (values skipped for names with TOKEN, KEY, SECRET or AUTH), and the hook's stdin JSON keys.
- Runs: `claude -p "reply OK" --model haiku --settings <file>`, twice per case.
  - Case A: hook declared as a shell string `"command": "<python.exe> -I <script>"`.
  - Case B: hook declared as `"command": "<python.exe>", "args": ["-I", "<script>"]`. Claude Code accepted the `args` key.
- The probe lived in scratch `<clone>/.tmp/pid-probe/` and is not kept.

## Evidence

Chain positions counted from the hook's own Python process (index 0).

| Case | Runs | Chain above the hook | `claude.exe` at index | `CLAUDE_PID` equals that PID |
|---|---|---|---|---|
| A (shell string) | 2 | bash (usr/bin) → bash (Git/bin) → `claude.exe` | 3 | yes, both |
| B (command + args) | 2 | `claude.exe` directly, no shell | 1 | yes, both |
| Manual check, outer interactive session, fake stdin | 1 | bash → bash → bash → `claude.exe`, then a wrapper chain (`cswap.exe` → cmd → Windows Terminal) | 4 | yes |

- Case A and B: the chain is stable across the two runs of each case (same shape, different PIDs). The PIDs differ per run, as expected.
- Case B shows that a hook command with an args array is started by `claude.exe` without a shell in between.
- `CLAUDE_PID` is set in both `cli` and `sdk-cli` entrypoints. It is set in each claude process and holds that process's own PID, also in nested `claude -p` runs started from another session.
- `CLAUDE_CODE_EXECPATH` holds the path of the `claude.exe` binary.
- `CLAUDE_CODE_SESSION_ID` equals the stdin `session_id` in all four real hook runs.
- Stdin keys for SessionStart: `cwd`, `hook_event_name`, `session_id`, `source`, `transcript_path`.
- Gap in the chain: the Windows parent of some msys `timeout.exe` processes was missing from the process table (the parent had already exited). The break sat above `claude.exe` in every run, so `claude.exe` was always found.

## Rule for the hook

1. Read `CLAUDE_PID` from the environment. Accept it only if the process exists, its image name is `claude.exe`, and it is an ancestor of the hook process.
2. If that check fails, walk up from the hook's parent PID and take the first ancestor whose image name is `claude.exe`.
3. Store the PID together with the process `CreationDate` from the process table. Before `rig session stop` ends the PID, confirm that a live process with that PID still has the stored `CreationDate`. Windows reuses PIDs.
4. Do not stop a wrapper above `claude.exe` (`cswap.exe`, `cmd.exe`, `timeout.exe`). Stop `claude.exe` itself.

## Where the rule can fail

- npm-installed Claude Code (`node.exe` running `cli.js`): the image name is `node.exe`, not `claude.exe`. The rule as written does not match it. Not tested here; the match would need the `claude-code` `cli.js` path in the command line.
- `CLAUDE_PID` is an undocumented environment variable. I did not check whether it is a documented contract, so it may change between versions. The ancestor walk is the fallback.
- A break in the chain between the hook and `claude.exe` (dangling Windows parent, as seen above msys processes) would make the ancestor walk stop early. Not seen between a hook and `claude.exe` in these runs.
- PID reuse: a stored PID can point to another process after the session's claude exited. The `CreationDate` check in step 3 covers this.
- If the hook runs in a session started under a different claude binary name (renamed, or wrapped by a launcher that execs under another name), the image match fails. Not tested.
