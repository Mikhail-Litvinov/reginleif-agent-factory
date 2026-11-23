# Agent Factory architecture

How Agent Factory is built. Facts about the existing Rig and the external tools are in [audit.md](audit.md).
Status: design, nothing is built. "Owner" marks a decision the owner made; "call" marks a design choice open to veto.

## Intent

Agent Factory keeps tasks, requirements, decisions and results, and runs them on several agents with Temporal, so that a
restart of the PC, the server, an agent or the network loses nothing. Agents do the work; the owner keeps requirements,
permissions, budget, publication and acceptance.

Anti-goals: ordinary Rig needs no PostgreSQL, Temporal, Node or background process; agents never accept their own
results; no second recovery scheduler next to Temporal; no success reported for a check that did not run.

## Decisions

| # | Decision | Source |
|---|---|---|
| D1 | Temporal workers run on Node 24; Rig stays on Bun. Temporal supports Workers on Node and discourages other runtimes. | Owner |
| D2 | Code lives in `factory/`, a separate package with its own dependencies and lockfile. Rig gets a thin feature, off by default. | Owner |
| D3 | A running agent survives a restart of the local worker. Claude runs through `rig exec`; Codex has its own detached supervisor. | Owner; the Codex part is a call |
| D4 | Agents on Windows are limited by permission profiles in the first version. This is a limit, not a wall (see security). | Owner |
| D5 | Telegram goes through the hub on the PC. Buttons, confirmations and menu commands become a generic hub mechanism in the owner's fork. A second hub on the server comes later. | Owner |
| D6 | No Linux server yet: the stack is built and tested in Docker on the PC first. | Owner |
| D7 | REJECT closes a task for good (state REJECTED). REQUEST_CHANGES returns it for rework. | Owner |
| D8 | PAUSE lets the current run finish and starts no next one. CANCEL stops at once. | Owner |
| D9 | Temporal runs the process; PostgreSQL holds application facts and decisions. | Task spec |
| D10 | An owner decision is committed to PostgreSQL first, then delivered to Temporal through the outbox. | Call |
| D11 | The worker runs from an installed release, never from the working tree. | Call, from spec 15.4 |
| D12 | One GPU queue per machine for ComfyUI, LM Studio and other heavy jobs. | Call |

Rejected: a separate repository (Rig updates and rolls back only itself and the hub); code in the Rig core (ordinary Rig
would pull Temporal and PostgreSQL); the worker's own child processes (an agent would die with the worker).

## Components

Server contour (Docker Compose; on the PC until a server exists):

- **PostgreSQL 16**, two databases with separate accounts: application and Temporal persistence. 16 is the newest major
  on the list of versions Temporal tests.
- **Temporal Server** and **admin-tools** for schema steps, pinned. The `auto-setup` image is deprecated and the official
  Compose samples are for development, so the configuration is our own. No Elasticsearch: SQL visibility is enough.
- **Temporal UI**, diagnostics only, not reachable from outside.
- **API** with the web panel: server-rendered pages and a small script, no frontend framework (call).
- **Control Worker**: task queue `control`; workflows, server activities, outbox relay.

Local contour (Windows first):

- **Local Agent Worker**: Node process, outgoing connections only, to Temporal and the API. No access to PostgreSQL.
- **Adapters**: Claude, Codex, OpenAI API, ComfyUI, LM Studio.
- **Telegram client**: connects to the hub's generic mechanism and to the API.

```
factory/
  contracts/   types, validation schemas, OpenAPI
  db/          schema, migrations
  workflows/   deterministic workflow code only
  control/     server activities, outbox relay
  api/         HTTP API and web panel
  worker/      local worker, workspaces, execution store
  adapters/    claude, codex, openai, comfyui, lmstudio
  telegram/    hub client
  deploy/      Compose, server configuration, backup and restore
  tests/
```

The root `bunfig.toml` and `tsconfig.json` do not include `factory/`; it has its own test and type-check commands, and
the Rig suite stays independent of it.

## What changes in Rig

1. `features/factory/feature.json`, disabled by default.
2. A `rig factory` command: install, start, stop, status, diagnose. A core change (command union, parser, usage,
   dispatch, messages in two languages, output fixture), because features cannot add commands.
3. A release installer: builds `~/.agent-rig/factory/releases/<commit>/` with its own `node_modules`, checks it, then
   switches a `current` pointer. The previous release stays. Rollback switches the pointer back.
4. Optional autostart on Windows (Scheduled Task at logon) and Linux (systemd user service). Off until set.
5. A versioned JSON interface for `codex-run.py`, and a switch that turns off its internal restarts.

The worker never holds `rig.lock`: a live owner is waited on without a deadline. Factory state stays out of `state.json`,
which drops unknown keys.

## State ownership

- One `TaskWorkflow` per task, workflow id `task-<task uuid>`. It is the only writer of task progress.
- The status in PostgreSQL is a projection written by `PersistTaskEvent`, with a row version for optimistic locking.
- A mutation through the API: one transaction writes the decision, the event and an outbox row under the caller's
  idempotency key (unique). The answer says *recorded*, never *applied*. The relay delivers it as a Temporal Update whose
  id is the outbox id; the workflow's validator accepts or refuses; the outcome is written back as `applied` or `refused`
  with a reason. Clients show the delivery state.
- Temporal removes duplicate Updates only within one workflow run. The workflow carries the ids it has handled through
  Continue-As-New, and the unique key in PostgreSQL covers everything before it.
- Creating a task starts its workflow the same way; a repeated start of the same id is a no-op.
- PostgreSQL down: the mutation fails and nothing is confirmed. Temporal down: decisions wait in the outbox.
- Payloads stay small (Temporal limits one payload to 2 MB): logs and results go to artifact storage, only keys travel.

## Task states

The spec's 13 states plus PAUSED and REJECTED. Any non-final state may go to CANCELLED.

| From | To | When |
|---|---|---|
| CREATED | PLANNING | workflow started |
| PLANNING | READY / BLOCKED | plan stays inside the approved scope / needs the owner |
| READY | WAITING_DEPENDENCIES / ASSIGNED | dependencies open / met |
| WAITING_DEPENDENCIES | ASSIGNED / BLOCKED | all met / one ended in a final state other than ACCEPTED |
| ASSIGNED | RUNNING | execution started; no machine available keeps it ASSIGNED and raises a notice |
| RUNNING | VERIFYING / BLOCKED / FAILED | result collected / state unclear, limit or agent question / non-retryable error |
| VERIFYING | AWAITING_APPROVAL / REWORK_REQUIRED / BLOCKED | checks and review pass / confirmed findings / rework limit reached |
| AWAITING_APPROVAL | ACCEPTED / REWORK_REQUIRED / REJECTED | owner's ACCEPT / REQUEST_CHANGES / REJECT |
| REWORK_REQUIRED | ASSIGNED | next attempt, earlier results kept |
| BLOCKED | the state it left | owner's decision |
| any active state | PAUSED and back | PAUSE takes effect when the current run ends; RESUME |

Final: ACCEPTED, REJECTED, CANCELLED, FAILED. A new requirements revision never edits an old one; a run keeps the
revision it started with. A revision made during a run is applied after that run ends, and approval is bound to a revision
number: a decision on an older revision is refused.

## Execution on the machine

Task queues: `machine-<id>` for ordinary activities, `machine-<id>-gpu` with one slot. The TypeScript SDK has no sessions,
so host affinity comes from the queue name, with a schedule-to-start timeout.

An execution is identified by `execution_id`, created on the server before the activity is scheduled. The worker keeps
`~/.agent-rig/factory/executions/<execution_id>/`: intent, launch id, output, exit, result.

1. `StartAgentExecution` writes the intent first. If the intent already exists it looks the execution up instead of
   starting: by the launch id, or, when the crash came before the id was written, by the execution id inside the recorded
   command text of `rig exec` runs. Found: attach. Intent present but nothing found, or the state is unclear: BLOCKED, never
   a second start.
2. `MonitorExecution` is long, heartbeats, and receives cancellation through the heartbeat. After a worker restart the
   retry attaches to the same execution.
3. `CollectResults` reads the worker's own execution folder. `rig exec` keeps only 50 runs for the whole machine, so its
   log is used for liveness and diagnosis, not as the result.

The wrapper around an agent enforces the run's time limit locally, so an agent without a server stops by itself. Without a
connection the worker starts nothing new and decides nothing that needs the server.

| Operation | Claude | Codex | OpenAI API | ComfyUI | LM Studio |
|---|---|---|---|---|---|
| start | `claude -p`, stream JSON, fixed session id, in `rig exec` | `codex-run.py start` | request | `POST /prompt` | `lms` or local API |
| attach | execution folder and `rig exec status` | job folder | not possible, see below | prompt id in queue or history | to be checked |
| cancel | `rig exec stop` | `codex-run.py cancel` | abort the request | job cancel | to be checked |
| resume | `--resume <session>` as a new attempt | `reply` | new attempt | new attempt | new attempt |

An OpenAI request lost in a crash may already be paid for, so it is not repeated silently: the attempt is recorded as
unclear and the retry counts against the budget.

Codex: the launcher restarts hung work up to three times and orphans a job after 30 minutes without a waiter. Both break
the rules "Temporal is the only recovery" and D3. Factory turns the restarts off and sets the orphan limit to the run's
time limit; a hung job is reported to the workflow.

GPU: one slot covers the job from start to end, so it is one activity (`RunGpuJob`), not a start and a monitor. After a
worker restart the generator's own queue is checked before any next job. Use of the card outside Factory cannot be
excluded; the job then waits or fails by its timeout.

## Workspaces

A Git worktree per execution that changes code, outside the owner's checkout. Stored per run: repository, base commit,
branch, path, commits, check results. One writer per worktree. After a crash the worktree and Git state are inspected
before any decision; no hard reset, no branch deletion. Cleanup is a separate activity that refuses a worktree with
unpublished changes. Rig's `project-tmp.sh` hook edits `.gitignore` and writes `.claude/settings.local.json` in the project:
these two must be told apart from the agent's changes when a result is collected.

## Errors and retries

| Class | Retry | On exhaustion |
|---|---|---|
| Database, network, API unavailable | backoff, bounded by schedule-to-close | BLOCKED and notice |
| Worker lost (heartbeat timeout) | same machine queue, attach first | BLOCKED |
| Agent failed, state clear | new attempt within the attempt limit | BLOCKED |
| Agent failed, state unclear | none | BLOCKED |
| Agent usage limit | wait for the reset time when it is known | BLOCKED |
| Validation, permission, budget, bad input | none | BLOCKED or FAILED |
| External effect (push, pull request, publication) | only after checking the target by idempotency key | BLOCKED |

Numbers (attempts, timeouts, budgets, depth) are settings with defaults set in the phase that measures them.

## Security

- Temporal authorizes nobody by default: the frontend needs mTLS with required client certificates and a private network
  before it leaves the PC. PostgreSQL and the UI are never published.
- API tokens are stored as hashes and carry a role: owner, worker, reader. An agent process gets no token that can decide.
- The hub's local endpoints have no authentication today. The new generic mechanism needs a per-client key; a button press
  is checked against the hub's allowed users and works once; dangerous actions need a second press.
- Profiles: Claude gets a permission mode, tool and directory lists; Codex its sandbox; the worker checks repository,
  directories, Git operations and limits itself. A process of the same Windows user can still read that user's files, so
  untrusted repositories must not run under D4.
- Secrets: Windows credential storage on the PC, files with restricted rights on the server; never in PostgreSQL, events,
  logs or Rig's `state.json`.
- Self-change: an agent works in a worktree; the running release is separate (D11); installing a release is an owner action.

## Migrations and rollback

Schema changes are expand, then contract: a release works with the schema of the release before and after it, and a
contracting step ships one release later. Rolling back code never needs a schema rollback. Temporal schema moves forward
only, one minor version at a time, after a backup. Workflow changes go through Worker Versioning and a replay test over
saved histories.

## Tests

- Unit: the transition table above is the test data; routing, dependency cycles, retry classes, authorization, idempotency.
- Workflow: Temporal's time-skipping test environment, no real waits; replay of saved histories.
- Integration: disposable PostgreSQL and Temporal in containers; fake agents as small programs, no paid models.
- Failure: the spec's 14 scenarios, each with its expected state. A real Windows restart cannot run inside a suite: its
  automated part kills the worker and every process of the run, and the restart itself is a separate recorded check.
- Rig regression: `bun test`, `bun run typecheck`, `rig check`, Docker scenarios, with the feature off and on.

## To prove before building on it

| # | Claim | Check |
|---|---|---|
| S1 | A Temporal Worker runs on Node 24 on Windows | worker runs a workflow and an activity against a server in Docker |
| S2 | An agent started through `rig exec` survives a kill of the worker and is found again | kill the worker, restart, same execution collected once |
| S3 | `claude -p` under a profile refuses what the profile forbids | attempts outside the directory and tool lists |
| S4 | The wrapper stops an agent at its limit with the worker gone | kill the worker, wait on an injected short limit |
| S5 | ComfyUI job can be found after a worker restart | restart between queueing and completion |

## Order of work

0. Audit, this document, contracts for data, API and security; proofs S1 to S5 (S3 spends a little of the Claude limit,
   S5 needs ComfyUI running).
1. Infrastructure in Docker on the PC, with restart and restore checks.
2. Database and API.
3. Workflows.
4. Local worker, Claude and Codex adapters, Rig feature.
5. Several agents, OpenAI, ComfyUI and LM Studio adapters, independent review.
6. Hub fork mechanism, Telegram client, web panel.
7. Limits, monitoring, backups, failure scenarios.

Open until a server exists: permanent operation, work while the PC is off, external TLS, backups outside the host.
Decided in their phase: how agents are paid for (subscription or API keys), log retention, default limits, automatic
acceptance (off unless the owner turns it on).
