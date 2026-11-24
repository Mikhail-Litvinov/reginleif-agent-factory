# Terminal relay verification

## Installed components

- Rig package 0.7.15, using the existing working checkout at `E:/Github/reginleif-agent-factory`.
- raf-hub plugin 0.5.8, using `E:/Github/raf-hub`.
- Optional Node.js terminal component 0.1.0, with locked node-pty 1.1.0 and xterm headless 6.0.0.

## Automated checks

- Full Rig suite: 747 passed, 1 existing opt-in live-model test skipped, 0 failed.
- Full hub suite: 1228 passed, 8 existing video/tool-dependent tests skipped, 0 failed.
- Terminal component: 8 passed, 0 failed.
- Both TypeScript checks passed. `rig check` passed on the installed working checkout.
- The initial full runs found a new catalogue violation and a raw-clock use; both were corrected.
  The Windows Git fixture now fixes its own checkout newline policy, and shell checks use Git Bash.

## Native Windows checks

- A real ConPTY child accepted arrow navigation, Enter and literal paste through the authenticated HTTP relay.
- Replaying an old screen revision was refused.
- A batch launcher whose path contained spaces received the selected account arguments and a remote text answer.
- Completed-process cleanup was checked after correcting a node-pty native close race.
- Temporary probe processes were stopped, and temporary probe directories were cleaned.

## Review

A separate read-only reviewer checked both repositories. Findings about unseen screen revisions,
recovery racing with terminal output, Windows batch shims, and durable held-message admission were fixed.
Follow-up findings about durable batch membership and npm Claude shims were fixed and covered by regression tests.
The final focused review reported no remaining P1/P2 findings.

## Live acceptance

The old Factory process used `--channels` without a managed allowlist. Its plugin connected, but later
topic messages did not appear in the Claude transcript. That process was stopped and the same session ID
was resumed under the new supervisor. The transcript was retained.

The live supervisor showed the development-channel startup confirmation before the plugin registered.
The hub delivered its terminal card into the existing Factory topic with a notification.
The next required acceptance action is the owner's Enter press in Telegram, followed by a short topic
message and an observed Claude response. This last user interaction has not yet been verified.

The supervisor handles terminal menus, not Windows UAC or arbitrary browser authentication dialogs.
Supported login links can be opened on the phone. The current Windows hub task runs after user logon;
this change does not add unattended Windows account logon or a separate always-on server.
