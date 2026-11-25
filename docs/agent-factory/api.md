# Agent Factory API

The HTTP API of Agent Factory, version 1, base path `/api/v1`. Binding: [architecture.md](architecture.md) and spec
section 12. Tables: [database.md](database.md).

## Principles

- JSON over HTTPS only. Times are RFC 3339 UTC. Ids are UUIDs. Unknown request fields are refused.
- A task mutation is *recorded*, never *applied*: decision, event and outbox row commit in one PostgreSQL
  transaction; `delivery_state` shows the delivery to Temporal.
- Roles: `owner`, `worker`, `relay`, `reader`, `registry`, `hub`; the client holds a device session, which the API reads as
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
| `GET/POST /projects/{id}/routing-rules`, `DELETE .../{rule}` | O R / O | Rule `match`, `preferred_agent_ids`, `position`. |

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
A `usage_limit` block notifies the owner only when no enabled agent of any provider can run. While the chief engineer is
unavailable the block waits and nobody is told (G13); the client lists the waiting blocks.

Publication of the owner's part (governance.md Rights: merge into main, release, publication outside, a history rewrite) is also a dangerous operation (D23): it uses the same second press through
`POST /tasks/{id}/publish`, which records a `confirmations` row and then the decision.

`GET /decisions/{id}` (O R) reads a decision with `delivery_state` and `refusal_reason`. Decisions are never changed or
deleted. A refused decision stays as history.

#### Second press (D23)

A dangerous operation (`cancel`, `reject`, `force-close`, the owner's part of publications and deletions (G15), loosening a policy, forcing a cleanup, activating
a regulation version, changing the chief engineer or the replacement procedure, switching `personnel.mode`) takes two
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
| `POST /hub/messages`, `POST /hub/polls`, `POST /hub/states` | H | The hub's second output: a session id, a kind, a key and the content. A repeat of the same `(session, key)` is answered with the stored row, so the record is made once. A poll made here has `arbiter = hub`. The hub reads no message and answers no poll through these three. |
| `POST /conversations/{id}/polls/{poll_id}/answer` | O D | `answer_key`, and `Idempotency-Key` (required, and the key of the request row). One arbiter per poll kind (below). For a poll with `arbiter = hub` (an ordinary session) the route only records the owner's request: it inserts a `poll_answer_requests` row and answers `202` with its state `pending`; it never decides and never answers `poll_closed` itself. The hub decides, so a press in Telegram works with the API down, and an answer that reaches the hub late is refused by the hub (the request becomes `refused`, `refusal_reason` `poll_closed`; the client reads it from `GET /conversations/{id}/polls/{poll_id}`). A retry with the same key is the same row. For a poll with `arbiter = api` (a Factory decision shown as a choice) the route is the decision route of the task with the same body (Decisions): the first answer, from any place, wins, and a later one is `409 poll_closed`. |
| `GET /conversations/{id}/polls/{poll_id}` | O R D | The poll with its state, `arbiter`, the answer and where it came from, and the device session's own answer requests with their state (`pending`, `accepted`, `refused` and the reason). |
| `GET /hub/poll-answers` | H | The answer requests of polls of `arbiter = hub`, filter `state` (default `pending`) and `cursor`. A row is marked delivered on its first return and is returned again until the hub has posted its result (at least once). The hub reads this at its start (the catch-up) and then at `hub.pollAnswerIntervalMs`. |
| `POST /hub/poll-answers/{id}/result` | H | `state` (`accepted` or `refused`), `refusal_reason` (required for `refused`), `hub_ref`. Sets the three result columns once, and on `accepted` the poll's answer columns in the same transaction. A repeat of the same result is answered with the stored row; a different result for a decided row is `409 request_closed`. The API never sets these columns from any other route. |
| `POST /hub/polls/{id}/result` | H | An answer the hub itself decided, a press in Telegram: `answer_key`, `answered_via` `telegram`. Sets the poll's answer columns once; a later report is `409 poll_closed`. Pending requests of the same poll are refused by the hub through the route above. |
| `GET /hub/polls` | H | Polls of `arbiter = api` that closed (answered by a decision in the client or by a relay press, or expired) and open polls of both arbiters, filter `state` and `cursor`. The hub closes the choice in Telegram from it, and reads it at its start (the catch-up), so a result is never lost while the hub is down. |
| `GET /events/stream` | O R D | Server-sent events over `task_events`, `audit_log`, `notifications` and conversation messages, one cursor per stream. `Last-Event-ID` carries the cursor of the stream of the event (a `cursor` query parameter per stream also works): the reader resumes after it and receives only rows older than the oldest running transaction, so nothing is missed or doubled (Events and pagination). A cursor that is not the stream's own, or is damaged, is `400 bad_cursor`. No secret and no raw agent log. A closed stream stops nothing. |
| `POST /system/stop-all` | O D | Ends every run and closes the rights in force: for every agent with a run or a grant it writes the same suspension as the critical reaction (`reason` `owner_stop`; the grants end with `ended_by = critical`, the run's tokens are revoked, a `stop_run` order kills each run by its `execution_id`), in one transaction with the audit row, so a right that a running process cannot lose (the Codex sandbox) dies with the process. Needs no Temporal, no client and no model: it is served by the API itself and by the control component and works from a button on the PC without the API (security.md). A dangerous operation (D23): two presses. Audited. |

Tool permission prompts of Claude Code and Codex are not served: no route here answers one, and a poll or message that
names a prompt of a third-party tool is shown as text. The set that is served (the choices of a Factory decision, the
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
| `POST /rights/check` | G W | The check of governance.md in its order: `action`, `target` (tool, program and arguments, real path, repository), `run_id` or `session_id`, `task_id`. Step 1 includes the suspension gate: an agent with an open `rights_suspensions` row is answered `refused` with the reason `suspended`, whatever its role, records and grants. Answers `200 {allowed, source}` with `source` one of `role`, `record` (the number), `grant` (its id) or, when `allowed` is false, `refused` (with the reason) or `none` (nothing found: the caller makes a request). Not an HTTP error. A `once` record is consumed (`consumed_at`) in the same transaction, only by a call that is allowed, never by a refused one. The worker uses it before it starts a run. The Claude permission hook of an ordinary session uses it with the `registry` token: `allowed` gives "allow", `refused` gives "deny" with the reason, `none` makes the hook send a request and wait for the answer, also while the chief engineer is away; the usual prompt appears only on `call_owner`, or when the registry itself is off or unreachable (G1), never a silent allow; a Factory run has no such prompt and is denied (governance.md, Ordinary sessions). |
| `POST /rights/requests` | G W | A right request: `run_id` or `session_id`, `action`, `target`, `reason`, `tried`. Writes the immutable request row with `handling_task_id` (the requesting task, or for an ordinary session the standing task, database.md Standing tasks). Code answers first (a `code` answer row: already in the role, owner's list, repeat of a refusal); the rest becomes a chief engineer run on the handling task (Claude, in Factory and in an ordinary session alike; the owner is asked last). 202 with the request id and its state; the hook reads the answer from `GET /rights/requests/{id}`; before the tool's own hook limit it answers "deny, request still waiting" and the agent asks again by the request number, no second request is made. The `registry` token requests only for its own run or session. |
| `GET /rights/requests`, `GET /rights/requests/{id}` | O R G | Requests with their answers in order (`step_kind` `code`, `chief_engineer`, `owner`; each `grant`, `refuse` or `call_owner`, with clause and reason); the state is the last row (open without a closing row, `call_owner` is open for the owner); `G` reads only its own. Filter `task_id`, `participant`, `state`. |
| `POST /rights/requests/{id}/answer` | O | The owner's answer to a `call_owner` request (also a request on the owner's list, G15): `grant` or `refuse`, written as a new `right_answers` row of `step_kind` `owner` (the `call_owner` row stays); a `grant` makes the `right_grants` row in the same transaction. Allowed only after a `call_owner` row (a request that has no closing row and no `call_owner` is `409 request_not_owner`), never in place of an unavailable chief engineer (the owner answers what was handed to the owner, never a request that merely waits); a closed request is `409 request_closed`. Never callable with `registry`. |
| `GET /rights/grants` | O R | The grant log, filters `task_id`, `participant`, `state` (`live`, `ended`, `revoked`, `critical`). Never part of `GET /registry/search`. |
| `POST /rights/grants/{id}/revoke` | O | Revokes a live grant at once (`ended_by = revocation`). Audited. |
| `GET /rights/suspensions`, `GET /rights/suspensions/{id}` | O R | The suspensions: agent, run, reason, the audit row, `state` (`open`, `restored`) and the restore. Filters `agent_id`, `state`. |
| `POST /rights/suspensions/{id}/restore` | O W (chief engineer's run) | A restore, with `restore_reason`. An act of the chief engineer's run, or of the owner when the suspended agent is the chief engineer; an agent never restores its own suspension, and no other token can (`403 forbidden`). Sets the restore columns once and writes `rights.restore` in the same transaction; a restored suspension is `409 request_closed`. It revives no grant: the ended grants stay ended. Audited. |

A grant belongs to one participant of one task, is found again for that participant's next attempt, and ends with the
task (in an ordinary session, with the session), by revocation, or by a critical event (`ended_by = critical`, written
with the suspension, below); a run ending does not end it. Role `registry` may call
`POST /rights/check` and make a request for its own run or session; it can never answer a request, grant, revoke,
restore, or give a role. A restore is by the chief engineer's own run with its own token role `worker` (a run of
`role = chief_engineer`), or by the owner for the chief engineer's suspension; the route checks both the run's role and
that it is not the suspended agent. Chief engineer answers, grants and role assignments are written by the Control Worker's service account
after the code check. While the chief engineer is unavailable, requests wait and the unavailability is not reported to the owner; the one
exception is a critical security or data-loss event from the list in code ([personnel.md](personnel.md) Hierarchy), which
notifies the owner whatever the hierarchy says.

**The critical reaction is not a route.** It is written by the control component from phase 4 in one transaction: the
suspension row (`rights_suspensions`), the end of the agent's open grants (`ended_by = critical`), the revocation of the
run's tokens, the audit row `rights.suspend` (`personnel.critical_reaction`), a `stop_run` order (the run is killed by
its `execution_id`, so a right a running process cannot lose, the Codex sandbox, dies with it) and the notice to the
owner. No token of an agent can write any of it. The incident record comes in phase 8 and is attached by
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
| `POST /personnel/measures` | service | The chief engineer's decision after the code check: refused `422 measure_invalid` without evidence, without the independent check from level 3 (a `qualification_reviews` row of the same incident, verdict `confirmed`, whose author is neither the accused nor the decision's author), with the accused as author or a limit without a term. In `observe` a level 3 to 6 stays `proposed`. A measure on the chief engineer is refused here (the owner's). |
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
| `confirmation_invalid` | 409 | A second press whose parameters, operation, channel, device session or time do not match the first, or that was used before. |
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
| `checksum_mismatch`, `payload_too_large` | 422, 413 | Upload checks. |
| `guard_conflict` | 409 | A draft record, regulation version or `permission` record conflicts with the list of guards in "Order of authority" ([governance.md](governance.md)); refused also for the owner. |
| `right_invalid` | 422 | A right (in a role or a `permission` record) that is not a valid structure: action, target and conditions against the schema, or free text. |
| `grant_refused` | 409 | A grant answer the code check refuses (no covering clause, on the owner's list, wider than the request, for the chief engineer's own run); the request becomes `call_owner`. |
| `request_closed` | 409 | An answer to a request already answered, a restore of a suspension already restored, a result for a poll answer request already decided differently, or a request for a task or session that has ended. |
| `request_not_owner` | 409 | An owner's answer to a right request that no `call_owner` row handed to the owner. |
| `block_handled` | 409 | A resolution of a block already resolved or already handed to the owner (an engineer's resolution after `call_owner`, or a second one). |
| `owner_only` | 422 | A chief engineer run's `resolve-block` that raises a cost, token or time budget or does a dangerous operation. |
| `permission_by_poll` | 409 | A `permission` record made from a poll press; it needs the owner's button. |
| `regulation_conflict`, `regulation_too_large` | 409, 422 | A version conflicts with an active clause or owner decision (the body lists them); a version over the clause-size setting. |
| `rule_needs_regulation` | 409 | A single activation of a `rule` record. |
| `protected_conduct` | 409 | An incident for an event that matches the list of protected conduct ([personnel.md](personnel.md)); nothing is recorded but an audit row. |
| `measure_invalid` | 422 | A measure without evidence, without the independent check from level 3, with the accused as author, a limit without a term, or on the chief engineer by the chief engineer. |
| `replacement_not_approved` | 409 | A replacement of the chief engineer without a procedure the owner approved; the owner decides. |
| `calibration_missing` | 409 | `personnel.mode` to `enforce` before the criteria have enough facts. |
| `registry_scope_required` | 422 | An inquiry or record without a project or `global` scope. |
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
measure ([personnel.md](personnel.md)). Even a worker token can never: record any decision, create, rotate or revoke a token,
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
