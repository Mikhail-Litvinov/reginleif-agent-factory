# Agent Factory security

Design, nothing is built. [architecture.md](architecture.md) is binding (D1 to D26 are its decisions; "call" marks a choice made in these documents, open to veto); facts about Rig and
the hub are in [audit.md](audit.md); tests are in [testing.md](testing.md). This file states weakness classes and defences,
never steps to exploit the existing hub.

"Enforced in": **code** (a program refuses), **config** (a deployment setting or certificate refuses), **prompt** (agent
text only; never counted as a defence). A threat with only prompt text is listed as undefended.

## Assets

| Asset | Why it matters |
|---|---|
| Owner decisions (accept, reject, budget, permissions) | they gate every outward effect |
| Task requirements and revisions | agents act on them |
| Repositories, worktrees, unpublished commits | the work product |
| Credentials: tokens, certificates, database passwords, agent logins, Git remote credentials, API keys | spend money, publish, decide |
| Release of the worker and runner | code that holds all credentials |
| Policy files (profiles, allowlists, roles) | define what agents may do |
| Backups, logs, artifacts | may hold code and leaked secrets |

## Actors and trust borders

| Zone | Trusted for | Not trusted for |
|---|---|---|
| Server: API, Control Worker, PostgreSQL, Temporal | decisions, state, audit | exposure to a network without TLS and client auth |
| PC: local worker, runner, adapters | executing activities, holding its own credentials | deciding anything; reaching PostgreSQL |
| Hub (on the PC, loopback, no authentication today) and the Telegram client (relay role) | carrying owner buttons if the fork adds per-client keys | any request reaching it from a local process (class: unauthenticated local service) |
| Agents (Claude, Codex, OpenAI, tools) | producing a report | everything else: they read untrusted text, so their output is untrusted |
| Web panel | owner and reader views through the API | any markup from tasks, logs or agent output |
| Repositories | content | their hooks, configuration and instructions (class: repository-controlled execution) |
| Generated files (rules, settings, policy written by Rig or Factory) | being regenerated | being edited by an agent in a task |
| Temporal UI | diagnostics for the owner | being published |

Borders that carry authentication: client to API (token with role), worker to API and Temporal (certificate plus token),
Control Worker to Temporal (own certificate), relay to API (token with role relay), API to PostgreSQL (own account).
There is no border between an agent and the Windows user who runs it (D4, D13).

## Threats

| # | Threat (class) | Defence | Enforced in | Proof |
|---|---|---|---|---|
| T1 | Anyone reaching the Temporal frontend (no authorizer by default) | mTLS with required client certificates, private network, port not published | config | `deploy-ports`, S6 |
| T2 | The worker's credentials start a workflow or send an Update | separate certificates and a custom authorizer or proxy: worker may poll its own queues and complete activities only | config plus code | S6 |
| T3 | Forged decision sent as a Temporal message | the Update carries only a decision id; the workflow reads the decision from PostgreSQL and checks actor, revision and single use | code | `wf-forged-update` |
| T4 | Forged or replayed API call | token hash, role check on every route, unique idempotency key, revision check | code | `api-authz-matrix`, F6 |
| T5 | An agent holding a deciding token | agent environment is built from an allowlist; no API token, no Temporal credential, no push credential | code | `env-allowlist` |
| T6 | An agent pushes or publishes | push and publication done by the worker after an owner decision; profile denies Git remote operations; no credentials in the agent environment | code plus profile | S3. Not stopped: saved credentials of the same Windows user (T8) |
| T7 | An agent leaves its directory or uses a forbidden tool | permission mode, tool and directory lists (Claude), sandbox (Codex), worker checks of repository, directories, Git operations | profile plus code | S3, `path-escape` |
| T8 | A process of the same Windows user reads files, saved credentials, the hub key, the worker's credentials | none in version one (D13); untrusted repositories must not run | undefended | none possible on one user |
| T9 | Local process speaks to the unauthenticated hub endpoints | fork adds a per-client key, a button press is checked against allowed users and works once | code in the fork | `hub-key`, `hub-once`. The unmodified hub stays open; a local process of the same user is T8 |
| T10 | Replayed or forged Telegram button | the relay submits a decision only with the hub's press id and a Telegram user mapped to an owner (`owners.telegram_user_id`); each `press_id` works once (unique in `task_decisions`); expiry on an injected clock | code | `button-replay`, `relay-press-once` |
| T11 | One stray press does something dangerous | second press in the same channel, a `confirmations` row issued by the API (see Dangerous operations, D23) | code | `second-confirm` |
| T12 | Secret leaks into PostgreSQL, events, logs, artifacts, `state.json` | redaction of every known secret value at the worker and the API; a canary secret test over every sink | code | `secret-canary`. Unknown secrets typed by an agent are not recognised |
| T13 | Prompt injection through task text, repository files or tool results | no defence in the model. Limited by T5, T6, T7 and owner acceptance; "do not" lines in prompts are not counted | prompt only | none for the injection itself |
| T14 | An agent changes policy, hooks, rules or its own profile | policy files live outside worktrees; collecting a result refuses a diff touching policy paths unless the owner confirms; two known Rig-written files are told apart | code | `policy-diff` |
| T15 | The running release is replaced from inside a task | worker runs from an installed release (D11); installing is an owner action; the worker checks release checksums at start and refuses on mismatch | code | `release-checksum`. A same-user write to the release directory is T8 |
| T16 | Path traversal, links and junctions out of a worktree | real-path resolution against the allowlist before use | code | `path-escape` |
| T17 | Injection into the panel: SQL, script, request forgery | parameterised queries only, output escaping, CSRF token on every change, strict content security policy, no inline script from data | code | `panel-xss`, `panel-csrf`, `sql-param` |
| T18 | Repository-controlled execution (hooks, filters, config) when the worker runs Git | worker runs Git with hooks and external filters disabled and its own configuration | code | `git-hardening` |
| T19 | Foreign process killed or attached by a recycled pid | identity is pid plus creation time everywhere, including the Codex launcher (D3 change) | code | `identity-recycle` |
| T20 | Duplicate external effect | idempotency key per effect, target checked first, unclear state asks the owner (D16) | code | F13, F6 |
| T21 | Runaway spend or time | budget and time limits held by the runner and the workflow; the owner raises them | code | F12, S4 |
| T22 | Supply chain: floating images, unpinned dependencies | image digests and lockfiles; a check refuses `latest` | config plus code | `pin-check` |
| T23 | Database or UI reachable from outside | only loopback or internal network binding | config | `deploy-ports` |
| T24 | Backup exposes secrets | backups encrypted; key stored apart from the backup. Off-host copy needs a server | config | open until a server exists |
| T25 | Cross-site or token theft from the web panel from outside | TLS for any non-loopback access | config | open until a server exists |

## Roles and rights

| Role | May | May not |
|---|---|---|
| owner | decide (accept, request changes, reject, pause, resume, cancel, force-close, resolve a block, allow an agent, priority), edit requirements, budgets and allowlists, create and rotate tokens, install a release, confirm dangerous operations | nothing is blocked; dangerous ones need the second press |
| worker (a machine) | poll its own queues, heartbeat, upload results and logs, read tasks assigned to it | decide, start workflows, send Updates, reach PostgreSQL, read other machines' data |
| relay (the Telegram client) | read like a reader, acknowledge notices, submit a decision with a hub press id and a Telegram user mapped to an owner, each press id once | act for an unmapped user; reuse a press id; hold any other right |
| reader | read tasks, history, status | read secrets or raw agent logs flagged sensitive; any change |
| Control Worker (internal service identity) | start workflows, send Updates for recorded decisions, run server activities | accept anything by itself |
| agent | nothing against the API | holds no token of any role |

Temporal roles follow this table (T2). Temporal admin and UI access are held by the owner only and are not reachable
from the PC.

## Secrets and rotation

| Secret | Where it lives | Rotation |
|---|---|---|
| API tokens | hash in PostgreSQL; plain value shown once | owner creates a new token, old one revoked; two valid at once during a short overlap |
| Worker certificate and key | Windows credential storage on the PC, restricted files on the server | reissue, restart worker; the old certificate is revoked on the authorizer |
| Temporal CA and server certificates | server files, restricted rights | planned reissue before expiry; the expiry date is checked by diagnose |
| PostgreSQL passwords (two accounts) | server secret files, never in Compose text | change on the server, restart the two consumers |
| Hub per-client key | PC, restricted file | regenerate, restart hub and client |
| Agent logins and API keys | the agent's own store, or the OpenAI key in the credential store | owner replaces; usage keys are scoped to a budget where the provider allows |
| Git remote credentials | held by the worker only | owner replaces; never in an agent environment |
| Backup key | apart from the backups | rotate with a fresh backup |

Never in PostgreSQL, events, logs or `state.json`. Proof: `secret-canary`, and `rotation-old-refused` (after rotation the
old token and certificate are refused, the new ones work). A leak is handled by revoking first, then rotating.

## Permission profiles and what they do not stop

A profile is chosen by the owner per task and recorded in the decision. Claude: permission mode, tool list, directory
list. Codex: sandbox mode. The worker adds its own checks on repository, directories, Git operations and limits, and a
profile never grants more than the task's approved scope.

They do not stop (version one, D4): reading files of the same Windows user; use of saved credentials; network access of a
tool the profile allows; a local process speaking to the hub; writing to a release directory the user owns; a model
following injected instructions inside its allowed tools. A profile is a limit, not a wall. Closing this needs a separate
Windows user or a container, which is not planned for version one.

## Residual risks

| Risk | Decision | Status |
|---|---|---|
| Same-user compromise (steals keys, accepts its own task through a stolen token) | D4, D13 | accepted; untrusted repositories must not run |
| Hub endpoints unauthenticated for the unmodified hub | D5 | fork fixes the Factory path only |
| Failure notices and buttons stop when the PC is off | D5, D6 | open until a second hub on a server |
| Decision recorded but not yet applied | D10 | by design; clients show the delivery state |
| Release directory writable by the same user | D11, D13 | detected at start, not prevented |
| Codex launcher survives a reboot looking alive | D3 | closed by the identity change; test T19 |
| Cleartext traffic until TLS exists | D6 | acceptable only on loopback |
| Automatic acceptance | architecture, last section | off; turning it on is a dangerous operation |

## Self-modification

- An agent working on Factory or Rig works in a worktree and a branch; it never touches the running release (D11).
- Tests run before any update; a failing result cannot reach AWAITING_APPROVAL.
- The previous release stays; rollback switches the pointer. Installing a release is an owner action and a dangerous
  operation; it never runs from a task.
- A change to policy, profiles, roles, allowlists, hooks or security text is refused by the worker's result collection
  (T14) until the owner confirms it twice. Prompt text does not count as the guard.
- An agent never edits Rig's generated rule files; a change to them is made in the rule sources by the owner.

## Dangerous operations and second confirmation

The API, not the client, requires it (D23): two presses in the same channel. The first press records a `confirmations`
row and the API issues a nonce bound to the actor, channel, operation, target and request hash; a second request
carrying it, within `confirm.windowSeconds` measured on an injected clock, is the second press; the row works once.
Telegram, the web panel and the command line all go through the same two calls, so no channel can skip the second step.
A second press in another channel is not accepted (call: the cheapest form that the owner chose, and no channel needs
the other to be reachable).

| Operation | Why |
|---|---|
| Push, merge, pull request, publication | outward and not undoable |
| ACCEPT of a task whose diff touches policy, hooks, rules or release code | changes the guard |
| Install, switch or roll back a Factory release | code that holds all credentials |
| Create, rotate or revoke an API token or certificate | changes who may decide |
| Raise a budget or limit; change a profile to a wider one | spend and reach |
| Change directory, repository or machine allowlists | scope |
| Turn on automatic acceptance | removes the owner |
| Restore a backup or run a migration | state loss |
| Delete a worktree with unpublished changes (cleanup `force`) | work loss |
| Allow network or push in a profile | reach |
| REJECT, CANCEL and force-close of a task | closes a task for good (D7, D21, D23) |

REJECT, CANCEL, force-close and publication always take two presses (D23). PAUSE takes one: it only stops new work and
RESUME undoes it (call).

## Open, decided in its phase

| Question | What it changes for the owner | Phase |
|---|---|---|
| Whether the `reader` role may see raw agent logs, or only reports | What a read-only view can leak | 2 (the API route) |
| Whether an agent may have network access in any profile in version one (affects T6 and T13) | Reach and leak risk of every run | 4 (profiles) |

## Honest limits

- The specification (15.1) says agents must not have unrestricted access to the operating system; D4 and D13 accept
  that, on one Windows user, they do. The design says so plainly instead of claiming a wall.
- The architecture says agents get no push credentials, but saved Git credentials of the same user stay readable (T8):
  "no push credential in the environment" is true, "an agent cannot push" holds only where S3 proves the profile and
  only until the credential store is opened.
- The specification asks for TLS and Temporal UI access control (15.3); with no server these are checked on loopback
  only (T25).
