# Agent Factory API

The HTTP API of Agent Factory, version 1, base path `/api/v1`. Binding: [architecture.md](architecture.md) and spec
section 12. Tables: [database.md](database.md).

## Principles

- JSON over HTTPS only. Times are RFC 3339 UTC. Ids are UUIDs. Unknown request fields are refused.
- A task mutation is *recorded*, never *applied*: decision, event and outbox row commit in one PostgreSQL
  transaction; `delivery_state` shows the delivery to Temporal.
- Roles: `owner`, `worker`, `reader`; an agent process has no token. A Temporal outage never fails a mutation; a
  PostgreSQL outage does (`503`, nothing recorded).

## Answers of a mutation

- `recorded` (202): committed; delivery pending. The body is the decision with `delivery_state` and a `Location` to
  `/decisions/{id}`.
- `applied` and `refused`: seen only by reading the decision; `refused` carries `refusal_reason` and notifies the owner.
- Creates without a workflow decision (projects, agents, tokens, dependencies) answer 201 with the row; a task answers
  201 with `workflow_start: recorded|delivering|applied`.
- The API refuses at once, recording nothing, only what PostgreSQL facts decide: validation, authentication, rights,
  a missing row, a stale `revision_number`, a final-state task, a version conflict, a cycle. The rest is the workflow's
  call (Open for the owner, 1).

## Endpoints

Roles: O owner, W worker, R reader. Mutations need `Idempotency-Key`. Lists take `limit`, `cursor` and the filters named.

### Projects and policy

| Method and path | Role | Body and answer |
|---|---|---|
| `GET /projects` | O R | Filters `archived`, `q`. List of projects. |
| `POST /projects` | O | `name`, `description`, `repository_url`, `default_branch`, `workspace_policy`, `settings`, `priority`. 201 project. |
| `GET /projects/{id}`, `PATCH` | O R / O | Project with its policy version; patch takes changed fields and `If-Match`. |
| `POST /projects/{id}/archive` | O | 200; `409 project_active` while a task is active. |
| `GET /projects/{id}/policy` | O R | Latest `execution_policies` version. |
| `PUT /projects/{id}/policy` | O | Full policy; creates a new version. Loosening security columns needs the header `X-Confirm: policy-change`, else `409 confirmation_required`. |
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

### Decisions (all 202 recorded, owner only)

Every body carries `revision_number` (the revision the owner saw) except pause and resume.

| Path (`POST /tasks/{id}/...`) | Extra body | Notes |
|---|---|---|
| `approve` | `comment` | ACCEPT. Refused later if the task is not in AWAITING_APPROVAL. |
| `reject` | `reason` | REJECT closes the task (D7). |
| `request-changes` | `findings`, `comment` | REQUEST_CHANGES returns the task for rework. |
| `cancel` | `reason` | CANCEL, at once (D8). |
| `pause`, `resume` | `reason` | PAUSE lets the run finish (D8). |
| `feedback` | `text` | add_feedback; no state change. |
| `priority` | `priority` | change_priority; affects work not yet started. |

`GET /decisions/{id}` (O R) reads a decision with `delivery_state` and `refusal_reason`. Decisions are never changed or deleted.

### Agents, workers, tokens, notifications

| Method and path | Role | Body and answer |
|---|---|---|
| `GET /agents`, `GET /agents/{id}` | O R | Filters `provider`, `enabled`. Capabilities, limits, usage. |
| `POST /agents`, `PATCH /agents/{id}`, `DELETE /agents/{id}` | O | Agent fields (no secret values; credential references only); `If-Match`; delete is soft. |
| `GET /workers`, `GET /workers/{id}` | O R | Filters `status`, `platform`. `outdated` shows the contract version. |
| `PATCH /workers/{id}` | O | `status: disabled|online`, `concurrency_limit`. |
| `POST /workers/register` | W | `machine_id`, `name`, `platform`, `capabilities`, `version`, `contract_version`. 200 with the worker id and the supported contract range. Repeating it is safe. |
| `POST /workers/{id}/heartbeat` | W | `capabilities` (changed only), run ids alive. 200 with server time and token expiry. Own id only. |
| `GET /tokens` | O | Prefix, role, bound worker, times; never the secret. |
| `POST /tokens` | O | `name`, `role`, `worker_id`, `expires_at`. 201 with the secret, shown once. |
| `POST /tokens/{id}/rotate`, `DELETE /tokens/{id}` | O | Rotate: 201 with the new secret, old valid until `valid_until`. Delete revokes at once. |
| `GET /notifications`, `POST /notifications/{id}/ack` | O R / O | Filters `state`, `event_type`; ack marks seen only. |

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
| `revision_stale`, `confirmation_required` | 409 | Older `revision_number`; a dangerous change without `X-Confirm`. |
| `rate_limited`, `unavailable`, `internal` | 429, 503, 500 | `Retry-After`; PostgreSQL or volume down, nothing recorded; unexpected. |
| `validation_failed` | 422 | Schema, enum, size or format. |
| `version_conflict` | 409 | `If-Match` does not match `row_version`. |
| `idempotency_conflict`, `idempotency_in_progress` | 409 | See Idempotency. |
| `dependency_cycle`, `depth_exceeded`, `project_active`, `task_active`, `task_closed` | 409 | A fact of PostgreSQL forbids it. |
| `checksum_mismatch`, `payload_too_large` | 422, 413 | Upload checks. |
| `contract_unsupported` | 426 | The worker's contract version is outside the supported range; the machine gets no work. |

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

An agent process receives no API token: only the worker and the owner's clients hold one, and the worker never passes
it into the agent's environment. Even a worker token can never: record any decision, create, rotate or revoke a token,
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

## Open for the owner

1. **Synchronous refusal.** The API refuses `revision_stale` and `task_closed` at once from PostgreSQL facts (this
   document), so nothing is recorded. Alternative: always record, and let the workflow refuse, so the journal shows every
   attempt. The first is clearer for the owner; the second keeps a full trail of refused presses.
2. **Panel login.** Options: the owner pastes an owner token once (a cookie then holds a session); a separate password
   and a session table. The first adds no account system; the second is friendlier on a phone.
3. **Rate limit numbers and the token overlap** are settings; the owner may want to set them at install time.
4. **Hub's role.** See Contradictions 2 in [database.md](database.md): how the Telegram client authenticates as the owner.

## Contradictions

1. The architecture sends results and logs "through the API" yet keeps the worker without database access and returns
   checks and verdicts as activity results; this document follows both (uploads through the API, structured results
   through Temporal), which leaves two paths that must agree on the run id and checksum.
