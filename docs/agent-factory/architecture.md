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
| D13 | Under D4 an agent could steal a key from the owner's Windows profile and accept its own task. The risk is accepted for the first version. | Owner |
| D14 | A requirements change stops the running agent at once; a new attempt starts with the new revision. | Owner |
| D15 | A dependency that ends without acceptance puts the waiting task into BLOCKED until the owner decides. | Owner |
| D16 | An agent that surely died is continued by a new attempt within the attempt limit and budget. An unclear state never starts a second run: a read-only inspection settles it, and only what it cannot settle goes to the owner. | Owner (retry); the inspection follows D18 and spec 8E |
| D17 | Server code (API, Control Worker), the local worker and their tests all run on Node 24. Factory installation checks for Node and does not install it. | Call |
| D18 | Agents settle technical contradictions themselves. The owner gets only results, real blockers, and decisions that need them: requirements, scope, cost, loss, publication, permissions, acceptance. | Owner |
| D19 | Child tasks inside the approved requirements start by themselves within limits of depth, number and the parent's budget. Anything outside the requirements is a proposal to the owner. | Owner |
| D20 | A result is reviewed by another provider. When its usage limit is spent, the task waits for the reset and the owner is notified. | Owner |
| D21 | A cancel whose machine is gone waits with a notice; the owner may force-close it. | Owner |
| D22 | While paused: resume, cancel, feedback and revision only. | Owner |
| D23 | Cancel, reject, publication and force-close take a second press in the same channel, in Telegram and in the panel. | Owner |
| D24 | Nothing is deleted by itself. Cleanup on command removes logs, artifacts and worktrees; the history of decisions and events stays for good. | Owner |
| D25 | A review finding the implementer accepts is fixed. A disputed technical one is settled by a third independent run; a dispute about requirements, scope or cost goes to the owner. | Call from D18 |
| D26 | A mandatory check that could not run is first repaired by agents; if that fails, the task is BLOCKED with the reason. It never counts as passed. | Call from D18 |
| D27 | Drizzle (as the task spec recommends; Rig has no database code to reuse) defines the schema and types; its generated SQL migrations are reviewed, committed, completed by hand where Drizzle cannot express a rule, and applied forward only. | Call, from spec 4 |

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
  runner/      program that rig exec starts around one agent run
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
  id is the outbox id. The validator checks only the form (it cannot run activities); the handler checks the decision and
  the outcome is written back as `applied` or `refused` with a reason. Every press is recorded, refused ones included.
  Clients show the delivery state.
- Temporal removes duplicate Updates only within one workflow run. The workflow carries the ids it has handled through
  Continue-As-New, and the unique key in PostgreSQL covers everything before it.
- Creating a task starts its workflow the same way; a repeated start of the same id is a no-op.
- A decision is never taken from a Temporal message. The Update carries only the decision id; the workflow reads the
  decision from PostgreSQL through a server activity and checks the actor, the revision and that it was not used. Access
  to Temporal alone cannot accept a task.
- A decision for a closed workflow is marked `refused: task closed`. A workflow id is never reused: the relay checks the
  task's state in PostgreSQL before a start, so an expired history cannot start the task again.
- PostgreSQL down: the mutation fails and nothing is confirmed. Temporal down: decisions wait in the outbox.
- Payloads stay small (Temporal limits one payload to 2 MB): logs and results go to artifact storage, only keys travel.

## Task states

The spec's 13 states under their own names plus PAUSED, REJECTED and CANCELLING, 16 in all. Any non-final state may be cancelled: without a run it goes to
CANCELLED at once; with a run it goes to CANCELLING until the machine confirms that the run ended. An unreachable machine
keeps the task in CANCELLING and raises a notice. The owner may force-close it: CANCELLED, marked "end of run not
confirmed". On reconnect the worker stops such a run before anything else.

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
| PLANNING, VERIFYING | FAILED | input that no attempt can make valid |
| BLOCKED | by the kind of block, see below | `resolve_block` by the owner |
| RUNNING | ASSIGNED | the agent surely died: new attempt in the same worktree, resuming the session where the agent allows |
| any active state | PAUSED and back | see below |

Final: ACCEPTED, REJECTED, CANCELLED, FAILED.

- **BLOCKED** stores its kind, and the kind decides the exit: scope to PLANNING; dependency to READY; execution, usage limit
  or agent question to ASSIGNED; environment of a check to VERIFYING; rework limit to REWORK_REQUIRED with a raised limit.
  Before blocking, agents try to settle a technical cause (D18).
- **ASSIGNED without a machine** waits with a notice. The owner may cancel (no run, so at once) or allow another
  agent (`allow_agent`).
- **PAUSE.** In RUNNING and VERIFYING the request is recorded and takes effect when the run or the check ends, before the
  next move; in any other active state at once. RESUME continues with the move that was held back.
- **Revision.** It never edits an old one. In RUNNING the run is stopped as in a cancel (shown as RUNNING, "stopping for new
  requirements"), the worktree stays, and once the machine confirms the end a new attempt starts with the new revision. In
  VERIFYING and AWAITING_APPROVAL the task goes to REWORK_REQUIRED with the new revision; in REWORK_REQUIRED it stays and
  takes it. In BLOCKED and in states before ASSIGNED it goes to PLANNING, in ASSIGNED it stays and takes it. BLOCKED with a
  run whose end is not confirmed only stores it, and the next `resolve_block` goes to PLANNING. In PAUSED it is stored and
  RESUME goes to PLANNING (back to BLOCKED when it was paused there with such a run). A decision carries its revision number; one on an older revision is refused.
- **Dependency.** One that ends without ACCEPTED puts the waiting task into BLOCKED. The owner removes the dependency,
  replaces it or cancels the task. Dependencies stay inside one project in the first version.
- **add_feedback** adds a note and changes no state: the next attempt gets it. **change_priority** affects only work that
  has not started.

## Execution on the machine

Task queues: `machine-<id>` for ordinary activities, `machine-<id>-gpu` with one slot. The TypeScript SDK has no sessions,
so host affinity comes from the queue name, with a schedule-to-start timeout.

An execution is identified by `execution_id`, created on the server before the activity is scheduled. The worker keeps
`~/.agent-rig/factory/executions/<execution_id>/`: intent, launch id, started marker, output, exit, result.

**The runner** (`factory/runner/`) is a small program of the release that `rig exec` starts through a shell script on its
standard input (the only form of `rig exec` that runs an arbitrary program). The execution id stands in that script, so it
is in the recorded text; searching the records by it is worker code, `rig exec` has no such search and does not refuse a
second start. Death is read from the recorded pid and creation time at once, without waiting for the record's heartbeat to
go stale. The runner writes the started marker as its first act, starts the agent, writes output and exit into the
execution folder, and stops the agent at the time
limit. The result therefore exists without the worker and without the `rig exec` log.

1. `StartAgentExecution` writes the intent first. If the intent already exists it looks the execution up instead of
   starting: by the launch id, or, when the crash came before the id was written, by the execution id inside the recorded
   command text of `rig exec` runs. Then:

   | Found | Meaning | Action |
   |---|---|---|
   | exit in the folder | finished | collect |
   | run alive by identity (pid and creation time) | running | attach |
   | started marker, no exit, run ended, pruned or lost by identity | surely died | new attempt (D16) |
   | no marker and no run record | never started | start |
   | a record or the process table cannot be read | unclear | read-only inspection of processes, folder and Git; BLOCKED if it settles nothing |

   A pruned `rig exec` record cannot hide a live run: only ended runs are pruned. On Windows the run is confined to a
   kill-on-close job, so the agent's children end with it.
2. `MonitorExecution` is long, heartbeats, and receives cancellation through the heartbeat. After a worker restart the
   retry attaches to the same execution.
3. `CollectResults` reads the worker's own execution folder. `rig exec` keeps only 50 runs for the whole machine, so its
   log is used for liveness and diagnosis, not as the result. A started marker with no exit and a pruned record means the
   run ended; the marker and the exit file are the proof, not the record.

Because the runner holds the time limit, an agent without a server stops by itself. Without a connection the worker starts
nothing new and decides nothing that needs the server. Results and logs go to the server through the API into a file
store on the server volume; until the upload is confirmed they stay in the execution folder. The activity then returns only
their keys and checksums, and the server checks that they match the stored files before it uses them.

**Report and checks.** The agent's report follows the fields of spec 10.1 and is checked against a schema. Checks are run
by the worker itself (`RunAutomatedChecks`) and stored with command, exit code and log; an agent's claim about a test
never counts as a result.

**Machines.** The worker registers its platform, contract version, capabilities and checked tool paths, and reports to the
API at an interval. A Temporal Schedule marks a silent machine OFFLINE and raises one notice per outage.

**Other users of the same session store.** Factory's Claude runs are ordinary sessions to Rig's global hooks and to the
hub. A run ended by a hub command is seen as an ended run. S3 also checks which user hooks and rules load in a run.

| Operation | Claude | Codex | OpenAI API | ComfyUI | LM Studio |
|---|---|---|---|---|---|
| start | `claude -p`, stream JSON, fixed session id, in `rig exec` | `codex-run.py start` | request | `POST /prompt` | `lms` or local API |
| attach | execution folder and `rig exec status` | job folder | not possible, see below | prompt id in queue or history | to be checked |
| cancel | `rig exec stop` | `codex-run.py cancel` | abort the request | job cancel | to be checked |
| resume | `--resume <session>` as a new attempt | `reply` | new attempt | new attempt | new attempt |

An OpenAI request lost in a crash may already be paid for, so it is not repeated silently: the attempt is recorded as
unclear and the retry counts against the budget.

Codex: the launcher restarts hung work up to three times and orphans a job after 30 minutes without a waiter. Both break
the rules "Temporal is the only recovery" and D3. Factory turns the restarts off (a new switch) and sets the orphan limit
to the run's time limit (read from the environment when the supervisor starts); a hung job is reported to the workflow.
Attaching to a job with a live supervisor does not change it. The supervisor is recognised by pid alone: after a reboot a
foreign process can look alive and `cancel` would kill it, so the launcher first gets the pid-and-creation-time identity
that Rig uses elsewhere. Every start drops the session variables of a surrounding Codex app.

GPU: one slot covers the job from start to end, so it is one activity (`RunGpuJob`), not a start and a monitor. The
order (priority, then first come, no preemption) is kept by the server in `gpu_leases`; a Temporal queue alone does not
order by priority. After a worker restart the generator's own queue is checked before any next job. Use of the card outside Factory cannot be
excluded; the job then waits or fails by its timeout.

## Workspaces

A Git worktree per execution that changes code, outside the owner's checkout. Stored per run: repository, base commit,
branch, path, commits, check results. One writer per worktree. After a crash the worktree and Git state are inspected
before any decision; no hard reset, no branch deletion. Cleanup is a separate activity that refuses a worktree with
unpublished changes. Rig's `project-tmp.sh` hook writes `.claude/settings.local.json` in the project and adds it and `.tmp/`
to Git's `info/exclude`, so they do not show as changes; collection leaves them out.

## Errors and retries

| Class | Retry | On exhaustion |
|---|---|---|
| Database, network, API unavailable | backoff, bounded by schedule-to-close | BLOCKED and notice |
| Worker lost (heartbeat timeout) | same machine queue, look up first | BLOCKED |
| Agent failed or surely died | new attempt within the attempt limit and budget | BLOCKED |
| Agent failed, state unclear | none | BLOCKED |
| Agent usage limit | wait for the reset time when it is known | BLOCKED |
| Validation, permission, budget, bad input | none | FAILED only when no attempt can make the input valid, otherwise BLOCKED |
| External effect (push, pull request, publication) | only after checking the target by idempotency key | BLOCKED |

Numbers (attempts, timeouts, budgets, depth) are settings with defaults set in the phase that measures them.

## Security

- Temporal authorizes nobody by default: the frontend needs mTLS with required client certificates and a private network
  before it leaves the PC. PostgreSQL and the UI are never published.
- API tokens are stored as hashes and carry a role: owner, worker, relay, reader. An agent process gets no token that can
  decide. The Telegram client has the relay role: it may submit a decision (dangerous ones after the hub's second press) only with the hub's press id and a Telegram user
  that is mapped to an owner, and each press id works once.
- The hub's local endpoints have no authentication today. The new generic mechanism needs a per-client key; a button press
  is checked against the hub's allowed users and works once; dangerous actions need a second press.
- Temporal roles are separate: the worker's certificate may poll its own queues and complete activities; it may not start
  workflows or send Updates. Reaching this needs a custom authorizer or a proxy in front of the frontend, proven in S6.
- Profiles: Claude gets a permission mode, tool and directory lists; Codex its sandbox; the worker checks repository,
  directories, Git operations and limits itself. Push and publication are done by the worker after the owner's decision;
  agents get no push credentials in their environment. That an agent of either kind cannot push is proven in S3.
- Residual risk (D13): a process of the same Windows user can read that user's files, saved Git credentials, the hub's key
  and the worker's credentials. Untrusted repositories must not run. Closing it takes a separate Windows user.
- Secrets: Windows credential storage on the PC, files with restricted rights on the server; never in PostgreSQL, events,
  logs or Rig's `state.json`.
- Self-change: an agent works in a worktree; the running release is separate (D11); installing a release is an owner action.

## Migrations and rollback

Schema changes are expand, then contract: a release works with the schema of the release before and after it, and a
contracting step ships one release later. Rolling back code never needs a schema rollback. Server and worker are released
separately: each activity contract has a version, a server supports the current and the previous one, and a machine with
an older contract gets no work and is shown as outdated. `rig update` and its rollback never move a Factory release or the
schema; `rig factory install` does, and a release names the Rig version it needs. Temporal schema moves forward
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
| S3 | Claude and Codex under a profile refuse what it forbids, push included; which user hooks load | attempts outside the directory and tool lists, a push to a disposable remote |
| S4 | The wrapper stops an agent at its limit with the worker gone | kill the worker, wait on an injected short limit |
| S5 | ComfyUI job can be found after a worker restart | restart between queueing and completion |
| S6 | The worker's Temporal credentials cannot start a workflow or send an Update | both calls with the worker's certificate are refused |

## Order of work

0. Audit, this document, contracts for data, API and security; proofs S1 to S6 (S3 spends a little of the Claude limit,
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
