# Agent Factory: Temporal design

Binding: [architecture.md](architecture.md) (D1-D17, state table). Facts: [audit.md](audit.md). Spec sections: "spec 5.2".
Numbers are named settings; defaults are set in the measuring phase.

## Workflows

| Workflow | Queue | Id | Purpose |
|---|---|---|---|
| `TaskWorkflow` | `control` | `task-<task uuid>` | The only writer of task progress. One per task, child tasks included (they are ordinary tasks, not Temporal child workflows). |
| `MachineLivenessWorkflow` | `control` | `machine-liveness` | Started by a Temporal Schedule; reads last-seen times from the API, marks a silent machine OFFLINE, raises one notice per outage. |

No other workflow exists. The outbox relay is a loop in the Control Worker process, not a workflow. Priorities, queues of
tasks and concurrency limits (spec 17) are checked in `SelectAgent` against PostgreSQL, not by a second scheduler.

`TaskWorkflow` keeps in memory: status, `revision`, counters (`attempt`, `rework`, `autoFix`), `executionId` and machine of
the current run, worktree reference, `holdAfterRun`, `stopping`, `resumeTo`, `blockedFrom`, `blockReason`, the map
`handled` (decision id to outcome), the settings snapshot. Waiting for the owner or a dependency is `condition()` on this
state: no worker is held and no timer polls. Every state change is a call to `PersistTaskEvent` before the next step.

Main path by state (all moves follow the architecture's table; each arrow is one `PersistTaskEvent`):
1. CREATED: `PrepareTask` (loads task and requirements revision) then PLANNING.
2. PLANNING: planner run (same machine activities as any run); `CreateChildTasks` for proposals inside scope. The scope
   check is in PostgreSQL; out of scope goes to BLOCKED. Then READY.
3. READY: `ResolveDependencies`; open dependencies go to WAITING_DEPENDENCIES, none go on to ASSIGNED.
4. WAITING_DEPENDENCIES: waits for the Signal `wake`; each wake re-runs `ResolveDependencies` (a read of PostgreSQL).
5. ASSIGNED: `SelectAgent`, `PrepareWorkspace`, `StartAgentExecution`. No machine: stays ASSIGNED, `NotifyUser` once;
   the wait ends on `wake` or on `assign.maxWait` (see Open for the owner).
6. RUNNING: `MonitorExecution` until an outcome; then `CollectResults`, `UploadResults`. Outcome `finished` goes to
   VERIFYING (or to PAUSED if `holdAfterRun`); `died` starts a new attempt in the same worktree within `attempt` and
   budget limits (ASSIGNED); `unclear`, `limit`, `question` go to BLOCKED; non-retryable error goes to FAILED.
7. VERIFYING: `RunAutomatedChecks`, then `RequestReview` (picks a reviewer other than the implementer, spec 9.1; the review
   run is the same activities). Pass goes to AWAITING_APPROVAL; confirmed findings to REWORK_REQUIRED; `rework.maxRounds`
   reached to BLOCKED.
8. AWAITING_APPROVAL: waits for a decision Update. `PublishArtifacts` runs only after ACCEPT, on the machine, by key.
9. After a final state: `CleanupWorkspace` only on the owner's request or `cleanup.auto`; then the workflow completes.

## Retry classes (spec 5.5)

Classes follow the architecture's error table; settings `retry.<class>.maxAttempts|initialInterval|backoffCoefficient|
maxInterval`. Agent died, limit, question, unclear are typed return values, not exceptions: Temporal retries only
infrastructure faults. A new agent attempt is a workflow loop bounded by `attempt.max` and budget.

| Class | Temporal retry | Error types | Exhaustion |
|---|---|---|---|
| `infra` | yes, bounded by schedule-to-close | `DbUnavailable`, `ApiUnavailable`, `NetworkError` | BLOCKED, notice |
| `workerLost` | yes, same machine queue; first step is a lookup | heartbeat timeout | BLOCKED |
| `agentDied` | no; workflow loop | outcome `died` | BLOCKED after `attempt.max` |
| `unclear` | no | outcome `unclear` | BLOCKED at once |
| `usageLimit` | no; workflow sleeps until the reset time when known (`limit.maxWait`) | outcome `limit` | BLOCKED |
| `invalid` | no | `ValidationError`, `PermissionDenied`, `BudgetExceeded`, `BadInput` (non-retryable) | BLOCKED, or FAILED where the table allows |
| `external` | only after checking the target by idempotency key | `PublishFailed` | BLOCKED |

## Activities (spec 5.2 and the architecture's own)

Timeouts per activity are settings `act.<Name>.<kind>`: S start-to-close, Q schedule-to-start (machine queues only,
bounds the wait for a machine), H heartbeat, C schedule-to-close. "Key" is the idempotency key.

| Activity | Queue / where | Key | Timeouts | Class | Non-retryable | Escalation |
|---|---|---|---|---|---|---|
| `PrepareTask` | `control`, server | task id + revision | S C | infra | unknown task | BLOCKED |
| `ResolveDependencies` | `control` | read only | S C | infra | cycle | BLOCKED |
| `SelectAgent` | `control` | task id + attempt | S C | infra | no agent allowed by profile | BLOCKED |
| `ReadDecision` | `control` | decision id | S C | infra | actor, revision or use check fails | Update fails, task unchanged |
| `PersistTaskEvent` | `control` | event id, row version | S C | infra | version conflict is re-read, not failed | BLOCKED |
| `NotifyUser` | `control`, writes a notice via API; Telegram client delivers | notice key | S C | infra | none | none (a lost notice is shown in the panel) |
| `CreateChildTasks` | `control` | origin task + proposal id | S C | infra | depth, count, scope limit | BLOCKED with the proposal |
| `RequestReview` | `control` (selects reviewer, creates review record) | task + round | S C | infra | no second agent allowed | BLOCKED |
| `PrepareWorkspace` | `machine-<id>` | execution id | S Q C | workerLost | repo missing, dirty base | BLOCKED |
| `InspectWorkspace` | machine | read only | S Q | workerLost | none | BLOCKED |
| `StartAgentExecution` | machine | execution id (intent file first) | S Q C | workerLost | `invalid` | BLOCKED |
| `MonitorExecution` | machine | execution id | S Q H | workerLost | none; returns outcome | per outcome |
| `StopExecution` | machine | execution id | S Q C | workerLost | none | stays CANCELLING, notice |
| `CollectResults` | machine | execution id | S Q C | workerLost | report schema invalid becomes a finding, not an error | REWORK or BLOCKED |
| `UploadResults` | machine, via API | execution id + file hash | S Q C | infra | none | BLOCKED; files stay on the machine |
| `RunAutomatedChecks` | machine (also H when a check is long) | execution id + check id | S Q H | workerLost | tool missing becomes `not_run` | VERIFYING fails to BLOCKED |
| `PublishArtifacts` | machine (credentials stay with the worker) | branch + target, checked first | S Q C | external | `invalid` | BLOCKED |
| `CleanupWorkspace` | machine | worktree path | S Q | workerLost | unpublished changes | stays, notice |
| `RunGpuJob` | `machine-<id>-gpu`, one slot | job key in the generator's queue | S Q H | workerLost | `invalid` | BLOCKED |
| `ReconcileMachine` | machine, at worker start before polling | none, read mostly | S | infra | none | machine not registered |
| `LoadSettings` | `control` | read only | S | infra | none | none |

Heartbeat details of `MonitorExecution` and `RunGpuJob` are the log offset and the execution id, so a retry attaches. The
SDK throttles heartbeats to the smaller of 0.8 x heartbeat timeout and 60 s; `act.*.H` is set above that. Cancellation of
an activity reaches it only on a heartbeat, so the workflow never relies on it for stopping an agent: it calls
`StopExecution`, which acts on the runner directly.

## Operations (spec 5.3)

All operations are Updates delivered by the outbox relay; the Update id is the outbox id. Ids are `approve`,
`reject`, `request_changes`, `cancel`, `pause`, `resume`, `revise_requirements`, `add_feedback`, `change_priority`,
`resolve_block`. Signals exist only for wake-ups carrying no decision: `wake` (dependency ended, machine back).

Order of checks: (1) the **validator**, which is deterministic and sees only workflow memory: the state allows the
operation (the table below), the revision in the payload is the current one, the Update id is not in `handled`. A refusal
here writes nothing to history and the relay marks the outbox row `refused` with the reason. (2) The **handler** takes a
mutex so one decision applies at a time, calls `ReadDecision` (actor is the owner, revision, not used; marks it used),
applies the effect, calls `PersistTaskEvent`, stores the outcome in `handled`. A repeated id returns the stored outcome
and has no effect. Failures after the validator are non-retryable `ApplicationFailure`; the workflow continues.

Legend: `R` refused by the validator (`not_allowed_in_state`); `note` recorded, no move; `->X` moves to X; `flag` sets
a flag, no move. `*` see below the table.

| State | approve | reject | request_changes | cancel | pause | resume | revise_requirements | add_feedback | change_priority | resolve_block |
|---|---|---|---|---|---|---|---|---|---|---|
| CREATED | R | R | R | ->CANCELLED | ->PAUSED | R | ->PLANNING | note | note | R |
| PLANNING | R | R | R | ->CANCELLED | ->PAUSED | R | ->PLANNING | note | note | R |
| READY | R | R | R | ->CANCELLED | ->PAUSED | R | ->PLANNING | note | note | R |
| WAITING_DEPENDENCIES | R | R | R | ->CANCELLED | ->PAUSED | R | ->PLANNING | note | note | R |
| ASSIGNED | R | R | R | ->CANCELLED or ->CANCELLING * | ->PAUSED * | R | ->PLANNING * | note | note | R |
| RUNNING | R | R | R | ->CANCELLING | flag `holdAfterRun` | clears the flag | stop, then new attempt: ->ASSIGNED | note | note (next attempt) | R |
| VERIFYING | R | R | R | ->CANCELLED or ->CANCELLING * | ->PAUSED after the running check * | R | ->REWORK_REQUIRED | note | note | R |
| AWAITING_APPROVAL | ->ACCEPTED | ->REJECTED | ->REWORK_REQUIRED | ->CANCELLED | ->PAUSED | R | ->REWORK_REQUIRED | note | note | R |
| REWORK_REQUIRED | R | R | R | ->CANCELLED | ->PAUSED | R | note (next attempt uses it) | note | note | R |
| BLOCKED | R | R | R | ->CANCELLED or ->CANCELLING * | ->PAUSED | R | the rule of `blockedFrom`, block cleared | note | note | ->`blockedFrom` or READY * |
| PAUSED | R | R | R | ->CANCELLED | note | ->`resumeTo` or the held move | note, applied at resume | note | note | R |
| CANCELLING | R | R | R | note (already ending) | R | R | R | R | R | R |
| ACCEPTED, REJECTED, CANCELLED, FAILED | R closed | R closed | R closed | R closed | R closed | R closed | R closed | R closed | R closed | R closed |

`*` ASSIGNED: if `StartAgentExecution` was already scheduled the intent may exist, so cancel goes to CANCELLING and
pause waits for the start to settle (a started run is RUNNING and takes the RUNNING cell). Revise in ASSIGNED, BLOCKED
and PAUSED applies the earlier-states rule to the state left. VERIFYING: cancel goes to CANCELLING when a check or review
run is alive. BLOCKED: cancel goes to CANCELLING when `blockedFrom` may have a live run. `resolve_block` carries a kind
(`retry`, `raise_limit`, `answer`, `remove_dependency`, `replace_dependency`, `cancel_dependent`); removal or
replacement of a dependency returns to READY, the rest to `blockedFrom`. RUNNING with `stopping` set (revision stop)
shows status RUNNING until the machine confirms the end.

## Continue-As-New

Triggered when `continueAsNewSuggested` is true or `history.maxEvents` is passed, only at a quiet point: no activity in
flight and `allHandlersFinished()`. A long `MonitorExecution` does not force it (heartbeats add no events). It carries: task id, status and flags (`holdAfterRun`, `stopping`, `resumeTo`,
`blockedFrom`, `blockReason`), `revision`, `attempt`, `rework`, `autoFix`, current `executionId` and machine, worktree
reference, `handled` (decision ids and outcomes), dependency and child ids, the settings snapshot, budget used, the
contract version. The Update dedupe of Temporal does not cross a roll-over; `handled` and the unique key in PostgreSQL do.

## Failure scenarios (spec 8), step by step

**A. Local Rig closed.** (1) Server keeps `TaskWorkflow`; machine activities wait on `machine-<id>`. (2) A running
`MonitorExecution` fails by heartbeat timeout (`workerLost`); a not yet started one waits until `act.*.Q`. (3) The agent
lives on under `rig exec` or the Codex supervisor and stops by its runner time limit. (4) On return the worker runs
`ReconcileMachine` first (executions folder, process identity, worktrees, open cancels from the API), then polls. (5) The
retried `StartAgentExecution` finds its intent and applies the architecture's lookup table (collect, attach, new attempt,
start, BLOCKED); Q expiry with the machine silent goes to BLOCKED.

**B. Windows restart.** (1) Autostart (if enabled) starts the worker; without it the situation is A. (2) The worker
registers again with platform, contract version, tool paths. (3) `ReconcileMachine` checks leftover processes by pid and
creation time, worktrees by Git state, no cleanup. (4) Activities that retry hit the lookup table, so a run that
survived is attached and never started twice. (5) A run that did not survive and left a started marker is `died`.

**C. Temporal Server down.** (1) State is in persistence; workers and the relay get connection errors and back off. (2)
Decisions wait in the outbox. (3) Agents continue; their results stay in the execution folder. (4) After recovery
workflows resume; activity timers fire as recorded, so a completed attempt with its result already stored is
collected by the lookup, not repeated. External effects retry only after the target check (`external`).

**D. PostgreSQL down.** (1) API refuses mutations, nothing is confirmed. (2) Server activities fail as `infra` and retry;
`PersistTaskEvent` is idempotent by event id. (3) After recovery the relay re-sends outbox rows in `pending`; a row
already applied is recognised by `handled` (or by the unique key), so no decision is lost or doubled. (4) The projection
is rebuilt from the workflow's own events if a row version lags: the workflow is the writer.

**E. Agent dies while changing code.** (1) `MonitorExecution` returns `died` or `unclear` from the lookup table. (2)
`InspectWorkspace` records Git state and file changes (see the adapters document for the two files of Rig's temp hook).
(3) `died`: new attempt in the same worktree, session resumed where the adapter allows, results of the earlier attempt
kept, within `attempt.max` and budget. (4) `unclear`: BLOCKED (D16); the owner chooses `retry`, `answer` or cancel.

**F. Network isolation.** (1) The worker starts nothing new without a connection; no decision needing the server is taken
locally. (2) Running processes end by their runner time limit or finish. (3) On reconnect `ReconcileMachine` uploads
what the folder holds and reports it; the workflow decides from the outcome. (4) Conflicts: an execution the server
considers cancelled or superseded (`stopping`, revision changed, new attempt) is stopped before anything else; a result
for a stale revision is stored but marked `stale` and never advances the task.

**G. Duplicated events.** (1) Repeated Update id: server dedupe inside the run, `handled` across roll-overs, unique key
in PostgreSQL before. (2) Repeated Signal `wake`: harmless, it only re-reads. (3) Repeated activity: key per activity
(table above). (4) `PublishArtifacts`: first checks the remote branch and pull request by key, creates only if absent,
and stores the URL. (5) A duplicate `StartAgentExecution` finds the intent and never starts a second agent.

## Limits of child tasks (spec 9.1, 17)

Checked in `CreateChildTasks` inside one PostgreSQL transaction, not in workflow code: `child.maxDepth`,
`child.maxPerParent`, `child.maxPerRoot`, `rework.maxRounds`, `autoFix.max`, `attempt.max`. Each child row has
`origin_task_id`, `origin_kind` (planner, reviewer, implementer) and `kind` (`defect`, `requirement_change`,
`suggestion`). Only `defect` inside the approved scope may become a task by itself; the other two are stored as proposals
the owner decides. A limit reached sends the parent to BLOCKED with the proposal attached. Dependency cycles are refused at
creation.

## Replay and versions
- Workflow code in `factory/workflows/` imports only types and workflow APIs: no clock, random, network, environment or
  settings reads; time and ids come from the Workflow API; settings arrive from `LoadSettings` into the snapshot.
- Every release carries a deployment version (Worker Versioning); its general-availability status is to be checked
  (audit 8.5). Until confirmed, a code change on a live path uses `patched()`, removed by `deprecatePatch()` later.
- CI replays saved histories (one per state path, from integration tests) against new code; a failed replay blocks release.
- A release that cannot replay a running task keeps its workers online until it finishes or rolls over. The contract
  version is in every activity input; an older machine gets no work (architecture, Migrations).

## Open for the owner
1. **ASSIGNED without a machine.** Options: wait for ever with a notice (as the architecture says); BLOCKED after
   `assign.maxWait`. Recommendation: BLOCKED after a setting, because a silent wait is invisible for weeks.
2. **CANCELLING with a machine that never returns.** Options: stay until it returns; owner "force close" that marks the
   run unknown and leaves a possible live process. Recommendation: stay, plus an owner-only force close with a warning.
3. **Decisions while PAUSED.** Options: refuse until `resume` (as the table); allow accept, reject, request_changes.
4. **Who confirms review findings** (VERIFYING to REWORK_REQUIRED): the owner; a second automatic check; the reviewer
   alone. This changes cost and what the owner sees.
5. **FAILED is final.** A bad input or a transient mistake mislabelled non-retryable cannot be retried. Options: new task
   only; an owner `reopen` from FAILED to BLOCKED.
6. **Cleanup after a final state:** automatic after a delay (`cleanup.auto`) or only on the owner's command.

## Contradictions
1. The architecture says the workflow's validator "accepts or refuses" and also that the workflow reads the decision through
   an activity, which a validator cannot run. Here the validator checks memory, the handler checks the decision; a
   wrong-actor refusal is then a failed Update.
2. No operation leaves BLOCKED (only "owner's decision"); `resolve_block` is added here. `request_changes` is missing
   from spec 5.3 (the architecture has it through D7).
3. BLOCKED returns "to the state it left" but, for dependencies, "to READY". BLOCKED from VERIFYING by the rework limit
   would loop back; `raise_limit` or an owner choice of REWORK_REQUIRED is needed.
4. No exit to FAILED from PLANNING, VERIFYING or BLOCKED, though the error table says "BLOCKED or FAILED" for invalid
   input. Here only RUNNING reaches FAILED.
5. PAUSE in VERIFYING conflicts with a running check; here it takes effect after the activity. Revision during
   RUNNING has no state while the run stops; `stopping` flag with status RUNNING.
6. CANCELLING (machine gone) and ASSIGNED (no machine) have no exit; see open points 1 and 2.
7. Spec 8E: unclear state "goes to verification"; architecture D16: BLOCKED. The architecture wins.
