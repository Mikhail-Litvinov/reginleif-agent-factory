# Agent Factory security

Design, nothing is built. [architecture.md](architecture.md) is binding (D1 to D33 are its decisions; "call" marks a choice made in these documents, open to veto); the Decision Registry and
the regulation are in [governance.md](governance.md); facts about Rig and
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
| Client (Android, Windows; D33) | owner views and presses through the API, with a device session | any text or markup from tasks, logs, agent output or chat messages; a secret, a database or Temporal account |
| Repositories | content | their hooks, configuration and instructions (class: repository-controlled execution) |
| Generated files (rules, settings, policy written by Rig or Factory) | being regenerated | being edited by an agent in a task |
| Temporal UI | diagnostics for the owner | being published |

Borders that carry authentication: client to API (device session, see Roles), worker to API and Temporal (certificate plus token),
Control Worker to Temporal (own certificate), relay to API (token with role relay), API to PostgreSQL (own account).
There is no border between an agent and the Windows user who runs it (D4, D13).

## Threats

| # | Threat (class) | Defence | Enforced in | Proof |
|---|---|---|---|---|
| T1 | Anyone reaching the Temporal frontend (no authorizer by default) | mTLS with required client certificates, private network, port not published | config | `deploy-ports`, S6 |
| T2 | The worker's credentials start a workflow or send an Update | separate certificates and a proxy with a method allowlist: the worker may poll, heartbeat and complete activities; workflow-task polling and completion stay off the list (without it they were accepted in the trial) | config | S6 |
| T3 | Forged decision: sent as a Temporal message, or as the answer to the workflow's own read of it | the Update carries only a decision id; the workflow reads the decision from PostgreSQL in a local activity (D28), so the read is never in a queue, and checks actor, revision and single use | code | `wf-forged-update`, `control-no-queue`, S6 |
| T4 | Forged or replayed API call | token hash, role check on every route, unique idempotency key, revision check | code | `api-authz-matrix`, F6 |
| T5 | An agent holding a deciding token | agent environment is built from an allowlist; no Temporal credential, no push credential, and no API token except one: the `registry` token, bound to one session or run, which can only search, open an inquiry, give a verdict, propose a draft, ask the rights check and file a right request; it decides nothing, activates nothing and gives itself no right | code | `env-allowlist`, `api-authz-matrix` |
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
| T17 | Injection through client data: SQL, markup or a link in a message, a forged message that looks like a command or an approval (D33) | parameterised queries only; a message that does not parse is plain text, links and markup inert until pressed, never a command or an approval; the client makes no request to a provider or a model; no cookie, so no request forgery by a browser | code | `sql-param`, `client-no-model`, `client-contract` |
| T18 | Repository-controlled execution (hooks, filters, config) when the worker runs Git | worker runs Git with hooks and external filters disabled and its own configuration | code | `git-hardening` |
| T19 | Foreign process killed or attached by a recycled pid | identity is pid plus creation time everywhere, including the Codex launcher (D3 change) | code | `identity-recycle` |
| T20 | Duplicate external effect | idempotency key per effect, target checked first, unclear state asks the owner (D16) | code | F13, F6 |
| T21 | Runaway spend or time | budget and time limits held by the runner and the workflow; the owner raises them | code | F12, S4 |
| T22 | Supply chain: floating images, unpinned dependencies | image digests and lockfiles; a check refuses `latest` | config plus code | `pin-check` |
| T23 | Database or UI reachable from outside | only loopback or internal network binding | config | `deploy-ports` |
| T24 | Backup exposes secrets | backups encrypted; key stored apart from the backup. Off-host copy needs a server | config | open until a server exists |
| T25 | Device session theft, or reaching the API from outside the home network (D6, D33) | cleartext on loopback only; a non-loopback bind starts only with TLS configured (the PC's own certificate, pinned by the device) and the owner's switch, home network first, outside only by another switch; the device secret is in the system key storage, never in the build, cache, log or stream, and a session is revoked alone, at once | config plus code | `client-no-secret`, `client-approval`, `deploy-ports`; outside access open until a server exists |
| T26 | A worker certificate takes another machine's activity and answers it with a forged result (the method allowlist does not see queue names; accepted in the S6 trial) | one machine only: the API refuses a second one until a gateway that binds a certificate to its own queues is in place (D28) | code | `second-machine-refused`; the gateway gets its own proof before it is switched on |
| T27 | A record is used as a permission: similar text, a `decision` record or a search result makes the check let something through (G7, D31) | a right comes only from a `permission` record matched exactly (action, target, arguments, project); a refusal (guard or deny rule) wins and no record overrides it; similar text, a `decision` record, an unreadable call, a consumed `once` record and the search give nothing; a draft in conflict with the list of guards is refused activation, also for the owner (`guard_conflict`) | code | `permission-by-record`, `registry-authority` |
| T28 | A forged press creates a wrong project record, or tries to make a permission (same Windows user, T8, D13) | the press names a poll the hub registered before sending, never text of its own, and is checked like a relay decision (T10: press id, mapped Telegram user, once); the category an agent gave is not trusted; only an offered option pressed in Telegram becomes active (G8); a `permission` record is made only by the owner's button, never by a poll press (the database refuses another source); every dangerous operation keeps its second press, with a record or a grant (D23); the result of a press is listed with its source | code; the forgery itself is undefended (T8) | `registry-capture`, `permission-second-press` |
| T29 | Prompt injection through text in records: a record steers a later agent | only what the owner pressed or confirmed by the button binds (a poll's question, options and pressed option word for word; a draft's shown text); fields the owner was not shown (summary, tags) serve the search and never bind; a precedent is advice; a verdict `applies` cites a record, it does not copy its text into a command | code plus prompt | `registry-capture`, `registry-authority`. Injection into the agent's reading stays T13 |
| T30 | An agent changes the regulation | the `registry` role may only propose a draft version; activation needs the owner and two presses (D23); the rules on changing the regulation are guards in code, not clauses | code | `regulation-change` |
| T31 | The chief engineer is talked into a grant by the request text | the chief engineer is a fresh run with no tools and the text is data; code checks every `grant`: an active clause covering the action, off the owner's list, no wider than the request, not for its own run; otherwise it becomes `call_owner`; an empty regulation grants nothing; a repeat of a refused request gets the same refusal | code | `chief-engineer` |
| T32 | A grant outlives its task, or passes to a participant it was not given to | a grant belongs to one participant of one task; it passes to that participant's next attempt and ends with the task (in an ordinary session, with the session), by the owner's revocation or by a critical suspension of the agent (`ended_by = 'critical'`); a restore never revives an ended grant; a run ending ends nothing; the search never finds a grant. A right can live in six places (a role, a grant, a `permission` record, an API token, a live session, a Codex sandbox profile), and the suspension closes each: the gate refuses at step 1, the grants and the token end, the run is killed by its identity | code | `grant-ends`, `rights-suspended` |
| T33 | An agent gives itself a right (a role, a `permission` record, a grant) | a role is given only by the chief engineer and its contents change only with the regulation (two presses, D23); a record is activated only by the owner's button; a grant is written only by the code that checked an answer of the chief engineer, never by the `registry` token | code | `role-rights`, `permission-by-record` |
| T34 | The check or the chief engineer is down, or the hook is made to wait | the hook never allows silently: an unavailable chief engineer means the request waits (no prompt, nobody else answers, and the unavailability itself is not reported to the owner; the client shows the wait; the one exception is a critical security or data-loss event from a list in code, personnel.md Hierarchy, which notifies the owner whatever the hierarchy says); the usual prompt appears only on `call_owner` or, in an ordinary session, when the registry itself is off or unreachable (fail-open, G1; the owner's press on that native prompt is the owner's own act, never a grant); a Factory run (`claude -p`) has no such prompt and is denied when the registry is unreachable; a refusal denies with the reason | code | `permission-by-record`, `chief-engineer` |
| T35 | A command is wrapped (a script, a shell inside a shell) to slip past an exact match | matching is by the call as the agent made it, exact; a call the check cannot read matches nothing and goes to the request path; a record for the wrapper gives nothing for what it runs | code | `permission-by-record` |
| T36 | Score manipulation, or an agent writes its own facts (D32) | facts come only from checks, reviews and runs the server recorded, never from an agent's report or its token; a fact has one event key, so a repeat adds nothing; below the minimum facts the result is "not enough data", not a score; the assessment is computed by code from the facts ([personnel.md](personnel.md)) | code | `personnel-facts`, `personnel-score` |
| T37 | A measure removes rights without evidence | a measure needs evidence, an author other than the accused and, for a limit, a term; level 3 and above need an independent check; in `observe` levels 3 to 6 are only proposals; a measure is restored by a record, not by editing it | code | `personnel-decision`, `personnel-effect` |
| T38 | Protected conduct is punished (a question, an honest report of a failure, a refusal the regulation requires) | the list of protected conduct is in code and the database refuses an incident that cites it (`protected_conduct`); the attempt is audited | code | `personnel-protected` |
| T39 | The critical reaction is used to stop a run falsely, or leaves a right open | the reaction (stop the run, close the rights, notify the owner) is a list of events in code, works in every mode and exists since phase 4, the first phase in which an agent holds a right; an event on the list needs a recorded fact with its key, never a claim; the control component writes the suspension, the ended grants, the revoked tokens, the audit row and the stop order in one transaction, and a right a running process cannot be deprived of (the Codex sandbox) is closed by killing the run by its identity; the owner is notified; a restore is a recorded act of the chief engineer, or of the owner when the chief engineer is the subject, never of the suspended agent | code | `personnel-safety`, `rights-suspended` |
| T40 | The chief engineer is assessed or removed by itself, or its replacement is forced | the chief engineer is assessed by an independent evaluator of another provider, which cannot read drafts of, change or stop its own assessment; a measure on the chief engineer is the owner's; replacement runs only under a procedure the owner approved beforehand, otherwise the owner decides | code | `personnel-chief` |
| T41 | A press is replayed, changed or sent from another place: an offline queue, a revoked device, another channel (D23, D33) | a press is bound by hash to operation and parameters in a `confirmations` row; a changed parameter, a used or expired one, a revoked device session or another channel is refused (`confirmation_invalid`); a dangerous press is never sent from an offline queue; every mutation carries an idempotency key; audit records device and session | code | `client-approval`, `client-retry`, `second-confirm` |
| T42 | A third-party tool's own prompt (Claude Code, Codex) is shown or answered as a client approval, or a poll is answered twice (D33) | tool permission prompts are not served: no route answers one and the list of served and not served prompts is in code; only the hooks of governance.md Rights answer them; each poll kind has one arbiter: the hub for an ordinary session (the client's answer is a request row sent with an idempotency key and retried until the hub confirms; the API never decides it), the API for a Factory decision (`task_decisions`); the first answer the arbiter takes wins and a late one is refused (`poll_closed`) | code | `client-foreign-prompt`, `client-sessions`, `poll-arbiter` |
| T43 | The factory cannot be stopped when the client, Temporal or a model is down, or a stop is forged (D33) | stop-all is served by the API and a button on the PC without the client, Temporal or a model; it ends runs and closes rights; it is a dangerous operation (two presses) and audited | code | `client-stop` |

## Roles and rights

| Role | May | May not |
|---|---|---|
| owner | decide (accept, request changes, reject, pause, resume, cancel, force-close, resolve a block, allow an agent, priority), edit requirements, budgets and allowlists, create and rotate tokens, install a release, confirm dangerous operations | nothing is blocked; dangerous ones need the second press |
| worker (a machine) | poll activity queues, heartbeat, upload results and logs, read tasks assigned to it | decide, start workflows, send Updates, poll workflow tasks, reach PostgreSQL, read other machines' data through the API. Temporal does not hold it to its own queues (T26) |
| device (the client, one session per device, D33) | read like a reader and the owner's client routes: answer a decision or a conversation poll (channel `client`), send a conversation message, read the event stream, stop-all (two presses) | create, rotate or revoke a token, add a device (the PC only), change a role, hold the role of an agent, reach PostgreSQL or Temporal; a device is revoked alone |
| hub (the owner's hub fork, second output) | record conversation messages, polls and states, each once by session and key; arbitrate the polls of ordinary sessions and write the result of a client's poll answer request (`POST /hub/poll-answers/{id}/result`, the only route that sets those columns) | read, answer a poll of a Factory decision, decide anything |
| relay (the Telegram client) | read like a reader, acknowledge notices, submit a decision or record a poll press with a hub press id and a Telegram user mapped to an owner, each press id once | act for an unmapped user; reuse a press id; hold any other right |
| reader | read tasks, history, status | read secrets or raw agent logs flagged sensitive; any change |
| Control Worker (internal service identity) | start workflows, send Updates for recorded decisions, run server steps as local activities | accept anything by itself |
| registry (an agent's token, bound to one session or run, T5) | search the registry, open an inquiry, give a verdict, propose a draft | activate, revoke or supersede a record, change the regulation, record a press, read anything else through the API |
| chief engineer (a fresh Claude run with no tools, never the owner, G14) | give a participant its role; answer a right request with `grant` (with a clause), `refuse` or `call_owner` | change what a role contains (the regulation does); grant without a clause, wider than the request, on the owner's list or for its own run (code turns it into `call_owner`); decide anything else; hold a token |
| evaluator (a fresh run of another provider, no tools, D32) | read the facts of the chief engineer and write its assessment | read drafts of, change or stop its own assessment; decide a measure; hold a token |
| permission through the check and requests (the `registry` token) | ask the rights check and file a right request for its own run or session | give itself a right, read other runs' requests, activate a `permission` record or revoke a grant |
| agent | nothing else against the API | holds a token of any role except `registry` |

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
list. Codex: sandbox mode. It is computed from the role of the participant, the `permission` records and the live grants
(D31); for Codex only the sandbox is set, at job start, and there is no hook. The worker adds its own checks on
repository, directories, Git operations and limits, and a profile never grants more than the task's approved scope.

They do not stop (version one, D4): reading files of the same Windows user; use of saved credentials; network access of a
tool the profile allows; a local process speaking to the hub; writing to a release directory the user owns; a model
following injected instructions inside its allowed tools. A profile is a limit, not a wall. Closing this needs a separate
Windows user or a container, which is not planned for version one.

## Residual risks

| Risk | Decision | Status |
|---|---|---|
| Same-user compromise (steals keys, accepts its own task through a stolen token) | D4, D13 | accepted; untrusted repositories must not run |
| Forged results between machines (T26) | D28 | absent with one machine; the gateway is a condition of the second |
| Hub endpoints unauthenticated for the unmodified hub | D5 | fork fixes the Factory path only |
| Failure notices and buttons stop when the PC is off | D5, D6 | open until a second hub on a server |
| Decision recorded but not yet applied | D10 | by design; clients show the delivery state |
| Release directory writable by the same user | D11, D13 | detected at start, not prevented |
| Codex launcher survives a reboot looking alive | D3 | closed by the identity change; test T19 |
| Cleartext traffic until TLS exists | D6 | acceptable only on loopback; any other address takes TLS (T25) |
| A lost or stolen device holds a live session until it is revoked | D33 | the owner revokes it from the PC or another device; the secret is in the system key storage |
| Push through Google is an outside service | D33 | off until the owner orders it; Telegram and the open client deliver |
| Automatic acceptance | architecture, last section | off; turning it on is a dangerous operation |
| The question gate and the rights check fail open in an ordinary Claude session: a slow, down or unreachable registry leaves the usual prompt to the owner | G1 | by design; the owner is asked as today, and a press on that native prompt is the owner's own act, not a grant. A Factory run (`claude -p`) has no such prompt and is denied instead |
| A question in plain text at the end of a turn is not gated | G9 | stated limit; only the rule and the reflection check act |
| Codex has no permission hook: a record or grant cannot change what a running Codex job may do | D31 | stated limit; a record only chooses the sandbox at job start; a critical suspension closes it by killing the run by its identity |
| Until phase 4 there is no chief engineer: a request with no record shows the usual prompt | D31 | by design; the check and hook land in phase 2; the suspension gate and `POST /system/stop-all` exist from phase 2, and the critical reaction from phase 4 |
| The hook is installed at the PC by the owner; a session without it gets no rights check | D31 | stated limit; the usual prompt stays |

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
Telegram, the client and the command line all go through the same two calls, so no channel can skip the second step.
A second press in another channel is not accepted (call: the cheapest form that the owner chose, and no channel needs
the other to be reachable).

| Operation | Why |
|---|---|
| Merge into main, release, publication outside, a push that rewrites history (governance.md Rights) | outward and not undoable |
| ACCEPT of a task whose diff touches policy, hooks, rules or release code | changes the guard |
| Install, switch or roll back a Factory release | code that holds all credentials |
| Create, rotate or revoke an API token or certificate | changes who may decide |
| Add a device (a one-time code, made on the PC) | a new place that can press for the owner (D33) |
| Stop-all | ends every run and closes the rights in force; two presses, though it needs neither the client nor Temporal (D33) |
| Switch on a non-loopback bind of the API | reach from outside; refused until TLS is configured, then the owner's switch (D6, T25) |
| Raise a budget or limit; change a profile to a wider one | spend and reach |
| Change directory, repository or machine allowlists | scope |
| Turn on automatic acceptance | removes the owner |
| Restore a backup or run a migration | state loss |
| Delete a worktree with unpublished changes (cleanup `force`) | work loss |
| Allow network or push in a profile | reach |
| Activate or revoke a regulation version | changes what agents must do |
| REJECT, CANCEL and force-close of a task | closes a task for good (D7, D21, D23) |
| `personnel.mode` set to `enforce` | measures of levels 3 to 6 then take effect; a second press, and `calibration_missing` refuses it before calibration (D23, D32) |
| Appointing or removing the chief engineer, changing the replacement procedure | a second press; the procedure approved beforehand is the only way a replacement runs without the owner (D23, D32) |
| The owner's part of publications and deletions of data, with a record or a grant | the second press stays (G7, D23); the split is in governance.md Rights (G15), what it does not name is the owner's |

REJECT, CANCEL, force-close and the owner's part of publications and deletions always take two presses (D23). PAUSE takes one: it only stops new work and
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
