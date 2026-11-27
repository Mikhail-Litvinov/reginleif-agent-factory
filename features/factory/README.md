# factory feature

Hooks of the Agent Factory for an ordinary Claude session. The owner enables the feature at the PC; it is off by default.

## Environment

| Variable | Used by | Meaning |
|---|---|---|
| `AF_API_URL` | both hooks | Base URL of the Factory API (http or https). |
| `AF_READER_TOKEN` | `regulation.ts` | Reader token for the regulation. |
| `AF_PROJECT_ID` | `regulation.ts` | Optional project whose clauses apply. |
| `AF_REGISTRY_TOKEN` | `permission.ts` | The `registry` token bound to the session (or run). |
| `AF_TASK_RUN_ID` | `permission.ts` | Set only for a Factory run (`claude -p`): the check is made for this run, and with no usable answer the hook denies, because such a run has no prompt. |

## Permission hook (`hooks/permission.ts`, PreToolUse)

Asks `POST /rights/check` for the tool call (`action` `tool`, `target` the tool name, `conditions.tool_input`).

- `allowed` from a role, record or grant gives `allow`; `refused` gives `deny` with the reason.
- `none` sends `POST /rights/requests` and polls `GET /rights/requests/{id}` until the answer: granted `allow`, refused
  `deny`, `call_owner` `ask`. Ten seconds before the hook limit (60 s) it answers `deny` with "request still waiting".
- Fails safe: Factory not configured, unreachable, registry off (503), or a malformed answer never allows. An ordinary
  session gets `ask` (the normal prompt) and one line on stderr; a Factory run gets `deny`.
- The owner's press on the normal prompt is the owner's own act, never a grant.
