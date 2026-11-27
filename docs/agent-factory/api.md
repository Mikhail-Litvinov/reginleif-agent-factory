# Agent Factory API

The HTTP API of Agent Factory, version 1, base path `/api/v1`. Binding: [architecture.md](architecture.md) and spec
section 12. Tables: [database.md](database.md).

## Principles

- JSON over HTTPS only. Times are RFC 3339 UTC. Ids are UUIDs. Unknown request fields are refused.
- A task mutation is *recorded*, never *applied*: decision, event and outbox row commit in one PostgreSQL
  transaction; `delivery_state` shows the delivery to Temporal.
- Roles: `owner`, `worker`, `relay`, `reader`, `registry`, `hub`, `robot` (D34, column `B` of Robotics); the client holds a device session, which the API reads as
  the owner for the client routes (see Client). An agent process has no token except `registry`, bound to one
  session or run (see Registry). A Temporal outage never fails a mutation; a PostgreSQL outage does (`503`, nothing
  recorded). "Call" marks a design choice made here, open to veto.
- The relay is the Telegram client. It reads like a reader, acknowledges notices and submits a decision only with the
  hub's `press_id` and the Telegram user id, which `owners.telegram_user_id` must map to an owner; each `press_id` is
  accepted once. The decision's actor is that owner and its `channel` is `telegram`. A decision from the client has the
  channel `client` and its device session.

## Answers of a mutation

- `recorded` (202): committed; delivery pending. The body is the decision with `delivery_state` and a `Location` to
  `/decisions/{id}`.
- `applied` and `refused`: seen only by reading the decision; `refused` carries `refusal_reason` and notifies the owner.
  The reasons are `not_allowed_in_state`, `revision_stale`, `actor_not_allowed`, `already_resolved`,
  `block_kind_mismatch`, `block_handled` (a second resolution of a block that lost a race) and `task_closed`; they are
  refusals recorded by the workflow, never HTTP errors. The API refuses `block_handled` at once, as an HTTP error, only when
  its own read already shows the block resolved or handed over (below, Who handles a block).
- Creates without a workflow decision (projects, agents, tokens, dependencies) answer 201 with the row; a task answers
  201 with `workflow_start: recorded|delivering|applied`.
- The API refuses at once, recording nothing, only what is a matter of form or of the request itself: validation,
  authentication, rights, a missing row, a duplicate `press_id`, a version conflict (`If-Match`), a cycle, a missing
  second press. A stale `revision_number`, a state that does not allow the operation, and a task already closed are not
  checked here: the decision is recorded (a refused one too) and the workflow refuses it with a reason (call: the
  journal then shows every press, and the API never decides from a state the workflow owns).

## Endpoints

Roles: O owner, W worker, L relay, R reader, G registry (L reads wherever R does, acknowledges notices, and submits
decisions as described above; G only where the Registry table says). Mutations need `Idempotency-Key`; a relay decision also carries `press_id` and `telegram_user_id`. Lists take `limit`, `cursor` and the filters named; a
cursor is opaque (see Events and pagination).

### Projects and policy

| Method and path | Role | Body and answer |
|---|---|---|
| `GET /projects` | O R | Filters `archived`, `q`. List of projects. |
| `POST /projects` | O | `name`, `description`, `repository_url`, `default_branch`, `workspace_policy`, `settings`, `priority`. 201 project. |
| `GET /projects/{id}`, `PATCH` | O R / O | Project with its policy version; patch takes changed fields and `If-Match`. |
| `POST /projects/{id}/archive` | O | 200; `409 project_active` while a task is active. |
| `GET /projects/{id}/policy` | O R | Latest `execution_policies` version. |
| `PUT /projects/{id}/policy` | O | Full policy; creates a new version. Loosening security columns needs a second press (see Second press), else `409 confirmation_required`. |
| `GET/POST /projects/{id}/routing-rules`, `DELETE .../{rule}` | O R / O | Rule `match`, `preferred_agent_ids`, `position`. `DELETE` is the soft delete of database.md (D24): it sets `deleted_at`, answers 200 with the row, and a deleted rule is skipped by routing and hidden from the list unless the owner passes `include_deleted=true`. |

### Tasks

| Method and path | Role | Body and answer |
|---|---|---|
| `GET /tasks` | O R | Filters `project_id`, `status` (repeatable), `priority_gte`, `agent_id`, `parent_id`, `created_after`, `created_before`, `updated_after`, `awaiting_approval=true`, `q`; sort `created_at`, `updated_at` or `priority`, ascending or descending. |
| `POST /tasks` | O | `project_id`, `title`, `description`, `priority`, `requirements`, `acceptance_criteria`, `constraints`, `depends_on[]`. Creates the task, revision 1 and the start outbox row. 201. |
| `GET /tasks/{id}` | O R | Task, current revision, delivery state of pending decisions, dependencies. |
| `DELETE /tasks/{id}` | O | Soft delete; only a final state, else `409 task_active`. |
| `GET /tasks/{id}/revisions`, `.../{n}` | O R | Immutable revisions. |
| `POST /tasks/{id}/revisions` | O | `requirements`, `acceptance_criteria`, `constraints`, `change_reason` (required). Records a `revise_requirements` decision and the new revision row. 202. |
| `POST` or `DELETE /tasks/{id}/dependencies[/{dep}]` | O | `depends_on_task_id`, `dependency_type`. 201, or `409 dependency_cycle`; delete marks the edge removed. |
| `GET /tasks/{id}/runs` | O R | Runs with `role`, `status`; filters `status`, `role`. |
| `GET /tasks/{id}/events` | O R | Journal in cursor order (Events and pagination); filters `type`, `run_id`, `cursor`. |
| `GET /tasks/{id}/artifacts` | O R W | Artifact rows (the worker only for its own runs); filters `type`, `run_id`. |
| `GET /tasks/{id}/reviews`, `/decisions` | O R | Verdicts and findings; decisions with `delivery_state`. |

**The standing task.** Each project has one task with `origin_type = standing` (the project `_factory` holds the one for
sessions with no project), made with the project; it exists so that a chief engineer run for an ordinary session has a
task to belong to (database.md, Standing tasks). It is not listed by `GET /tasks` (unless `origin_type=standing` is
asked for), is never created by `POST /tasks`, takes no decision (a decision on it is `409 not_allowed_in_state`) and no
revision, is refused by `DELETE /tasks/{id}`, and does not count for `409 project_active` on `POST /projects/{id}/archive`.
Only `GET /tasks/{id}`, `/runs`, `/events` and `/artifacts` read it. No workflow runs for it.

### Decisions (all 202 recorded; owner, or relay with a press id)

Every body carries `revision_number` (the revision the owner saw) where the `task_decisions.kind` rule in
[database.md](database.md) requires it (`approve`, `reject`, `request-changes`, `resolve-block`; `revisions` names the
revision it builds on). The 12 kinds are exactly the rows below.

| Path (`POST /tasks/{id}/...`) | Extra body | Notes |
|---|---|---|
| `approve` | `comment` | `approve`. Refused (`not_allowed_in_state`) if the task is not in AWAITING_APPROVAL. |
| `reject` | `reason` | `reject` closes the task (D7). Second press (D23). |
| `request-changes` | `findings`, `comment` | `request_changes` returns the task for rework. |
| `cancel` | `reason` | `cancel`, at once (D8). Second press (D23). |
| `pause`, `resume` | `reason` | `pause` lets the run finish (D8). While paused only `resume`, `cancel`, `feedback` and `revisions` are allowed (D22). |
| `feedback` | `text` | `add_feedback`; no state change. |
| `priority` | `priority` | `change_priority`; affects work not yet started. |
| `revisions` | see Tasks | `revise_requirements`. |
| `resolve-block` | `block_kind`, `answer` or `resume_to` | `resolve_block`; refused `block_kind_mismatch` if the task is blocked for another reason than `block_kind`. Open to the owner for every block, and to a chief engineer run (role `worker`, a run of `role = chief_engineer`) only while `tasks.block_handler` is `chief_engineer` (see below). |
| `force-close` | `reason` | `force_close`: closes a task whose machine is gone (D21). Second press (D23). |
| `allow-agent` | `agent_id` | `allow_agent`: adds an agent to the task's `allowedAgents` while it is ASSIGNED with no eligible agent. |

**Who handles a block.** A task enters BLOCKED with `block_handler` (database.md, Block handler): `owner` for `scope` and
`agent_question`, and for a cause that needs the owner (requirements, scope, cost, a dangerous operation, an owner's own
credential such as a login); `chief_engineer` for the other kinds. While the handler is `chief_engineer` the owner is not
notified; the engineer's run answers with `resolve-block` (the same body, a row of `task_decisions` with
`engineer_run_id`, channel `api`, never a second press and never a dangerous operation or a cost raise: those are
refused `422 owner_only`), or with the engineer-only body `{"block_kind": ..., "choice": "call_owner", "reason": ...}`:
the status stays BLOCKED, `block_handler` becomes `owner`, and the owner is notified. The owner can resolve any block
whoever handles it. A second resolution of a block already resolved or already handed over is refused `409 block_handled`.
The chief engineer also has its own run for a routine physical decision (assign, release, admit, qualify, bookkeeping;
robotics.md): the service routes of the robot section take it as a `task_decisions` row of kind `physical_decision`
(`engineer_run_id` set, on the standing task or the physical task, no outbox), the same limits apply: its own run, the
owner's list of what it may not do, and `call_owner`.

A `usage_limit` block notifies the owner only when no enabled agent of any provider can run. While the chief engineer is
unavailable the block waits and nobody is told (G13); the client lists the waiting blocks.

Publication of the owner's part (governance.md Rights: merge into main, release, publication outside, a history rewrite) is also a dangerous operation (D23): it uses the same second press through
`POST /tasks/{id}/publish`, which records a `confirmations` row and then the decision.

`GET /decisions/{id}` (O R) reads a decision with `delivery_state` and `refusal_reason`. Decisions are never changed or
deleted. A refused decision stays as history.

#### Second press (D23)

A dangerous operation (`cancel`, `reject`, `force-close`, the owner's part of publications and deletions (G15), loosening a policy, forcing a cleanup, activating
a regulation version, changing the chief engineer or the replacement procedure, switching `personnel.mode`, the start of a robot task with people possibly in the zone or with nobody attending
(`robot_start`, one row with its `reasons`)) takes two
presses in the same channel and by the same actor. The first request records a `confirmations` row (actor, channel,
operation, target, request hash) and answers `409 confirmation_required` with `confirmation_id`, a one-time `nonce`
and `expires_at` (`confirm.windowSeconds`). The second request repeats the same body with the header
`X-Confirm: <confirmation_id>.<nonce>`; it is accepted once, only for the same actor, channel, operation, target and
body hash, and its decision carries the `confirmation_id`. The press is bound to the operation and its parameters by
that hash: a changed parameter, a used or expired confirmation, a revoked device session or another channel is refused
`confirmation_invalid`. The Telegram client turns this into a second button press and sends both presses with their press
ids; the client (D33) shows the same two steps and sends the second only on a live connection, never from an offline
queue (call: the confirmation is the server's, so no channel can skip it).

### Cleanup (D24)

| Method and path | Role | Body and answer |
|---|---|---|
| `POST /tasks/{id}/cleanup` | O | `dry_run` (default true) lists the logs, artifacts, execution folders and worktree it would remove and their size. With `dry_run=false` it records a `task_events` row and a `cleanup` outbox row (202). Refused: a task not final (`409 task_active`), an artifact of a task awaiting approval, a worktree with unpublished changes unless `force=true` with a second press. |

### Agents, workers, tokens, notifications

| Method and path | Role | Body and answer |
|---|---|---|
| `GET /agents`, `GET /agents/{id}` | O R | Filters `provider`, `enabled`. Capabilities, limits, usage. |
| `POST /agents`, `PATCH /agents/{id}`, `DELETE /agents/{id}` | O | Agent fields (no secret values; credential references only); `If-Match`; delete is soft. |
| `GET /workers`, `GET /workers/{id}` | O R | Filters `status`, `platform`. `outdated` shows the contract version. |
| `PATCH /workers/{id}` | O | `status: disabled\|online`, `concurrency_limit`. |
| `POST /workers/register` | W | `machine_id`, `name`, `platform`, `capabilities`, `version`, `contract_version`. 200 with the worker id and the supported contract range. Repeating it is safe. A machine beyond the first is refused `409 queue_isolation_required` until the deployment declares the queue gateway (D28). |
| `POST /workers/{id}/heartbeat` | W | `capabilities` (changed only), run ids alive. 200 with server time and token expiry. Own id only. |
| `GET /tokens` | O | Prefix, role, bound worker, times; never the secret. |
| `POST /tokens` | O | `name`, `role`, `worker_id`, `expires_at`. 201 with the secret, shown once. |
| `POST /tokens/{id}/rotate`, `DELETE /tokens/{id}` | O | Rotate: 201 with the new secret, old valid until `valid_until`. Delete revokes at once. |
| `GET /notifications`, `POST /notifications/{id}/ack` | O R / O | Filters `state`, `event_type`; ack marks seen only. |

### Client: devices, conversations, events

Design: [client.md](client.md) (D33); tables: [database.md](database.md). Paths are a call, open to veto. Role `D` is a
device session: the owner's rights on the routes of this section and of the owner routes above, except token management
and new devices (the owner token on the PC). Phase 2 serves the contracts; the hub's intake is used from phase 6.

| Method and path | Role | Body and answer |
|---|---|---|
| `POST /devices` | O | Start enrolling a device: `name`, `platform` (`android` or `windows`). 201 with the device id and a one-time code, shown once, valid for `device.codeTtlSeconds`. A dangerous operation (D23): two presses. Made on the PC, never by a device session. |
| `POST /devices/enroll` | none | `code`, `name` of the install. Spends the code once and answers 201 with a device session secret, shown once. A wrong, used or expired code is `401 unauthenticated`; failed tries use the bucket of failed authentication. |
| `GET /devices`, `GET /devices/{id}/sessions` | O D | Devices and their sessions (prefix, times, last use); never a secret. |
| `DELETE /devices/{id}`, `DELETE /device-sessions/{id}` | O D | Revoke a device (and its sessions) or one session, at once; a session may revoke itself. Audited. |
| `GET /conversations`, `GET /conversations/{id}` | O R D | All sessions of the Rig and Factory conversations, newest first; filters `source`, `project_id`, `task_id`, `archived`. |
| `GET /conversations/{id}/messages` | O R D | Parsed messages after `cursor` (the stream cursor of Events and pagination), each with `kind`, `parsed` fields, attachments, task. |
| `POST /conversations/{id}/messages` | O D | The owner's text and `attachment_ids`. Stored before it is answered; becomes an instruction to a task, a new task (the executor by routing unless named) or an answer; the answer says which (`task_id`). A text is never run as a command. |
| `POST /hub/messages`, `POST /hub/polls`, `POST /hub/states` | H | The hub's second output: a session id, a kind, a key and the content. A repeat of the same `(session, key)` is answered with the stored row, so the record is made once. A poll made here has `arbiter = hub`. The hub reads no message and answers no poll through these three. The hub writes each record to its own durable queue file before anything else, sends it in order per session, and removes it only on the API's acknowledgement; while the API is down the queue grows and is replayed afterwards (the key makes a repeat harmless). Telegram never waits for it. |
| `POST /conversations/{id}/polls/{poll_id}/answer` | O D | `answer_key`, and `Idempotency-Key` (required, and the key of the request row). One arbiter per poll kind (below). For a poll with `arbiter = hub` (an ordinary session) the route only records the owner's request: it inserts a `poll_answer_requests` row and answers `202` with its state `pending`; it never decides and never answers `poll_closed` itself. The hub decides, so a press in Telegram works with the API down, and an answer that reaches the hub late is refused by the hub (the request becomes `refused`, `refusal_reason` `poll_closed`; the client reads it from `GET /conversations/{id}/polls/{poll_id}`). A retry with the same key is the same row. For a poll with `arbiter = api` (a Factory decision shown as a choice) the route is the decision route of the task with the same body (Decisions): the first answer, from any place, wins, and a later one is `409 poll_closed`. |
| `GET /conversations/{id}/polls/{poll_id}` | O R D | The poll with its state, `arbiter`, the answer and where it came from, and the device session's own answer requests with their state (`pending`, `accepted`, `refused` and the reason). |
| `GET /hub/poll-answers` | H | The answer requests of polls of `arbiter = hub`, filter `state` (default `pending`) and `cursor`. A row is marked delivered on its first return and is returned again until the hub has posted its result (at least once). The hub reads this at its start (the catch-up) and then at `hub.pollAnswerIntervalMs`. |
| `POST /hub/poll-answers/{id}/result` | H | `state` (`accepted` or `refused`), `refusal_reason` (required for `refused`), `hub_ref`. Sets the three result columns once, and on `accepted` the poll's answer columns in the same transaction. A repeat of the same result is answered with the stored row; a different result for a decided row is `409 request_closed`. The API never sets these columns from any other route. |
| `POST /hub/polls/{id}/result` | H | An answer the hub itself decided, a press in Telegram: `answer_key`, `answered_via` `telegram`. Sets the poll's answer columns once; a later report is `409 poll_closed`. Pending requests of the same poll are refused by the hub through the route above. |
| `GET /hub/polls` | H | Polls of `arbiter = api` that closed (answered by a decision in the client or by a relay press, or expired) and open polls of both arbiters, filter `state` and `cursor`. The hub closes the choice in Telegram from it, and reads it at its start (the catch-up), so a result is never lost while the hub is down. |
| `GET /events/stream` | O R D | Server-sent events over `task_events`, `audit_log`, `notifications` and conversation messages, one cursor per stream. `Last-Event-ID` carries the cursor of the stream of the event (a `cursor` query parameter per stream also works): the reader resumes after it and receives only rows older than the oldest running transaction, so nothing is missed or doubled (Events and pagination). A cursor that is not the stream's own, or is damaged, is `400 bad_cursor`. No secret and no raw agent log. A closed stream stops nothing. |
| `POST /system/stop-all` | O D | Ends every run and closes the rights in force: for every agent with a run or a grant it writes the same suspension as the critical reaction (`reason` `owner_stop`; the grants end with `ended_by = critical`, the run's tokens are revoked, one `stop_run` order for each live run of the agent kills it by its `execution_id`), in one transaction with the audit row, so a right that a running process cannot lose (the Codex sandbox) dies with the process. Needs no Temporal, no client and no model: it is served by the API itself and by the control component and works from a button on the PC without the API (security.md). A dangerous operation (D23): two presses. Audited. |

Tool permission prompts of Claude Code and Codex are never displayed or answered in the client, and their text is not
sent to the API: the hub does not forward it. The API records only that a session waits for a permission answer, a
state of the session (`permission_wait`, no text, no tool arguments), and the client shows that state with "answer in
Telegram or at the terminal". No route here answers a prompt, and a message cannot become a prompt: text that merely
looks like one is ordinary text, shown without controls. The set that is served (the choices of a Factory decision, the
approvals of `confirmations`, the polls of a session) and the set that is not are listed in one place in the code, and a
test (`client-foreign-prompt`) holds the list. A device session never makes a token, changes a role, or gets the role of
an agent. A prompt of a third-party tool answered by the owner is the owner's own act in that tool, never a grant, a
record or an approval of the Factory; and a Factory run (`claude -p`) has no such prompt at all, it is denied
(governance.md, Ordinary sessions: stated there once).

**One arbiter per poll kind.** A poll of an ordinary session has `arbiter = hub`: only the hub decides it, and the client's
answer is a request row (`poll_answer_requests`: `pending`, then `accepted` or `refused` by the hub) that the client sends
with an idempotency key and repeats until the hub has confirmed. The API never decides such a poll, so Telegram works
with the API down and a late answer is refused by the hub. A Factory decision has `arbiter = api`: the API decides it in
the decision's transaction. The answer is durable in both kinds: written before it is delivered, delivered at least once,
applied once by its key. The hub learns the results of `api` polls from the same records, and reads them at its start.

### Registry and regulation

Design: [governance.md](governance.md); tables: [database.md](database.md). The registry is off by default (G1); when it
is off or unreachable, the routes answer `503 unavailable` and an agent asks as it does today. Ids are UUIDs; each record
also shows its number (`DEC-00042`), accepted in `GET /registry/records/{id}` as well. Paths are a call, open to veto.

| Method and path | Role | Body and answer |
|---|---|---|
| `POST /registry/inquiries` | G O | `problem`, `category`, `project_id`, `action`, `target`, `reuse_intent` (`standing` or `once`; undeclared is `once`). Searches, stores what was found with versions, answers 201 with the inquiry id and the found records. The `registry` token opens inquiries only for its own session or run. |
| `GET /registry/inquiries/{id}` | G O R | The inquiry, its results and verdicts. |
| `POST /registry/inquiries/{id}/verdicts` | G | One verdict per found record: `record_id`, `verdict` (`applies`, `not_applicable`, `outdated`, `conflict`), `difference` (required for all but `applies`), `conflicts_with` (a found record, for `conflict`). 201. Never changes a record. |
| `POST /registry/gate` | G | The check before a question (G9): `inquiry_id`, the real question text. Searches once more and answers `200 {pass}` or `200 {pass: false, records[]}` with the records that lack a verdict or have the verdict `applies`. It is a decision of the gate, not an HTTP error; after `registry.gateTimeoutMs` the caller lets the question pass. |
| `GET /registry/search` | G O R | Filters `project_id`, `category`, `kind`, `status`, `scope`, `q`; answers items with id, kind, authority, scope, matched fields, the ranking that found them, and `degraded` when the embedder is down. Lists take `limit` and `cursor`. |
| `GET /registry/records`, `GET /registry/records/{id}` | O R | Records with status, links and the history of status changes. Filters as in search plus `source`. |
| `POST /registry/records` | G O | A draft proposal: kind, scope, category, fields, the quotation, the evidence. An agent can only create a `draft` with authority `agent`; its summary and tags serve the search only. 201. |
| `GET /registry/drafts` | O R | The list of drafts waiting for the owner, with source; the owner confirms them as one list (call: batched, never a message each). |
| `POST /registry/records/{id}/activate` | O | Activation by the owner's button; also bulk, `ids[]`. A sensitive category, global scope or an ordinary message needs this. A `rule` is refused `409 rule_needs_regulation`: it becomes active only with its regulation version. Refused `409 guard_conflict` when the draft conflicts with the list of guards, and the answer names conflicting active records (`conflicts_with`). |
| `POST /registry/records/{id}/revoke`, `.../supersede` | O | Revoke, or create the draft that would supersede this one: the old record changes status only in the transaction that activates the draft. The old row and its link stay. |
| `POST /registry/polls` | L | Before the hub sends a poll: `inquiry_id`, `question`, `options` as shown. 201 with the poll id and the line of category, project and reuse to show. Immutable. On any failure or after `registry.gateTimeoutMs` the hub sends the poll unregistered. |
| `POST /registry/captures` | L | A poll press from the hub: `press_id`, `telegram_user_id`, `poll_id`, `option_index`. Checked as a relay decision (T10), then writes one record word for word from the registered poll; active only inside one project, a category of the harmless list that the server's own check does not contradict, and an offered option (G2, G8), else a draft. A replayed `press_id` is `409 press_replayed`; one poll gives one record. A record the inquiry called `outdated` is superseded in the same transaction when both are project decisions and not sensitive; otherwise, and after `conflict`, the answer is a draft naming the records. |
| `GET /regulation/versions`, `GET /regulation/versions/{id}` | O R G | Versions with clauses, status and the owner's confirmation; the active one is marked. A session start reads the active version number and its clauses (limited by the clause-size setting). |
| `POST /regulation/versions` | O G | A draft version (an agent's right ends here). Checked for conflicts with guards, clauses and active owner decisions; the answer lists them. 201. |
| `GET /regulation/versions/{id}/diff` | O R | The difference to the active version. |
| `POST /regulation/versions/{id}/activate` | O | A dangerous operation (D23): two presses, `409 confirmation_required` first. Refused `409 guard_conflict`, `409 regulation_conflict` or `422 regulation_too_large`. Audited. |
| `POST /regulation/versions/{id}/revoke` | O | Second press. Applies at once (G10). |

Role `registry`: search, open an inquiry, give a verdict, ask the gate, propose a draft or a draft version; nothing else.
It never activates, revokes or supersedes. A press is recorded only through the relay role. Orchestrator writes
(precedents, drafts) come from the Control Worker's service account and carry the run id.

### Roles and rights

Design: [governance.md](governance.md) Rights (G13 to G17); tables: [database.md](database.md). Paths are a call, open to
veto. A `permission` record is made and activated through the registry routes above (owner's button, never a poll
press); the routes below hold roles (read only: their contents are part of the regulation and change with it), the check,
requests and grants.

| Method and path | Role | Body and answer |
|---|---|---|
| `GET /roles`, `GET /roles/{id}` | O R | Roles of the active regulation version and their rights (action, target, conditions). A role is changed only with the regulation (`/regulation/versions` above). |
| `GET /tasks/{id}/participants` | O R | A task participant and its role, given by the chief engineer (G15). No route sets or changes a role. |
| `POST /rights/check` | G W | The check of governance.md in its order: `action`, `target` (tool, program and arguments, real path, repository), `run_id` or `session_id`, `task_id`. Step 1 includes the suspension gate: an agent with an open `rights_suspensions` row is answered `refused` with the reason `suspended`, whatever its role, records and grants. Answers `200 {allowed, source}` with `source` one of `role`, `record` (the number), `grant` (its id) or, when `allowed` is false, `refused` (with the reason) or `none` (nothing found: the caller makes a request). Not an HTTP error. A `once` record is consumed (`consumed_at`) in the same transaction, only by a call that is allowed, never by a refused one. It is at most once on purpose: an action that then fails or never starts does not give the permission back; the agent makes a new request, which says so. The worker uses it before it starts a run. A sandboxed run without a per-call hook gets a profile of role rights and of grants that are not single-use and not narrower than the sandbox can express (governance.md, the snapshot rule); an action that needs a `once` record or a narrower right is checked here by the worker or control component as a step of its own, when it is done. The Claude permission hook of an ordinary session uses it with the `registry` token: `allowed` gives "allow", `refused` gives "deny" with the reason, `none` makes the hook send a request and wait for the answer, also while the chief engineer is away; the usual prompt appears only on `call_owner`, or when the registry itself is off or unreachable (G1), never a silent allow; a Factory run has no such prompt and is denied (governance.md, Ordinary sessions). |
| `POST /rights/requests` | G W | A right request: `run_id` or `session_id`, `action`, `target`, `reason`, `tried`. Writes the immutable request row with `handling_task_id` (the requesting task, or for an ordinary session the standing task, database.md Standing tasks). Code answers first: a right that the role, a record or a live grant already gives is answered `200 {allowed, source}` as the check does and makes no request row; otherwise a `code` answer row (`call_owner` for the owner's list, `refuse` for a repeat of a refusal; the `call_owner` row is not final and the request is then on the owner's list); the rest becomes a chief engineer run on the handling task (Claude, in Factory and in an ordinary session alike; the owner is asked last). 202 with the request id and its state; the hook reads the answer from `GET /rights/requests/{id}`; before the tool's own hook limit it answers "deny, request still waiting" and the agent asks again by the request number, no second request is made. The `registry` token requests only for its own run or session. |
| `GET /rights/requests`, `GET /rights/requests/{id}` | O R G | Requests with their answers in order (`step_kind` `code`, `chief_engineer`, `owner`; each `grant`, `refuse` or `call_owner`, with clause (a chief engineer grant) or `owner_act_ref` (an owner grant) and reason); the state is the last row (open without a closing row, `call_owner` is open for the owner); `G` reads only its own. Filter `task_id`, `participant`, `state`. |
| `POST /rights/requests/{id}/answer` | O | The owner's answer to a `call_owner` request (also a request on the owner's list, G15): `grant` or `refuse`, written as a new `right_answers` row of `step_kind` `owner` (the `call_owner` row stays); a `grant` makes the `right_grants` row in the same transaction. The owner's grant stands on the owner's own act, so it needs no clause: the row records the press or confirmation (`owner_act_ref`; a body without one is `400`), which must be an unused `confirmations` row (the client or a relayed Telegram press) of an owner whose operation is this request and whose body hash covers its action, target and answer; it is spent in the same transaction, and any other is `409 confirmation_invalid`, whereas a grant of the chief engineer or of the code without a clause is refused. Allowed only after a `call_owner` row, of the chief engineer or of the code (a request that has no closing row and no `call_owner` is `409 request_not_owner`), never in place of an unavailable chief engineer (the owner answers what was handed to the owner, never a request that merely waits); a closed request is `409 request_closed`. Never callable with `registry`. |
| `GET /rights/grants` | O R | The grant log, filters `task_id`, `participant`, `state` (`live`, `ended`, `revoked`, `critical`). Never part of `GET /registry/search`. |
| `POST /rights/grants/{id}/revoke` | O | Revokes a live grant at once (`ended_by = revocation`). Audited. |
| `GET /rights/suspensions`, `GET /rights/suspensions/{id}` | O R | The suspensions: agent, run, reason, the audit row, `state` (`open`, `restored`) and the restore. Filters `agent_id`, `state`. |
| `POST /rights/suspensions/{id}/restore` | O W (chief engineer's run) | A restore, with `restore_reason`. An act of the chief engineer's run, or of the owner when the suspended agent is the chief engineer; an agent never restores its own suspension, and no other token can (`403 forbidden`). Sets the restore columns once and writes `rights.restore` in the same transaction; a restored suspension is `409 request_closed`. It revives no grant: the ended grants stay ended. Audited. |

A grant belongs to one participant of one task, is found again for that participant's next attempt, and ends with the
task (in an ordinary session, with the session), by revocation, or by a critical event (`ended_by = critical`, written
with the suspension, below); a run ending does not end it. When a grant ends, a permission record is revoked, a
regulation version replaces a right, or a role assignment ends, the same transaction writes a `stop_run` order for each
live run whose stored profile (`task_runs.profile_rights`) holds that right, and only those; the task goes on with a new
attempt and a fresh profile. Role `registry` may call
`POST /rights/check` and make a request for its own run or session; it can never answer a request, grant, revoke,
restore, or give a role. A restore is by the chief engineer's own run with its own token role `worker` (a run of
`role = chief_engineer`), or by the owner for the chief engineer's suspension; the route checks both the run's role and
that it is not the suspended agent. Chief engineer answers, grants and role assignments are written by the Control Worker's service account
after the code check. While the chief engineer is unavailable, requests wait and the unavailability is not reported to the owner; the one
exception is a critical security or data-loss event from the list in code ([personnel.md](personnel.md) Hierarchy), which
notifies the owner whatever the hierarchy says.

**The critical reaction is not a route.** It is written by the control component from phase 4 in one transaction: the
suspension row (`rights_suspensions`), the end of the agent's open grants (`ended_by = critical`), the revocation of the
run's tokens, the audit row `rights.suspend` (`personnel.critical_reaction`), one `stop_run` order for each live run of the
agent (all configurations of the same agent, not only the run of the event; each run is killed by its `execution_id`, so
a right a running process cannot lose, the Codex sandbox, dies with it) and the notice to the owner. No new run of the
agent starts until the restore. No token of an agent can write any of it. The incident record comes in phase 8 and is attached by
`incidents.suspension_id`; until then the audit row is the record. The owner's `POST /system/stop-all` writes the same
rows with the reason `owner_stop` for every agent with a run or a grant.

### Personnel

Design: [personnel.md](personnel.md) (D32); tables: [database.md](database.md). Paths are a call, open to veto. Reads
come in phase 5 (profiles and positions) and phase 8 (assessments, incidents, measures); every write below comes from
code or from the owner, never from an agent.

| Method and path | Role | Body and answer |
|---|---|---|
| `GET /personnel/positions`, `GET /personnel/positions/{id}` | O R | Positions with the current assignment and its history (`kind`, agent, configuration version, `started_at`, `ended_at`, the measure that ended it). |
| `GET /personnel/profiles`, `GET /personnel/profiles/{agent_id}` | O R | The profile as a read view: configuration versions, positions held, rights in force, facts by criterion with their sample sizes, "not enough data" where it applies. Filters `provider`, `position_id`, `version_id`. |
| `GET /personnel/assessments`, `.../{id}` | O R | Assessments with the six criteria, the category and the facts they read; filters `agent_id`, `position_id`, `after`. Never an edit route. |
| `GET /personnel/incidents`, `.../{id}` | O R | Incidents with class, event key, cause, the accused's explanation and the classifier's reasons; filters `agent_id`, `class`, `state`. |
| `GET /personnel/measures`, `.../{id}` | O R | Measures with level, clause, evidence, term, condition of restoring, author and `proposed` or `in_force`; filters `agent_id`, `level`, `state`. |
| `POST /personnel/incidents` | service | The classifier's incident from a fact or an event. Refused `409 protected_conduct` when the event matches the protected list (an audit row is written, no incident). The same event key is answered with the existing incident. A critical one carries `suspension_id` (the suspension the critical reaction already wrote; `incidents.suspension_id` is set once). The independent review of the classification is a `qualification_reviews` row of the same incident, verdict `confirmed`, by another author; it is attached once afterwards (`classified_by`), and a class or a verdict that leans on a missing, failed or foreign review is `422 measure_invalid`. The critical reaction does not wait for it. Written by the Control Worker's service account only. |
| `POST /personnel/measures` | service | The chief engineer's decision after the code check: refused `422 measure_invalid` without evidence, without the independent check at any level (a `qualification_reviews` row of the same incident, verdict `confirmed`, whose author is neither the accused nor the decision's author), with the accused as author or a limit without a term. In `observe` a level 3 to 6 stays `proposed`. A measure on the chief engineer is refused here (the owner's). |
| `POST /personnel/measures/{id}/restore` | service | Restoring after the cause is removed and an assessment passed; refused otherwise `422 measure_invalid`. |
| `POST /personnel/chief-engineer` | O | Appoint the chief engineer: `agent_id`. A dangerous operation (D23): two presses. Ends the previous assignment in the same transaction. |
| `DELETE /personnel/chief-engineer` | O | Remove the chief engineer; the work waits for the next appointment. Two presses. |
| `PUT /personnel/replacement-procedure` | O | Approve, replace or withdraw the procedure by which the chief engineer may be replaced without the owner (conditions, the candidate list, the term of unavailability). Two presses. Without one, a replacement waits for the owner (`409 replacement_not_approved`). |
| `PUT /personnel/mode` | O | `observe` or `enforce`. A dangerous operation (D23): two presses, audited; `enforce` is refused `409 calibration_missing` until an assessment with enough facts exists for the positions in use. |

The chief engineer's decisions (incident class, measure, restore, replacement under an approved procedure) are written by
the Control Worker's service account after the code check, as grants are (Roles and rights). Role `registry` and every
agent token read nothing here and write nothing: no route lets an agent change a fact, a profile, an assessment, an
incident or a measure, its own or another's. The critical reaction (stop the run, close its rights, notify the owner) is
not a route: it runs in the Control Worker from a list in code, in both modes, from phase 4, and writes the suspension and
an audit row (Roles and rights, above); the incident record of phase 8 is attached to it.

### Robotics (D34)

Design: [robotics.md](robotics.md); tables: [database.md](database.md), Robotics tables. Paths are a call, open to veto;
built when robotics starts, by the stages of robotics.md, Phases. Role `B` is a robot (below), never the client's device session `D`; that one reads the routes `O R` here and calls `stop`. **There is no
endpoint that moves a motor, sets a limit of the hardware, or reaches a pin, a driver or a relay**, and none can be added
through a setting: the server never drives a motor. A command reaches a robot only through the gateway as a command with
a `command_id`, a lease number, a configuration version, an expiry and preconditions, and the robot's runtime decides
whether to run it.

| Method and path | Role | Body and answer |
|---|---|---|
| `GET /robots`, `GET /robots/{id}` | O R | The registry: platform, zone, configuration version, state (`reserved`, `stopping`, `stopped`, `unknown`, `maintenance`, `quarantine`, ...), the assignment and the lease. The state is what the robot last confirmed, with its time (`confirmed_at`); a state older than its freshness setting is shown as `unknown`. |
| `POST /robots`, `PATCH /robots/{id}` | O | Register a platform or change its description. A change of hardware is a new configuration (below), never a patch. |
| `GET /robots/{id}/configurations`, `POST /robots/{id}/configurations` | O R / O | The configuration history; a new version (parts, firmware, controller and runtime versions, calibration). A new version suspends the qualifications bound to the old one and names `touches_stage` (the earliest stage the change touches, the chief engineer's `physical_decision`); the exits of older configurations stay as history, and only stages from `touches_stage` up lose their standing exit. |
| `GET /robots/{id}/state` | O R | Confirmed state, link and power, last safety events, last receipts. Telemetry and video are not served here (they stay in their own store). |
| `POST /robots/{id}/assignments`, `DELETE /robots/{id}/assignments/{aid}` | service, O | Assign a platform to an agent or end the assignment (reversible; a platform has no owner agent): the chief engineer's decision through the Control Worker's service account (its own run, a `physical_decision` row on the standing task or the physical task; the effect is written in the same transaction), the owner's when the owner makes it. A change of agent follows the handover below. |
| `GET /robots/{id}/leases` | O R | Leases with number, agent, task, term, end and reason. |
| `POST /robots/{id}/leases` | service | The Control Worker asks a controlling lease for a task after the five gates of robotics.md are checked on the server side (right, assignment, and exactly one gate-3 reference: `qualification_id` or `admission_id`; both or none is `422 qualification_invalid` or `422 admission_invalid`). An admission is consumed here (`used_at` set in the same transaction) and the lease is valid only for that one experiment and ends no later than the admission; a second lease on it is `422 admission_invalid`. The answer carries the signed lease package (lease number, gate-3 reference, limits, stage, zone, presence, largest command lifetime, expiry) that the robot keeps. `409 lease_held` when another is active; `409 lease_ending` when a lease is not `none` or `ended` (Table 1); `409 people_may_be_present` and `409 unattended_policy_missing` are the two independent reasons of robotics.md "People in the zone, and attendance", each answered by a start press, a valid policy, the interlock or a spent confirmation listing that reason (one row may list both; an unspent, unconfirmed or lacking one is `409 confirmation_invalid`). The lease insert consumes the admission, the start press and the confirmation (Table 2). The package carries `presence` and `attendance`. After issue the robot moves only as Table 1 says, which the server ends by stopping its answers to challenges. Watching needs no lease. |
| `DELETE /robots/{id}/leases/{number}` | service, O | End or revoke a lease: the event "End requested" of Table 1 (`active` to `ending`, unfetched commands recalled in the same transaction). A change of agent is: safe stop, handover, end and recall the old lease, check the new assignment. |
| `GET /robot-zones`, `PATCH /robot-zones/{id}` | O R / O | Zones with `access` (`fenced` with an interlock signal, or `open`), and the last interlock report with its time. A change of `access` or of the interlock signal is the owner's second press (`422 owner_only` for the service). A zone without a fence is stated as such: every start in it needs the owner's two-press confirmation. |
| `POST /robot-start-confirmations` | O | The owner's start of a task with people possibly in the zone, with no attendance, or both: the D23 two-press confirmation (operation `robot_start`, `reasons` a non-empty list of `people_possible` and `no_unattended_policy`, both in one row). The first request answers `409 confirmation_required`; the second carries `X-Confirm: <id>.<nonce>`. The rows and who writes them are Table 2 (Start confirmation). |
| `GET /unattended-policies`, `POST /unattended-policies` | O R / service | A policy bound to equipment, room and material, drafted by the chief engineer's run, a confirming `unattended_policy` review of an independent reviewer, versioned and expiring (`expires_at` required); `422 review_invalid` without the review or when its hash differs. |
| `POST /robots/{id}/stop` | O D service | A **request** to stop; 202 `recorded` with a request id. The platform goes to `stopping` and its lease ends with the recall of its unfetched commands in the same transaction. The answer is never "stopped": the stop is done by the robot's own circuit and runtime, and `GET /robots/{id}/state` shows `stopped` only after the robot confirmed it. The independent emergency stop does not depend on this route, Temporal, a model or the client. |
| `POST /robots/{id}/release` | service, O | Leave `stopped`, `unknown`, `maintenance` or `quarantine`. The state `unconfirmed` never rejects a release: it is the very state a release leaves. A release is refused only for a missing self check of this boot, a missing new hardware check or a missing new permission, or a pending re-enrolment (`409 release_requires_check`; Table 1). Every restart needs one, and after a lost memory the chief engineer's `reenrol` decision comes first. For `maintenance`, `stopped` and `unknown` it is the chief engineer's decision through the service account; `quarantine` and a change of safety limits are the owner's (`422 owner_only` for the service) and take two presses; a release never raises a limit. |
| `GET /robots/{id}/diagnostics`, `POST /robots/{id}/diagnostics` | O R / service | Read results; ask the motionless diagnostic of Table 1 (no lease, an incident epoch that the result echoes). Allowed in `stopped`, `unknown`, `maintenance` and `quarantine`, and it is the way out of `unknown` (observation never needs a confirmed state). It reads and never moves. |
| `POST /robot-start-presses` | O | A person's press at the start of a task (the client's start button): one `robot_start_presses` row bound to task, zone, equipment and expiry (`valid_until`), consumed by the lease insert (`used_at`). Only this row records that a person attends; a confirmation never does (robotics.md Table 2). |
| `GET /robot-skills`, `GET /robot-skills/{id}` | O R | Skills with state (`UNKNOWN` to `REVOKED`), their qualifications and evidence. |
| `POST /robot-skills/{id}/qualifications` | service | A qualification, a suspension or a revocation: refused `422 qualification_invalid` unless every identifier is named (platform, configuration, controller version, calibration, control software, agent model, zone, skill) and it lists evidence ids; an empty list is `422 evidence_missing`. The database checks each step as robotics.md Table 2 says (Qualification rows: `REVIEW_PENDING`, the review inserted `pending`, its reviewer run attached and its verdict, then the deciding `QUALIFIED` row); a review of another subject, set or hash or without a confirming verdict is `422 review_invalid`. Written by the Control Worker's service account after the code check, never by the agent that holds the skill. |
| `POST /robot-experiments/{id}/admissions` | service, O | An experiment admission for the first physical test of a skill that has no qualification (gate 3 of robotics.md): one row bound to one experiment, valid for the stage reached and the next, consumed at lease issue (one lease, one experiment run), limits below the qualified ones, run in the restricted mode. The Admission rows of Table 2 give the steps (the plan review final first, then the chief engineer's `admit` decision through the service account, which inserts the admission); a confirming plan review is the whole minimum and no evidence count is required. `422 review_invalid` for a missing, mismatching or non-independent review. `422 admission_invalid` for a second use, another experiment, a stage outside its term or a request for a right the experiment does not name. A change of the plan or the limits after the review voids it (a changed plan needs a new review and a new admission). |
| `GET /robots/{id}/maintenance`, `POST /robots/{id}/maintenance`, `GET /inventory` | O R / O, service | Repairs, calibrations, parts, inventory, purchases within a budget. A maintenance record puts the platform in `maintenance` (power isolated) until it is finished. |
| `GET /robot-experiments`, `.../{id}`, `GET /robot-evidence/{id}`, `GET /robot-stages` | O R | The development programme: hypotheses, experiments (with the identifiers and kind), evidence, its reviews, admissions and stage exits D0-D10, simulation and physical kept apart. A stage exit is written as the Stage exit rows of Table 2 (`REVIEW_PENDING`, then `STANDING`). A stage opens only on a confirmed `stage_exit` review of an independent reviewer that lists the stage's own evidence (the kind that stage needs, with the identifiers of the current configuration); D0 has no predecessor, every later stage needs the standing exit of the previous one (an exit of an older configuration stands for stages below `touches_stage` of the newer configuration). A skipped or self-confirmed exit, or an exit of an earlier stage that the configuration change touched, is `422 stage_exit_invalid`; an exit with no evidence or no review is `422 evidence_missing`. Never an edit route (immutable). |

**The robot (role `B`).** A robot's runtime or gateway has its own identity (certificate, minimal rights, revocable at
once; security.md). It may: report state, receipts and safety events, send telemetry artifacts, fetch commands addressed to
it, and acknowledge them. It can never: create or end a lease or an assignment, qualify a skill, change its own
configuration or limits record, read another robot's data, read a secret, start a task, or call any route above except its
own report routes (`POST /robots/{id}/reports`, `GET /robots/{id}/commands`, `POST /robots/{id}/challenges`). Its reports are data about a robot, never a
decision of the owner. `GET /robots/{id}/commands` returns only the commands of the robot's active lease that are
unfetched, unexpired and not recalled; never an expired, recalled or other-lease command. A report `rep(h)` may confirm the
end of a lease (`end_confirmed_at`), which is what lets the next lease be issued. The motion authority is robotics.md
Table 1: the robot sends a challenge (boot nonce, rising counter, lease number), the gateway answers an `active` lease once
per counter with a signature and sends `lease_end` when the lease ends; the robot's authority is counted on its own
monotonic clock from the issue of the challenge, never from receipt. A command or a report with a stale expiry, a repeated
sequence number or a used `command_id` is refused (`command_stale`, `command_replayed`).

**No agent token reaches these routes.** An agent holds only `registry`; a physical action is a task whose command the
Control Worker sends after the gates, never an agent's own call.

### Worker and artifact endpoints

The worker holds no database access: everything it leaves on the server goes here. All W endpoints check that the run
or worker belongs to the token's `worker_id`, else `403 forbidden`.

| Method and path | Body and answer |
|---|---|
| `POST /runs/{run_id}/artifacts` | `artifact_type`, `size`, `checksum`, `client_upload_id`, `metadata`. Creates a `pending` row and returns its id and an upload URL. The same `client_upload_id` returns the same row. |
| `PUT /artifacts/{id}/content` | Raw bytes, `Content-Length`, `Content-Range` for resume (HEAD returns the received size). The server checks size and checksum; a match sets `confirmed`; a mismatch is `422 checksum_mismatch` and the file is dropped. A confirmed artifact never changes. |
| `GET /artifacts/{id}/content` | O R, and W for its own runs. Streams the bytes; `ETag` is the checksum. |
| `POST /runs/{run_id}/proposals` | W. A child task proposal: `title`, `requirements`, `kind` (`decomposition` or `agent_proposal`). Origin and depth are set by the server from the run; a depth over the limit is `409 depth_exceeded`. 201. |

Checks, verdicts and run status reach PostgreSQL as activity results over Temporal; only large payloads use the upload.

### System

| Method and path | Role | Answer |
|---|---|---|
| `GET /system/health` | none | `{status}` only: the process is up. Never details. |
| `GET /system/ready` | O R | PostgreSQL, Temporal, outbox lag, oldest pending outbox row, artifact volume. |
| `GET /system/metrics` | O R | The metrics of spec 16 as text exposition: tasks per status, run duration, retries, agent errors, worker availability, delay from queueing to start, wait for acceptance, tokens and cost, PostgreSQL and Temporal state. Counts come from the projection, never from the workflow. Phase 7. |
| `GET /system/audit` | O | The audit log; filters `actor_id`, `action`, `target_id`, `cursor` (the audit stream's cursor, Pagination). |
| `GET /openapi.json` | none | The specification generated from the code (below). |

## Resource shapes

One definition of every body, so the handlers invent none. Notation: `field: type`; `?` after a name is an optional
field; `|null` is a nullable value; `ts` is an RFC 3339 UTC time; every `*_id` and `id` is a uuid; `json` is any JSON
value; `E(a|b)` is an enum. Unknown request fields are `422`. **A resource response is its [database.md](database.md)
table row with the same column names, minus the never-exposed columns** named under each entry; the entries below list
the columns once, and the route index after them points at the entries and never repeats a field.

### Shared shapes

- **Page**: `{items: T[], next_cursor: string|null}`, keyset (Pagination). `limit` and an opaque `cursor` are the
  only paging parameters. **StreamPage** is the same envelope for the five stream lists (`GET /tasks/{id}/events`,
  `GET /events/stream`, `GET /conversations/{id}/messages`, `GET /system/audit`, `GET /notifications`) whose cursor is
  the opaque form of `(commit_xid, seq)`; a cursor that does not decode is `400 bad_cursor`. Every other list is a Page.
- **Problem** (every 4xx and 5xx, `application/problem+json`, one definition): `{type: string, title: string,
  status: int, code: string, detail: string, request_id: uuid, errors: [{pointer, code, message}], retry_after?: number,
  current_row_version?: int}`. `code` is one of the Errors table for that status; `current_row_version` is present on
  `409 stale_version` and every other conflict on a versioned row. A response lists a failure by status and refers to
  this entry.
- **Created row**: a create answers `201` with the resource, plus `Location` of the new row. **Changed row**: `PATCH`,
  the state actions (`archive`, `activate`, `revoke`, `restore`, `ack`) and `PUT` of a versioned row answer `200`
  with the resource after the change. **Removed row**: `DELETE` answers `200` with the resource carrying its marker
  (`deleted_at`, `revoked_at`, `removed_at` or `ended_at`; for each route, the column the route's row says). A replay of
  an idempotent call answers the stored status and body with `Idempotent-Replay: true`.
- **Recorded decision** (202, `Location: /decisions/{id}`): `{id, kind, delivery_state: E(recorded|delivering|applied|refused),
  refusal_reason?: string|null}`; the full row of `GET /decisions/{id}` is **TaskDecision**.
- **Second press** (`409 confirmation_required`): Problem plus `confirmation_id: uuid, nonce: string, expires_at: ts`.
- **Secret answer** (token, device code, device session): the resource plus `secret: string`, shown once; a replay of
  the call is `409 token_already_issued` and carries no secret.
- **Empty body**: a route whose action takes no field (`archive`, `publish`, `ack`, `activate`, `revoke`, `restore`,
  every `DELETE`) takes no body; a body on it is `422`.

### Resources

Hidden columns are named in each entry; `commit_xid` is hidden on every stream row.

- **Project** (`projects`): `id, name, description, repository_url, default_branch, workspace_policy: E(worktree),
  settings: json, priority: int, created_at, updated_at, archived_at|null, deleted_at|null, row_version`. `GET
  /projects/{id}` adds `policy: ExecutionPolicy` (the latest version).
- **ExecutionPolicy** (`execution_policies`, immutable): `id, project_id|null, version: int, allowed_commands: string[],
  allowed_directories: string[], allowed_repositories: string[], network: json, git_operations: string[],
  confirmation_required: string[], allowed_tools: string[]`, the `max_*` limits (`max_concurrent_tasks,
  max_tasks_per_agent, max_run_seconds, max_tokens, max_cost: string (decimal) + currency, max_auto_fixes, max_attempts,
  max_rework_rounds, max_child_depth, max_children_per_task`), `auto_accept_low_risk: bool, created_by, created_at`.
  Writable (the `PUT` body is the whole policy): every column except `id, project_id, version, created_by, created_at`;
  the server sets those and answers `201` with the new version.
- **RoutingRule** (`routing_rules`): `id, project_id|null, position: int, match: json, preferred_agent_ids: uuid[],
  row_version, deleted_at|null`. Writable: `match, preferred_agent_ids, position`.
- **Task** (`tasks`): `id, project_id, parent_task_id|null, title, description, priority: int, status: E(the 16 states
  of the task state machine), current_revision: int, created_by, assigned_agent_id|null, workflow_id|null,
  workflow_run_id|null, block_kind|null, block_reason|null, block_handler|null, resume_to|null, pause_requested: bool,
  stopping: bool, end_unconfirmed: bool, origin_type, origin_task_id|null, origin_run_id|null, depth: int, created_at,
  updated_at, completed_at|null, deleted_at|null, row_version`. **TaskDetail** (`GET /tasks/{id}` and `POST /tasks`):
  Task plus `revision: TaskRevision` (the current one), `dependencies: TaskDependency[]` (not removed),
  `pending_decisions: Recorded decision[]` (delivery state of the decisions not yet `applied` or `refused`); `POST
  /tasks` adds `workflow_start: E(recorded|delivering|applied)`.
- **TaskRevision** (`task_revisions`): `id, task_id, revision_number: int, requirements: string, acceptance_criteria:
  [{id: string, ...json}], constraints: json, change_reason|null, author_id, decision_id|null, created_at`.
- **TaskDependency** (`task_dependencies`): `task_id, depends_on_task_id, dependency_type, created_at, removed_at|null,
  removed_by|null`.
- **TaskRun** (`task_runs`): `id, task_id, attempt_number, role, agent_id, worker_id|null, temporal_activity_id|null,
  execution_id|null, session_id|null, workspace_id|null, task_revision: int, policy_id, regulation_version_id,
  regulation_seen_id|null, contract_version, status, gpu_wait_since|null, started_at|null, heartbeat_at|null,
  finished_at|null, exit_code|null, error_code|null, error_message|null, result_summary|null, usage_metrics: json,
  participant, role_assignment_id|null, profile_rights: json, agent_version_id, created_at, row_version`.
- **TaskEvent** (`task_events`, stream): `id, seq: int, task_id, run_id|null, event_type, actor_type:
  E(owner|worker|workflow|system), actor_id|null, payload: json, correlation_id|null, dedupe_key|null, created_at`.
  `GET /events/stream` is the same row for every task.
- **TaskArtifact** (`task_artifacts`): `id, task_id, run_id|null, artifact_type: E(log|result|report|check_log|screenshot|file),
  storage_backend, storage_key, checksum, size: int, metadata: json, upload_state: E(pending|confirmed|removed),
  client_upload_id|null, created_at, confirmed_at|null, removed_at|null, removed_by|null`. The upload answer
  (`POST /runs/{run_id}/artifacts`, 201 or 200 on a repeat of `client_upload_id`) is the row plus `upload_url: string`.
- **TaskReview** (`task_reviews`): `id, task_id, run_id, reviewer_id, round: int, disputes_review_id|null, verdict:
  E(pass|fail|inconclusive), findings: json, created_at`, plus `outcomes: ReviewFindingOutcome[]` (`id, review_id,
  finding_key, outcome, run_id|null, reason|null, created_at`).
- **TaskDecision** (`task_decisions`): `id, task_id, kind, actor_id, engineer_run_id|null, channel: E(client|telegram|api),
  device_session_id|null, press_id|null, revision_number|null, payload: json, confirmation_id|null, delivery_state,
  refusal_reason|null, outbox_id|null, recorded_at, delivered_at|null, resolved_at|null`. Hidden: `request_hash,
  idempotency_key`.
- **TaskProposal** (`task_proposals`): `id, task_id, run_id, kind: E(decomposition|agent_proposal), title, requirements,
  covers: json, state, child_task_id|null, decided_by|null, created_at, decided_at|null`.
- **CleanupPlan** (`POST /tasks/{id}/cleanup`, `dry_run=true`, 200): `{dry_run: true, items: [{kind: E(log|artifact|execution_folder|worktree),
  ref: string, size: int|null}], total_size: int}`. `size` is `null` when the server cannot know it: execution folders and
  worktrees live on a worker machine and the server stores no size for them (only logs and artifacts have one);
  `total_size` sums the known sizes only. With `dry_run=false` the answer is Recorded decision-style `202
  {id, delivery_state}` of the cleanup request, with `Location`.
- **Agent** (`agents`): `id, name, provider, adapter_type, capabilities: json, enabled: bool, concurrency_limit: int,
  configuration: json (credential references only), created_at, updated_at, deleted_at|null, row_version`.
- **Worker** (`workers`): `id, machine_id, name, platform, capabilities: json, version, contract_version, last_seen_at|null,
  status: E(online|offline|outdated|disabled), concurrency_limit: int, created_at, updated_at, row_version`.
- **Token** (`api_tokens`): `id, name, role: E(owner|worker|relay|reader|registry|hub), owner_id|null, worker_id|null,
  session_ref|null, run_id|null, prefix, created_by, created_at, expires_at|null, last_used_at|null, revoked_at|null,
  replaces_token_id|null, valid_until|null, row_version`. Hidden: `token_hash`. Create and rotate add `secret`.
- **Notification** (`notifications`, stream): `id, seq, event_type, dedup_key, task_id|null, worker_id|null, state:
  E(open|resolved), occurrences: int, first_raised_at, last_raised_at, delivered_at|null, resolved_at|null`.
- **Device** (`devices`): `id, owner_id, name, platform: E(android|windows), code_expires_at, code_used_at|null,
  created_at, revoked_at|null`. Hidden: `code_hash`. `POST /devices` adds `code: string` (one-time).
- **DeviceSession** (`device_sessions`): `id, device_id, prefix, created_at, expires_at, last_used_at|null,
  revoked_at|null, row_version`. Hidden: `token_hash`. `POST /devices/enroll` adds `secret`.
- **Conversation** (`conversations`): `id, source: E(rig_session|factory), session_ref|null, project_id|null, task_id|null,
  state: E(active|waiting|permission_wait|ended), title, created_at, last_message_at|null, archived_at|null`.
- **Message** (`messages`, stream): `id, seq, conversation_id, source_key, kind: E(text|result|question|approval|blocker|status|owner),
  author: E(agent|owner|system), body: string, parsed: json|null, task_id|null, attachment_ids: uuid[],
  device_session_id|null, created_at`.
- **Poll** (`polls`): `id, conversation_id, message_id, source_key, options: [{key, label, recommended}], task_id|null,
  revision_number|null, decision_id|null, arbiter: E(hub|api), state: E(open|answered|expired), answer_key|null,
  answered_via|null, answered_session_id|null, answered_at|null, created_at`. `GET /conversations/{id}/polls/{poll_id}`
  adds `answer_requests: PollAnswerRequest[]` (the calling device session's own).
- **PollAnswerRequest** (`poll_answer_requests`): `id, poll_id, device_session_id, answer_key, state:
  E(pending|accepted|refused), refusal_reason|null, created_at, delivered_at|null, decided_at|null, hub_ref|null`.
  Hidden: `idempotency_key`.
- **Inquiry** (`registry_inquiries`): `id, number, session_ref|null, run_id|null, project_id|null, problem, category,
  action|null, target|null, reuse_intent: E(standing|once), regulation_version_id, poll_question|null, poll_options|null,
  poll_registered_at|null, created_at`, plus `results: InquiryResult[]` (`id, inquiry_id, record_id, record_version,
  found_by, ranking: int, score: number, matched_fields: string[], verdict|null, difference|null,
  conflicts_with_id|null, verdict_at|null`). Hidden: `token_id`.
- **RegistryRecord** (`registry_records`): `id, number, kind, authority, status, scope_type, project_id|null, repository|null,
  machine_id|null, action|null, target|null, category, problem, decision, exceptions_text|null, grounds|null,
  consequences|null, reuse|null, version: int, question|null, options|null, pressed_option|null, summary|null,
  tags: string[], evidence: json, source, source_ref|null, press_id|null, poll_option|null, inquiry_id|null, run_id|null,
  created_by, created_at, status_changed_at, status_changed_by|null, right|null, consumed_at|null`, plus
  `links: RegistryLink[]` (`id, from_record_id, to_record_id, link_type, created_by, created_at`) and `history`
  (the status changes, newest last). Hidden: `search_ru, search_en` and the embedding.
  **SearchHit**: `{record: RegistryRecord (id, kind, authority, scope_type, number), matched_fields: string[], ranking:
  int, score: number, degraded: bool}`; the search list is a Page of SearchHit.
- **RegulationVersion** (`regulation_versions`): `id, number, status, clauses: json, clauses_bytes: int, basis_version_id|null,
  proposed_by, conflict_report: json|null, confirmed_by|null, confirmation_id|null, created_at, activated_at|null,
  status_changed_at`. The list omits `clauses`. `GET .../diff` answers `{from_id, to_id, changes: [{clause_id, change:
  E(added|removed|changed), before: json|null, after: json|null}]}`.
- **Role** (`roles`): `id, name, version: int, status, rights: json, deny: json, regulation_version_id, created_at,
  status_changed_at`. **Participant** (`role_assignments`, `GET /tasks/{id}/participants`): `id, task_id, participant,
  role_id, assigned_by, created_at, superseded_at|null`.
- **RightRequest** (`right_requests`): `id, task_id, session_ref|null, run_id|null, participant, action, target,
  conditions: json|null, reason, tried, handling_task_id, created_at`, plus `state: E(open|call_owner|granted|refused)`
  derived from the last answer and `answers: RightAnswer[]` in order. Hidden: `request_hash`.
- **RightAnswer** (`right_answers`): `id, request_id, step: int, step_kind: E(code|chief_engineer|owner), answer:
  E(grant|refuse|call_owner), clause_id|null, owner_act_ref|null, reason|null, answered_by, answer_run_id|null,
  inquiry_id|null, created_at`.
- **RightGrant** (`right_grants`): `id, request_id, answer_id, task_id, session_ref|null, participant, role_assignment_id|null,
  right: json, clause_id|null, reason, granted_by_run_id|null, created_at, ended_at|null, ended_by|null, revoked_by|null,
  suspension_id|null`.
- **RightsSuspension** (`rights_suspensions`): `id, agent_id, run_id|null, task_id|null, session_ref|null, event_key, reason,
  audit_id, created_at, ended_at|null, restored_by|null, restore_reason|null, restore_audit_id|null`, plus
  `state: E(open|restored)`.
- **Position** (`positions`): `id, name, kind, parent_position_id|null, role_id, created_at, retired_at|null`, plus
  `assignment: PositionAssignment|null` (the current one) and `history: PositionAssignment[]`. **PositionAssignment**
  (`position_assignments`): `id, position_id, agent_id, agent_version_id, started_at, ended_at|null, end_reason|null,
  measure_id|null, decided_by`.
- **Profile** (`GET /personnel/profiles`): `{agent_id, versions: AgentVersion[], positions: Position[], rights: json,
  facts: [{criterion, count: int, values: PersonnelFact[]|null, enough_data: bool}]}`. **AgentVersion**
  (`agent_versions`): `id, agent_id, version, provider, adapter_type, model, instructions_hash, tools: json, created_at`.
  **PersonnelFact** (`personnel_facts`): `id, agent_id, agent_version_id, task_id|null, run_id|null, position_id|null,
  criterion, kind, value: json, difficulty|null, rights_ref|null, source_type, source_id, created_at`.
- **Assessment** (`assessments`): `id, agent_id, agent_version_id, position_id|null, period_start, period_end,
  weights: json, criteria: json, total: number, category, evaluator_provider, mode, created_at`.
- **Incident** (`incidents`): `id, agent_id, agent_version_id, task_id|null, run_id|null, event_key, class, clause_id|null,
  evidence: json, classified_by, agent_explanation_id|null, reaction|null, suspension_id|null, status, created_at,
  status_changed_at`. **Measure** (`measures`): `id, incident_id, agent_id, level: int, clause_id, evidence: json,
  circumstances, consequences, corrective_action_id|null, qualification_review_id|null, effect, term_until|null,
  restore_condition|null, decided_by, state: E(proposed|applied|ended), created_at, applied_at|null, ended_at|null`.
- **Audit entry** (`audit_log`, stream): `id, seq, actor_id|null, token_id|null, request_id, action, target_type,
  target_id|null, outcome, details: json, created_at, device_session_id|null`. Hidden: `request_hash`.
- **Readiness** (`GET /system/ready`): `{postgres, temporal, outbox_lag_seconds: number, oldest_pending_outbox_at: ts|null,
  artifact_volume: {used: int, free: int}}`, each of the first two `{ok: bool, detail: string}`.

### Requests

A request body is the writable columns of the table the route changes (server-set columns `id`, `created_*`,
`updated_*`, `row_version`, `*_by` of the caller, `seq`, state markers are never in a body). `PATCH` takes any subset of
the writable columns and `If-Match`. Required fields are the table's `not null` columns without a default.

- **ProjectCreate**: `name, description?, repository_url, default_branch?, workspace_policy?, settings?, priority?`.
  **ProjectPatch**: the same, all optional.
- **PolicyPut**: the writable columns of ExecutionPolicy (above); `If-Match` is the version number being replaced. A
  loosening answers `409 confirmation_required`, then repeats with `X-Confirm`.
- **RoutingRuleCreate**: `match, preferred_agent_ids, position`; `project_id` is the path.
- **TaskCreate**: `createTaskRequestSchema` (`project_id, title, description, priority, requirements, acceptance_criteria,
  constraints, depends_on`). **TaskRevisionCreate**: `taskRevisionRequestSchema` (`requirements, acceptance_criteria,
  constraints, change_reason, revision_number`, the revision the author read), answered by Recorded decision.
- **DependencyCreate**: `{depends_on_task_id: uuid, dependency_type}`; answers 201 with TaskDependency.
- **Decision kinds** (twelve routes of Decisions, each answered by Recorded decision), body per kind:
  `approve {revision_number, comment}`, `reject {revision_number, reason}`, `request_changes {revision_number,
  findings: json[], comment}`, `cancel|pause|resume|force_close {reason}`, `add_feedback {text}`, `change_priority
  {priority}`, `revise_requirements` the TaskRevisionCreate body, `allow_agent {agent_id}`, `resolve_block` one of
  `{block_kind, answer, revision_number}`, `{block_kind, resume_to, revision_number}` or `{block_kind, choice:
  "call_owner", reason}`. The physical decision is `{platform: string, decision: json}`. `POST /tasks/{id}/publish`
  takes no body and records the `confirmations` row first (second press), then the decision.
- **AgentCreate**: `name, provider, adapter_type, capabilities?, enabled?, concurrency_limit?, configuration?`;
  **AgentPatch** is the same, all optional.
- **WorkerPatch**: `{status?: E(disabled|online), concurrency_limit?: int}`.
- **WorkerRegister**: `{machine_id, name, platform, capabilities: json, version, contract_version}`; answers 200 `{worker_id,
  contract_range: {min: string, max: string}}`. **Heartbeat**: `{capabilities?: json (only when changed), run_ids: uuid[]}`;
  answers 200 `{server_time: ts, token_expires_at: ts|null}`.
- **TokenCreate**: `{name, role, worker_id?, expires_at?}` (and `owner_id`, `session_ref`, `run_id` where the role needs
  one); answers 201 Token plus `secret`. **Rotate** takes no body, answers 201 the new Token plus `secret`, the old one
  carrying `valid_until`.
- **ArtifactUpload**: `artifactUploadRequestSchema`. **ChildProposal**: `childTaskProposalRequestSchema`, answers 201 TaskProposal.
- **DeviceCreate**: `{name, platform}`; **Enroll**: `{code, name}`.
- **MessageCreate** (`POST /conversations/{id}/messages`): `{text: string, attachment_ids?: uuid[]}`; answers 201 `{message:
  Message, task_id: uuid|null}`.
- **HubItem** (`/hub/messages`, `/hub/polls`, `/hub/states`): `{session_ref: string, key: string, kind: string, content}`;
  the answer is the stored row, Message, Poll or Conversation in that route's order. `201` for a new key, `200` for a repeat.
  The shape of `content` is Open (below).
- **PollAnswer**: `{answer_key: string}` with `Idempotency-Key`; 202 PollAnswerRequest for `arbiter = hub`, or Recorded
  decision for `arbiter = api`. **PollAnswerResult** (`/hub/poll-answers/{id}/result`): `{state: E(accepted|refused),
  refusal_reason?: string (required when refused), hub_ref?: string}`; answers 200 PollAnswerRequest. **PollResult**
  (`/hub/polls/{id}/result`): `{answer_key, answered_via: "telegram"}`; answers 200 Poll.
- **InquiryCreate**: `{problem, category, project_id?, action?, target?, reuse_intent: E(standing|once)}`; answers 201 Inquiry.
  **Verdict**: `{record_id, verdict: E(applies|not_applicable|outdated|conflict), difference?: string (required unless
  `applies`), conflicts_with?: uuid}`; answers 201 InquiryResult. **Gate**: `{inquiry_id, question: string}`; answers 200
  `{pass: true}` or `{pass: false, records: RegistryRecord[]}`.
- **RecordCreate** (`POST /registry/records`, and the supersede draft): the draft columns of RegistryRecord `kind, scope_type,
  project_id?, repository?, machine_id?, action?, target?, category, problem, decision, exceptions_text?, grounds?,
  consequences?, reuse?, tags?, evidence?`; answers 201 RegistryRecord with `status = draft`. **Supersede** takes the same
  body and answers 201 the new draft linked `supersedes` to `{id}`. **Activate** takes no body, or `{ids?: uuid[]}` for the bulk
  form, and answers 200 `RegistryRecord[]` (the activated records); `409 guard_conflict` carries `conflicts_with: uuid[]`
  beside the Problem fields. **Revoke** takes no body and answers 200 RegistryRecord.
- **RegistryPoll**: `{inquiry_id, question, options: [{key, label, recommended?}]}`; answers 201 `{poll_id, display_line: string}`.
  **Capture**: `{press_id, telegram_user_id, poll_id, option_index: int}`; answers 200 RegistryRecord or the draft it made;
  `409 press_replayed` otherwise.
- **RegulationCreate**: `{clauses: json, basis_version_id?: uuid}`; answers 201 RegulationVersion with `conflict_report`.
  **Activate** and **Revoke** take no body (second press) and answer 200 RegulationVersion.
- **RightCheck**: `{action, target, run_id?, session_id?, task_id?}` (one of `run_id`, `session_id`); answers 200 `{allowed:
  bool, source: "role"|"record"|"grant"|"refused"|"none", ref?: string (record number or grant id), reason?: string}`.
  **RightRequestCreate**: `{run_id?, session_id?, action, target, reason, tried}`; answers 200 as RightCheck, or 202 `{id,
  state}`.
- **RightAnswerCreate**: `{answer: E(grant|refuse), owner_act_ref: uuid (a confirmations id; required for grant, `400`
  without), reason?: string}`; answers 201 RightAnswer (a grant adds `grant: RightGrant`). **GrantRevoke** takes no body and
  answers 200 RightGrant. **SuspensionRestore**: `{restore_reason: string}`; answers 200 RightsSuspension.
- **IncidentCreate** (service): `{agent_id, agent_version_id, task_id?, run_id?, event_key, class, clause_id?, evidence: json,
  suspension_id?}`; answers 201 Incident, or 200 the existing one for the same `event_key`. **MeasureCreate** (service):
  `{incident_id, level, clause_id, evidence, circumstances, consequences, corrective_action_id?, qualification_review_id?,
  effect, term_until?, restore_condition?}`; answers 201 Measure. **MeasureRestore** takes no body, answers 200 Measure.
- **ChiefEngineer** (`POST /personnel/chief-engineer`): `{agent_id}`; answers 201 PositionAssignment (the new one; the old one
  is ended in the same transaction). `DELETE` takes no body (second press) and answers 200 the ended PositionAssignment.
  **Mode**: `{mode: E(observe|enforce)}`; answers 200 `{mode}`.
- **ArtifactContent**: raw bytes; answers 200 `{id, upload_state, size}` or `422 checksum_mismatch`.
- **Audit** and **Conversation lists**: the filters of their routes; response StreamPage of Audit entry, StreamPage of Message
  (conversations list is a Page of Conversation).

### Route index

Every route of the table `openapi-questions` lists (request and response). `L` is a list.

| Route family | Request | Responses |
|---|---|---|
| Projects: `GET /projects` L, `POST`, `GET/PATCH /{id}`, `POST /{id}/archive` | ProjectCreate, ProjectPatch, none | Page of Project; 201, 200 Project; archive 200 Project or `409 project_active` |
| `GET/PUT /projects/{id}/policy` | PolicyPut | 200 ExecutionPolicy; PUT 201 ExecutionPolicy |
| Routing rules: `GET` L, `POST`, `DELETE .../{rule}` | RoutingRuleCreate | Page of RoutingRule; 201, 200 RoutingRule (with `deleted_at`) |
| Tasks: `GET /tasks` L, `POST`, `GET /{id}`, `DELETE /{id}` | TaskCreate | Page of Task; 201, 200 TaskDetail; delete 200 Task or `409 task_active` |
| `GET /tasks/{id}/revisions` L, `/{n}`; `POST .../revisions` | TaskRevisionCreate | Page of TaskRevision; 200 TaskRevision; POST Recorded decision |
| `POST/DELETE /tasks/{id}/dependencies[/{dep}]` | DependencyCreate | 201, 200 TaskDependency; `409 dependency_cycle` |
| `GET /tasks/{id}/runs`, `/events`, `/artifacts`, `/reviews`, `/decisions` | filters | Page of TaskRun, StreamPage of TaskEvent, Page of TaskArtifact, Page of TaskReview, Page of TaskDecision |
| `GET /decisions/{id}` | none | 200 TaskDecision |
| Decision routes (twelve), `POST /tasks/{id}/publish`, `.../physical-decisions` | Decision kinds | 202 Recorded decision |
| `POST /tasks/{id}/cleanup` | `dry_run?`, `force?` (query) | 200 CleanupPlan; 202 as there |
| Agents: `GET` L, `GET /{id}`, `POST`, `PATCH`, `DELETE` | AgentCreate, AgentPatch | Page of Agent; 200, 201, 200, delete 200 Agent (with `deleted_at`) |
| Workers: `GET` L, `GET /{id}`, `PATCH`, `POST /register`, `POST /{id}/heartbeat` | WorkerPatch, WorkerRegister, Heartbeat | Page of Worker; 200 Worker; register and heartbeat as there |
| Tokens: `GET` L, `POST`, `POST /{id}/rotate`, `DELETE /{id}` | TokenCreate | Page of Token; 201 Token plus secret; delete 200 Token with `revoked_at` |
| `GET /notifications`, `POST /notifications/{id}/ack` | filters, none | StreamPage of Notification; 200 Notification |
| `POST /runs/{run_id}/artifacts`, `PUT/GET /artifacts/{id}/content`, `POST /runs/{run_id}/proposals` | ArtifactUpload, bytes, ChildProposal | TaskArtifact plus `upload_url`; ArtifactContent; bytes; 201 TaskProposal |
| Devices: `POST /devices`, `POST /devices/enroll`, `GET /devices` L, `GET /devices/{id}/sessions` L, `DELETE /devices/{id}`, `DELETE /device-sessions/{id}` | DeviceCreate, Enroll | 201 Device plus code; 201 DeviceSession plus secret; Page of Device, Page of DeviceSession; delete 200 with `revoked_at` |
| Conversations: `GET` L, `GET /{id}`, `GET .../messages` L, `POST .../messages`, `GET .../polls/{poll_id}`, `POST .../answer` | MessageCreate, PollAnswer | Page of Conversation; 200 Conversation; StreamPage of Message; MessageCreate answer; 200 Poll; 202 as PollAnswer |
| Hub: `POST /hub/messages|polls|states`, `GET /hub/poll-answers` L, `POST /hub/poll-answers/{id}/result`, `POST /hub/polls/{id}/result`, `GET /hub/polls` L | HubItem, PollAnswerResult, PollResult | Message, Poll, Conversation; Page of PollAnswerRequest; 200 PollAnswerRequest; 200 Poll; Page of Poll |
| Registry: inquiries, verdicts, gate, search L, records L and `{id}`, `POST /records`, drafts L, activate, revoke, supersede, polls, captures | InquiryCreate, Verdict, Gate, RecordCreate, RegistryPoll, Capture | as under Requests; lists are Page of Inquiry, SearchHit, RegistryRecord |
| Regulation: versions L and `{id}`, `POST`, `/diff`, `/activate`, `/revoke` | RegulationCreate | Page of RegulationVersion; 200 and 201 RegulationVersion; diff as there |
| Roles: `GET /roles` L, `/{id}`, `GET /tasks/{id}/participants` | filters | Page of Role; 200 Role; Page of Participant |
| Rights: check, requests (`POST`, `GET` L, `GET /{id}`, `/answer`), grants L and `/revoke`, suspensions L, `/{id}`, `/restore` | RightCheck, RightRequestCreate, RightAnswerCreate, GrantRevoke, SuspensionRestore | as under Requests; Page of RightRequest, RightGrant, RightsSuspension |
| Personnel: positions, profiles, assessments, incidents, measures (all `GET` L and one), `POST` incidents, measures, restore, chief-engineer, `DELETE` chief-engineer, `PUT /personnel/mode` | IncidentCreate, MeasureCreate, ChiefEngineer, Mode | Page of Position, Profile, Assessment, Incident, Measure; 200 or 201 as under Requests |
| System: `GET /system/ready`, `GET /system/audit` | filters | 200 Readiness; StreamPage of Audit entry |

## Idempotency

- `Idempotency-Key` (8 to 128 characters of `A-Za-z0-9_-`) is required on every `POST`, `PUT`, `PATCH`, `DELETE` of an
  owner. Heartbeat and register are idempotent by nature and need none; uploads use `client_upload_id` and the checksum.
- The key is unique per actor. Decisions store it in `task_decisions`, other mutations in `idempotency_keys`, in the
  same transaction as the effect. The stored request hash covers method, path and body.
- Same key and same hash: the first answer is replayed (`Idempotent-Replay: true`) with the current delivery state. Same
  key and another hash: `409 idempotency_conflict`. Same key while the first request is still open:
  `409 idempotency_in_progress` with `Retry-After`. A secret is never replayed: a repeated token creation answers
  `token_already_issued`.

## Errors

Every error is `application/problem+json` with `type`, `title`, `status`, `code`, `detail`, `request_id`, `errors[]`
(`pointer`, `code`, `message`), `retry_after` and, on a conflict, `current_row_version`. No secret, stack or path.

| Code | HTTP | When |
|---|---|---|
| `unauthenticated`, `forbidden` | 401, 403 | No, expired or revoked token; the role or bound machine does not allow it. |
| `not_found` | 404 | No row, or a soft-deleted one. |
| `confirmation_required` | 409 | A dangerous operation without a valid second press; the body carries the new `confirmation_id`, `nonce` and `expires_at`. |
| `press_replayed` | 409 | A relay `press_id` already used. |
| `confirmation_invalid` | 409 | A second press whose parameters, operation, channel, device session or time do not match the first, or that was used before; for a robot start also a row that is unconfirmed, expired, consumed, bound to another task, zone or equipment, or that lacks a reason the start has (robotics.md Table 2). |
| `poll_closed` | 409 | An answer to a poll already answered (from any place) or expired: for an `api` poll (a Factory decision) the API refuses it, for a `hub` poll the hub refuses it and the request row becomes `refused`; the body names where and when. |
| `bad_cursor` | 400 | A cursor that is not valid, belongs to another stream, or is older than the retained rows. |
| `device_code_invalid` | 401 | A one-time code that is wrong, used or expired (the body does not tell which). |
| `device_revoked` | 401 | A request with the session of a revoked device or session; the client clears its key storage. |
| `device_not_allowed` | 403 | A device session on a route it never has: tokens, devices, roles. |
| `rate_limited`, `unavailable`, `internal` | 429, 503, 500 | `Retry-After`; PostgreSQL or volume down, nothing recorded; unexpected. |
| `validation_failed` | 422 | Schema, enum, size or format. |
| `version_conflict` | 409 | `If-Match` does not match `row_version`. |
| `idempotency_conflict`, `idempotency_in_progress` | 409 | See Idempotency. |
| `dependency_cycle`, `depth_exceeded`, `project_active`, `task_active` | 409 | A fact of PostgreSQL forbids it. |
| `queue_isolation_required` | 409 | A second machine registers while no gateway binds certificates to queues (D28). |
| `machine_mismatch`, `machine_conflict` | 409 | A worker registers a `machine_id` other than the one it is bound to; or registers one that another worker already holds. |
| `checksum_mismatch`, `payload_too_large` | 422, 413 | Upload checks. |
| `guard_conflict` | 409 | A draft record, regulation version or `permission` record conflicts with the list of guards in "Order of authority" ([governance.md](governance.md)); refused also for the owner. |
| `right_invalid` | 422 | A right (in a role or a `permission` record) that is not a valid structure: action, target and conditions against the schema, or free text. |
| `grant_refused` | 409 | A grant answer the code check refuses (no covering clause, on the owner's list, wider than the request, for the chief engineer's own run); the code records `refuse` with the failed check, and the owner is not called (only a request on the owner's list is `call_owner` by the code). The owner's own grant is not checked for a clause. |
| `request_closed` | 409 | An answer to a request already answered, a restore of a suspension already restored, a result for a poll answer request already decided differently, or a request for a task or session that has ended. |
| `request_not_owner` | 409 | An owner's answer to a right request that no `call_owner` row (of the chief engineer or of the code) handed to the owner. |
| `block_handled` | 409 | A resolution of a block already resolved or already handed to the owner (an engineer's resolution after `call_owner`, or a second one). |
| `owner_only` | 422 | A chief engineer run's `resolve-block` that raises a cost, token or time budget or does a dangerous operation, or its release of a robot from `quarantine` or change of a safety limit. |
| `permission_by_poll` | 409 | A `permission` record made from a poll press; it needs the owner's button. |
| `regulation_conflict`, `regulation_too_large` | 409, 422 | A version conflicts with an active clause or owner decision (the body lists them); a version over the clause-size setting. |
| `rule_needs_regulation` | 409 | A single activation of a `rule` record. |
| `protected_conduct` | 409 | An incident for an event that matches the list of protected conduct ([personnel.md](personnel.md)); nothing is recorded but an audit row. |
| `measure_invalid` | 422 | A measure without evidence, without the independent check (any level, 1 and 2 included), with the accused as author, a limit without a term, or on the chief engineer by the chief engineer. |
| `replacement_not_approved` | 409 | A replacement of the chief engineer without a procedure the owner approved; the owner decides. |
| `calibration_missing` | 409 | `personnel.mode` to `enforce` before the criteria have enough facts. |
| `registry_scope_required` | 422 | An inquiry or record without a project or `global` scope. |
| `lease_held` | 409 | A controlling lease for a platform that already has an active one; the body names its number and holder. |
| `lease_ending` | 409 | A new lease while a lease is not `none` or `ended` in robotics.md Table 1 (not confirmed ended by `rep(h)` and `now` before the bound `B`). Retried by the task's own schedule, never forced. |
| `people_may_be_present` | 409 | A lease, or a command in motion, with people possibly in the zone (reason `people_possible`) and no spent confirmation listing that reason; the runtime refuses the same way. |
| `unattended_policy_missing` | 409 | A start with no start press, no valid `unattended_policies` row and no spent confirmation listing `no_unattended_policy`; it goes to the owner's two-press confirmation. |
| `heartbeat_stale` | 409 | A challenge answer the gateway refuses (Table 1): the lease is not `active`, the counter is not above the last answered, or the nonce or lease number does not match. The robot's own refusal of a late, replayed or unsigned answer is local and has no route; its authority just runs out. |
| `lease_replayed` | 409 | A lease package from before the runtime's restart (another boot nonce) or with a lease number not above the highest the runtime ever accepted; the runtime refuses it. A robot with lost persistent memory refuses every lease (`reenrol_required`) until the chief engineer's recorded re-enrolment. |
| `qualification_invalid` | 422 | A qualification missing an identifier; evidence that is not physical (except `SIMULATION_VALIDATED`), has other identifiers than the qualification; a lease or command naming both a qualification and an admission, or neither; or one bound to another configuration, controller version, calibration, agent model, zone or skill than the request names. |
| `evidence_missing` | 422 | A qualification, a stage exit or an admission with zero evidence or zero reviews, or a stage exit that lists no evidence of its own stage's kind. |
| `review_invalid` | 422 | A review of another subject, set, plan or stage than the act names, with a hash that differs from the reviewed content, without a confirming verdict, or by the executor's run or provider. |
| `admission_invalid` | 422 | An experiment admission used twice (it is consumed at lease issue), for another experiment, outside the stage reached and the next, expired, with the plan or limits changed after the review, or asking a right the experiment does not name; also a lease or command that names it for another experiment run. |
| `stage_exit_invalid` | 422 | A stage opened without a confirmed exit of an independent reviewer, with a self-confirmed or skipped exit, with no standing exit of its predecessor (D0 has none), or after a configuration change that reopened it. |
| `release_requires_check` | 409 | A release without a new hardware check or a new permission. |
| `robot_state_unconfirmed` | 409 | A moving operation (a lease, a command) while the platform is `unknown`, `stopped`, `maintenance` or `quarantine`, or its state is older than the freshness setting. Never a release, a diagnostic or an observation. |
| `command_stale`, `command_replayed` | 409 | A command or report with an expired time, an old sequence number, a lease that has ended, or a `command_id` already used; nothing runs and an audit row is written. |
| `contract_unsupported` | 426 | The worker's contract version is outside the supported range; the machine gets no work. |

`revision_stale` and `task_closed` are not HTTP errors: they are refusal reasons of a recorded decision (see Answers of a mutation).

## Pagination, filtering, request id, rate limit, audit

- **Pagination.** Keyset only: `limit` (default and maximum are settings) and an opaque `cursor`; the answer is
  `{items, next_cursor}`. The sort key ends in the row id, so no page skips or repeats a row. No offsets and no totals.
- **Events and pagination (the one cursor rule).** The stream tables (`task_events`, `audit_log`, `notifications`,
  `messages`) are read in the order `(commit_xid, seq)` and only rows whose `commit_xid` is below the oldest running
  transaction (`pg_snapshot_xmin(pg_current_snapshot())`). A row with a lower `seq` that commits late therefore is never
  skipped by a reader that has already passed its `seq`. One cursor per stream, opaque to the client (it names its stream
  and carries the last `(commit_xid, seq)`); the client stores and returns it, never builds or compares it. A bad, foreign
  or expired cursor is `400 bad_cursor`. It applies to `GET /tasks/{id}/events`, `GET /events/stream` (`Last-Event-ID`),
  `GET /conversations/{id}/messages`, `GET /system/audit` and the notification list, and to nothing else: the other lists
  use the keyset above. Stated also in database.md, Conventions.
- **Filtering.** Only the named parameters; an unknown one is `422`. Repeatable parameters mean "any of". Soft-deleted
  rows are hidden unless `include_deleted=true` (owner).
- **Request id.** `X-Request-Id` (a UUID) is accepted or generated, returned in the header and every error, stored as
  `correlation_id` and in the audit log, and in every log line.
- **Rate limit.** A token bucket per token in memory of the single API process, a lower bucket for failed
  authentication per source address, and a separate bucket for heartbeats and uploads so they never starve decisions.
  Numbers are settings. Answers carry `RateLimit-Limit`, `-Remaining`, `-Reset`.
- **Audit.** Every mutation, and every denied or failed one, writes an `audit_log` row in the same transaction (actor,
  token id, request id, route, target, outcome, request hash; never the body). Token, policy, agent, project and worker
  changes are the administrative ones, read from `/system/audit`.

## Authentication and token rotation

- `Authorization: Bearer afk_<prefix>_<secret>`. The server looks up the prefix and compares the sha-256 of the secret in
  constant time against `token_hash`. Cleartext is served on loopback only; every other address takes TLS, with the PC's own certificate pinned by the device (client.md). The client sends its device session the same way
  (`afk_` secret of `device_sessions`, looked up and compared as here). The API sets no cookie and serves no browser
  session, so there are no cookies and no CSRF tokens; every mutation needs the idempotency key. Outside the
  home network nothing is served until the owner switches it on (D6, security.md T25).
- A worker token is bound to one `worker_id` and cannot be used for another machine. A token has an `expires_at`.
- Rotation: the owner calls `rotate`; the old token stays valid until `valid_until` (the overlap is a setting); the
  worker stores the new secret in the credential store of its machine and uses it on the next call; the heartbeat answer
  carries the expiry so an unrotated token is noticed before it fails. Revocation is immediate. Using a revoked token is
  an audit row and a notice.
- Temporal access is separate (mTLS; the worker may not start workflows or send Updates).
- `X-Factory-Contract` on worker calls carries the contract version; the current and the previous are supported.

## Endpoints an agent can never call

An agent process receives no API token of the roles owner, worker, relay or reader: only the worker and the owner's
clients hold those, and the worker never passes them into the agent's environment. The one token an agent may hold is
`registry`, bound to its session or run (search, inquiry, verdict, gate, draft, the rights check and a right request for
its own run; security.md T5); it can never activate, revoke or supersede a record, change a regulation version or a
role, answer a request, grant or revoke, write or restore a suspension, post a poll result or a result of a poll answer
request (those are the `hub` token's alone), record a press, or write or read a fact, profile draft, assessment, incident or
measure ([personnel.md](personnel.md)), and it reaches no robot route (Robotics): no stop, lease, assignment, command,
qualification or limit. Even a worker token can never: record any decision, create, rotate or revoke a token,
write a project, agent, policy or routing rule, create a task other than through `proposals` of a run it owns, change
a confirmed artifact, read another machine's runs, or read the audit log. Acceptance needs an owner actor in code and
in the database. Residual risk (D13): a same-user process could read the worker's credentials.

## OpenAPI from the code

`factory/contracts/` holds one route table: per route its method, path, role, request and response schemas, error
codes, idempotency requirement and filters. The API registers handlers and validates requests (and, in tests, responses)
from that table; a route outside the table cannot be mounted, and a table entry without a handler fails startup.
`openapi.json` is generated from the table by a build script, committed and served. A test regenerates it and fails on
any difference; another calls every route and checks the live response against its schema; the worker's client is
generated from the same table. No library is named here; no part of the specification is written by hand.

## Two result paths

Large payloads (logs, artifacts) go through the API; structured results (checks, verdicts, run status) go through
Temporal as activity results. Both name the same run id and checksum, and a test checks that they agree.

## Open, decided in its phase

| Question | What it changes for the owner | Phase |
|---|---|---|
| Rate-limit numbers (`rate.*`) | When a client of the owner is answered `429` | 7 (defaults in phase 2) |

## Open shapes

Bodies the documents do not fix, so a handler package does not invent them. Each row names the route, what is fixed, and
why the rest is open. A row closes when the named owner (the table or the stage) fixes the columns, and the shape then
goes into Resource shapes. Until then the handler answers the fixed part and the route is not in the generated
specification beyond its status codes and the Problem body.

| Routes | Fixed already | Open, and why |
|---|---|---|
| `GET /robots`, `GET /robots/{id}`, `POST /robots`, `PATCH /robots/{id}`, `GET /robots/{id}/state` | roles and the second-press rule where the route table names them | The `robots` columns are working names, settled when the robotics stage starts (database.md); a response is the row, so neither the row nor the writable columns exist yet. `state` has no field list in any document. |
| `GET`/`POST /robots/{id}/configurations`, `POST /robots/{id}/assignments`, `DELETE /robots/{id}/assignments/{aid}`, `PATCH /robot-zones/{id}`, `GET /robot-zones` | the route names and their roles | The tables `robot_configurations`, `robot_assignments`, `robot_zones` are working names with no settled columns. |
| `GET /robots/{id}/leases`, `POST /robots/{id}/leases`, `DELETE /robots/{id}/leases/{number}` | `POST` is service-only, takes exactly one gate-3 reference (`qualification_id` or `admission_id`), answers the signed lease package; refusals `409 lease_held`, `409 lease_ending`, `409 people_may_be_present`, `409 unattended_policy_missing`, `422 qualification_invalid`, `422 admission_invalid` | The lease row, the signed package's fields and the `DELETE` body are not written anywhere; `robot_leases` is a working name. |
| `POST /robot-start-confirmations`, `POST /robot-start-presses`, `GET`/`POST /unattended-policies` | the operation `robot_start`, `reasons` non-empty of `people_possible` or `no_unattended_policy`, the `confirmations` columns (`task_id`, `zone_id`, `robot_id`, `reasons`, `valid_until`) | The answer of a start press and the policy columns are not given; `robot_start_presses` and `unattended_policies` are working names. |
| `POST /robots/{id}/stop`, `POST /robots/{id}/release` | stop answers `202` `recorded` with a request id; release refuses `409 release_requires_check` | The request body of both (reason, scope) and the `release` answer are not given. |
| `GET`/`POST /robots/{id}/diagnostics`, `GET`/`POST /robots/{id}/maintenance`, `GET /inventory` | the route names | `robot_maintenance` is a working name; the diagnostics record and the inventory have no table. |
| `GET /robot-skills`, `GET /robot-skills/{id}`, `POST /robot-skills/{id}/qualifications`, `POST /robot-experiments/{id}/admissions`, `GET /robot-experiments`, `GET /robot-experiments/{id}`, `GET /robot-evidence/{id}`, `GET /robot-stages` | a qualification carries identifiers plus evidence ids and is refused `422 evidence_missing`; an admission is made on an experiment | Every row is a working-name table; the identifier names, the evidence fields and the list rows are not fixed. |
| `POST /robots/{id}/reports`, `GET /robots/{id}/commands`, `POST /robots/{id}/challenges` | the role B, the routes' purpose | The report, command and challenge fields belong to `robot_commands`, `robot_receipts` and `robot_safety_events`, working names with unsettled columns; the signed forms are defined with the robot channel. |
| `POST /system/stop-all` | the owner's call, audited with the same row as a suspension (Roles and rights) | No request or answer field is written, and neither a scope nor a result list. |
| `PUT /personnel/replacement-procedure` | owner, two presses; conditions, the candidate list, the term of unavailability; `409 replacement_not_approved` when none | Field names and the storage of the procedure are not given by the personnel tables; the answer is then the stored procedure. |
| `content` of `POST /hub/messages`, `/hub/polls`, `/hub/states` | the envelope `session_ref`, `key`, `kind` and the answered row | The hub is outside this repository; the field names of a message body, a poll's options and a state object are fixed by the hub's contract, not by the Factory documents. The columns `messages` and `polls` define the row, not the hub's wire form. |
