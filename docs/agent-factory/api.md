# Agent Factory API

The HTTP API of Agent Factory, version 1, base path `/api/v1`. Binding: [architecture.md](architecture.md) and spec
section 12. Tables: [database.md](database.md).

## Principles

- JSON over HTTPS only. Times are RFC 3339 UTC. Ids are UUIDs. Unknown request fields are refused.
- A task mutation is *recorded*, never *applied*: decision, event and outbox row commit in one PostgreSQL
  transaction; `delivery_state` shows the delivery to Temporal.
- Roles: `owner`, `worker`, `relay`, `reader`, `registry`; an agent process has no token except `registry`, bound to one
  session or run (see Registry). A Temporal outage never fails a mutation; a PostgreSQL outage does (`503`, nothing
  recorded). "Call" marks a design choice made here, open to veto.
- The relay is the Telegram client. It reads like a reader, acknowledges notices and submits a decision only with the
  hub's `press_id` and the Telegram user id, which `owners.telegram_user_id` must map to an owner; each `press_id` is
  accepted once. The decision's actor is that owner and its `channel` is `telegram`.

## Answers of a mutation

- `recorded` (202): committed; delivery pending. The body is the decision with `delivery_state` and a `Location` to
  `/decisions/{id}`.
- `applied` and `refused`: seen only by reading the decision; `refused` carries `refusal_reason` and notifies the owner.
  The reasons are `not_allowed_in_state`, `revision_stale`, `actor_not_allowed`, `already_resolved`,
  `block_kind_mismatch` and `task_closed`; they are refusals recorded by the workflow, never HTTP errors.
- Creates without a workflow decision (projects, agents, tokens, dependencies) answer 201 with the row; a task answers
  201 with `workflow_start: recorded|delivering|applied`.
- The API refuses at once, recording nothing, only what is a matter of form or of the request itself: validation,
  authentication, rights, a missing row, a duplicate `press_id`, a version conflict (`If-Match`), a cycle, a missing
  second press. A stale `revision_number`, a state that does not allow the operation, and a task already closed are not
  checked here: the decision is recorded (a refused one too) and the workflow refuses it with a reason (call: the
  journal then shows every press, and the API never decides from a state the workflow owns).

## Endpoints

Roles: O owner, W worker, L relay, R reader, G registry (L reads wherever R does, acknowledges notices, and submits
decisions as described above; G only where the Registry table says). Mutations need `Idempotency-Key`; a relay decision also carries `press_id` and `telegram_user_id`. Lists take `limit`, `cursor` and the filters named.

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
| `GET /tasks/{id}/events` | O R | Journal in `seq` order; filters `type`, `run_id`, `after_seq`. |
| `GET /tasks/{id}/artifacts` | O R W | Artifact rows (the worker only for its own runs); filters `type`, `run_id`. |
| `GET /tasks/{id}/reviews`, `/decisions` | O R | Verdicts and findings; decisions with `delivery_state`. |

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
| `resolve-block` | `block_kind`, `answer` or `resume_to` | `resolve_block`; refused `block_kind_mismatch` if the task is blocked for another reason than `block_kind`. |
| `force-close` | `reason` | `force_close`: closes a task whose machine is gone (D21). Second press (D23). |
| `allow-agent` | `agent_id` | `allow_agent`: adds an agent to the task's `allowedAgents` while it is ASSIGNED with no eligible agent. |

Publication of a branch or pull request is also a dangerous operation (D23): it uses the same second press through
`POST /tasks/{id}/publish`, which records a `confirmations` row and then the decision.

`GET /decisions/{id}` (O R) reads a decision with `delivery_state` and `refusal_reason`. Decisions are never changed or
deleted. A refused decision stays as history.

#### Second press (D23)

A dangerous operation (`cancel`, `reject`, `force-close`, publication, loosening a policy, forcing a cleanup, activating
a regulation version) takes two
presses in the same channel and by the same actor. The first request records a `confirmations` row (actor, channel,
operation, target, request hash) and answers `409 confirmation_required` with `confirmation_id`, a one-time `nonce`
and `expires_at` (`confirm.windowSeconds`). The second request repeats the same body with the header
`X-Confirm: <confirmation_id>.<nonce>`; it is accepted once, only for the same actor, channel, operation, target and
body hash, and its decision carries the `confirmation_id`. The Telegram client turns this into a second button press
and sends both presses with their press ids (call: the confirmation is the server's, so no channel can skip it).

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
| `GET /system/audit` | O | The audit log; filters `actor_id`, `action`, `target_id`, `after_seq`. |
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
| `rate_limited`, `unavailable`, `internal` | 429, 503, 500 | `Retry-After`; PostgreSQL or volume down, nothing recorded; unexpected. |
| `validation_failed` | 422 | Schema, enum, size or format. |
| `version_conflict` | 409 | `If-Match` does not match `row_version`. |
| `idempotency_conflict`, `idempotency_in_progress` | 409 | See Idempotency. |
| `dependency_cycle`, `depth_exceeded`, `project_active`, `task_active` | 409 | A fact of PostgreSQL forbids it. |
| `queue_isolation_required` | 409 | A second machine registers while no gateway binds certificates to queues (D28). |
| `checksum_mismatch`, `payload_too_large` | 422, 413 | Upload checks. |
| `guard_conflict` | 409 | A draft record or regulation version conflicts with the list of guards in code (governance.md G7); refused also for the owner. |
| `regulation_conflict`, `regulation_too_large` | 409, 422 | A version conflicts with an active clause or owner decision (the body lists them); a version over the clause-size setting. |
| `rule_needs_regulation` | 409 | A single activation of a `rule` record. |
| `registry_scope_required` | 422 | An inquiry or record without a project or `global` scope. |
| `contract_unsupported` | 426 | The worker's contract version is outside the supported range; the machine gets no work. |

`revision_stale` and `task_closed` are not HTTP errors: they are refusal reasons of a recorded decision (see Answers of a mutation).

## Pagination, filtering, request id, rate limit, audit

- **Pagination.** Keyset only: `limit` (default and maximum are settings) and an opaque `cursor`; the answer is
  `{items, next_cursor}`. The sort key ends in the row id, so no page skips or repeats a row. Events and audit follow
  `seq`. No offsets and no totals.
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
  constant time against `token_hash`. Only HTTPS is served; the panel's session cookie (owner login through the same
  tokens) is `HttpOnly`, `Secure`, `SameSite=Strict`, and a state-changing panel request also needs the idempotency key.
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
`registry`, bound to its session or run (search, inquiry, verdict, gate, draft; security.md T5); it can never activate,
revoke or supersede a record, change a regulation version, or record a press. Even a worker token can never: record any decision, create, rotate or revoke a token,
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
| Panel login: the owner pastes an owner token once and a cookie holds the session, or a separate password and a session table | Whether a phone login needs an account system | 6 |
| Rate-limit numbers (`rate.*`) | When a client of the owner is answered `429` | 7 (defaults in phase 2) |
