# Agent Factory testing

Design, nothing is built. [architecture.md](architecture.md) is binding (D1 to D34 are its decisions; "call" marks a choice made in these documents, open to veto); threats and their
check ids (`secret-canary`, `path-escape`, ...) are in [security.md](security.md); the decision registry, the regulation
and their check ids are in [governance.md](governance.md). A check named here must be able to
fail: each has a pass criterion and a fail criterion, and a new check is first shown failing on the old or broken code.

## Rules

- No real sleeps or waits on wall-clock timeouts. Every timer, expiry and limit takes an injected clock; workflows use
  Temporal's time-skipping environment. The one real wait is a process exiting after a kill, awaited on its exit event.
- Disposable databases only: one PostgreSQL container per run, one database per test file created from a template
  database; dropped in teardown, also on failure. A working database is never opened.
- Temporary files through the language's temp API, deleted in teardown.
- Agents in tests are small fake programs (print, sleep on a fake clock, exit with a code, refuse). No paid model call
  outside a test marked `live`; live tests run by hand with `FACTORY_LIVE=1`, and the run states its cost beforehand.
- Cap parallelism, leave one core free, run heavy container suites one at a time.
- Probes of a recurring failure stay as tests under a `probe` category; one-off probes are deleted.
- Runner: Node's built-in test runner for Factory tests (call: fewest dependencies, D17 fixes the runtime).
- CI: none (call). The suite, S1 to S6 where they apply, and the failure scenarios run by hand before a release; a
  release records the command, versions and result. A hosted or self-hosted runner is not planned until a server exists.

## Levels and tools

| Level | Tool | Scope |
|---|---|---|
| Unit | Node 24 test runner (D17) | transition table as data, routing, dependency cycles, retry classes, authorization matrix, idempotency, redaction, path resolution |
| Workflow | Temporal time-skipping environment; replay over saved histories | workflows, signals/Updates, timeouts, Continue-As-New, Worker Versioning |
| Integration | containers: PostgreSQL 16, Temporal, API, Control Worker, local worker, fake agents | API, outbox, adapters, result storage, acceptance, redelivery |
| Failure | the same stack plus a harness that stops containers and kills processes by PID | F1 to F14 |
| Proof | scripted runs against real Windows, real agent CLIs | S1 to S6 |
| Rig regression | `bun test`, `bun run typecheck`, `rig check`, Docker scenarios | Rig with `factory` off and on |
| Live | real agent CLIs, marked, hand-run | adapter smoke only |
| Robot: simulator, bench, physical (D34) | a simulator and fake robot runtime in the stack; a bench controller with its power cut and stop circuit; the real platform only after an admission of the owner's regulation | the `robot-*` checks below |

Factory tests live in `factory/tests` with their own commands; the Rig suite never imports them.

## State, decision and queue checks

Table-driven where the rule is data; each can fail (a cell removed, a check dropped).

| Id | Check | Pass | Fail |
|---|---|---|---|
| `ops-matrix` | Walks the 16 states by the 12 decision kinds of [temporal.md](temporal.md) (the operations matrix); for each pair sends the decision to a workflow in that state | every cell has the stated effect (applied, or refused with one of `not_allowed_in_state`, `revision_stale`, `actor_not_allowed`, `already_resolved`, `block_kind_mismatch`, `block_handled`, `owner_only`, `task_closed`); `resolve_block` is walked once with the owner and once with the chief engineer as the actor; no cell is empty or leaves the workflow stuck | a cell without an effect, an unknown refusal reason, or a state change outside the transition table |
| `state-exit` | For every state, the "every state has an exit" table: drive the task to the state, then take the stated exit; for BLOCKED each of the seven kinds with each handler (`chief_engineer`, `owner`) | each state reaches a final state or its normal successor, CANCELLING and BLOCKED included (D21, D26); a block with the handler `chief_engineer` has an exit by the engineer's `resolve_block` and by `call_owner`, one with the handler `owner` by the owner's decision | a state with no exit, or a block whose handler has none |
| `decision-recorded` | Send a decision that must be refused (stale revision, closed task, wrong actor, wrong block kind, a block already handled by the owner, a cost raise or a dangerous operation by the chief engineer) through the API | one `task_decisions` row, `refused` with a reason (`block_handled`, `owner_only` included) and a notice; the API answers 202, never an error for state | no row, or an HTTP refusal for a state fact |
| `decision-kinds` | The enum in [database.md](database.md), the API routes of [api.md](api.md) and the handler table of the workflow list the same 12 kinds (`allow_agent` included) | identical sets | any set differs |
| `second-press` | Each dangerous operation (`cancel`, `reject`, `force-close`, publication) with one press, with a second press in another channel, with an expired or reused one | only the same-channel second press inside the window is accepted, once | any other form accepted |
| `relay-press-once` | The relay submits the same `press_id` twice, and a press from an unmapped Telegram user | the first decision recorded; the second refused; the unmapped user refused | a second row for one press id, or an unmapped user accepted |
| `control-no-queue` | Run the lifecycle tests with the real Control Worker options and read the histories; compare the activity catalogue with the options (D28) | no history has an activity task of the `control` queue; every `local` row is reached through local activities; the Control Worker has `enableNonLocalActivities: false`; `act.<Name>.S` of each is below the workflow task timeout | one server step scheduled as an ordinary activity, or the option missing |
| `second-machine-refused` | Register a second machine, with and without the gateway declared in the deployment; register the first one again (D28) | without the gateway the second is refused `queue_isolation_required` and gets no work; the first may register again; with it the second registers | a second machine registers without the gateway |
| `gpu-order` | Several tasks request one machine's GPU slot with different priorities and request times, while one job runs | grants go by highest priority, then oldest request; one holder at a time; no preemption | a lower priority or a later request granted first, or two holders |
| `cleanup-command` | Cleanup of a final task, a task not final, a task awaiting approval, a worktree with unpublished changes; the chief engineer's cleanup inside and outside its part (G15); and a day count passing on the injected clock | nothing is deleted by itself; a cleanup removes only files and keeps rows; refusals as listed in [database.md](database.md) | anything removed without the command or a grant, anything of the owner's part removed by the chief engineer, or a row deleted |
| `review-provider` | Review of a task whose implementer ran on one provider, with and without another provider eligible (D20) | another provider reviews; with none the task waits and a notice is sent | the same provider reviews |
| `check-not-run` | A mandatory check that cannot run (D26) | agents get a repair attempt; then BLOCKED `check_environment` with the handler `chief_engineer`, so the first notice goes to the chief engineer; never AWAITING_APPROVAL | a `not_run` check counted as passed or sent to the owner as complete, or the owner told first |
| `block-owner-load` | Enter every BLOCKED kind with a cause that needs the chief engineer (a dependency, an execution error, a usage limit, an environment check, a rework limit) and with one that needs the owner (requirements, scope, cost, a dangerous operation, an owner's credential); the engineer resolves one, calls the owner on another, is unavailable on the injected clock for a third; a usage limit with another provider enabled and with none; the owner decides a block the engineer is resolving (D15, D18, G13) | the handler follows the one rule in code; the owner gets a notice only for an `owner` block or after `call_owner`; a limit reaches the owner only when no enabled agent of any provider can run; with the engineer away the block waits and nobody is told; the owner's decision wins (`block_handled`) | the owner told of a block the engineer can settle, a block that stays with the engineer after `call_owner`, or a notice sent while the engineer is away |
| `poll-arbiter` | One poll of each arbiter (`hub` for an ordinary session, `api` for a Factory decision); the same answer from the PC and from Telegram, repeated with the same idempotency key, with the API down, and late; the hub's confirmation lost and retried | an ordinary-session poll is settled once by the hub (a request row `pending`, then `accepted` or `refused`, retried until confirmed) and the API never decides it; the relay answers with the API down; a Factory poll is settled by `task_decisions` once, a late answer refused `poll_closed`; only the hub token sets the result columns | two arbiters for one poll, a second settlement, a late answer taken, or a result written by another token |
| `event-cursor` | Commit two transactions in the reverse order of their sequence numbers (the later number first) while a reader holds a cursor; read each stream (`task_events`, `audit_log`, `notifications`, `messages`) with it; send a cursor of another stream and a malformed one | the reader returns only rows older than the oldest running transaction, so the late-committed row appears on a later read and none is skipped or repeated; a foreign or malformed cursor is refused `bad_cursor` (400) | a row skipped or read twice, a cursor accepted by another stream, or an `after_seq` read of a number the client builds |
| `standing-task` | A ten-minute run for an ordinary session in a project and in none; the request row, the limits, the scheduler, the lists, the soft delete and the cleanup | one standing task per project and one for `_factory`, fixed RUNNING, no workflow, no decision, no workspace; the request row links to it; the scheduler, lists, soft delete and cleanup never touch it; agent and worker concurrency still apply; attempt, rework and budget rules do not | a second standing task, a standing task in a list or in cleanup, a request with no task, or a task state change |
| `right-steps` | A right already held by role, record or live grant (no request row); a request answered by the chief engineer with `call_owner`, then by the owner; a request on the owner's list answered by the code with `call_owner`, then by the owner; a repeat; an update of a step row; a grant of the chief engineer or of the code without a clause; an owner's grant without its act, with an act of another request, with a changed target, with a used act and with its own act | one immutable `right_answers` row per step (`chief_engineer`, `code`, `owner`); a `call_owner` of either kind is never closing; a code `grant` and a chief engineer grant without `clause_id` are refused by the constraint; an owner grant needs `owner_act_ref` and no clause; the grant points at the step that gave it; no update of a request or an answer is allowed to any account | a final `call_owner`, a code step that cannot be `call_owner`, an owner's grant refused for lack of a clause or accepted without its act, an owner's answer that cannot be recorded, or an updated step |
| `review-same-subject` | A decision that relies on a `task_reviews` row (the rule "One rule for every review a decision relies on" of [database.md](database.md)) with a review of another task, a verdict other than `pass`, and one written by the subject's own run or agent or the decider's | the database trigger refuses it; with the same task, verdict `pass` and another author it passes; the decision's row holds the review's id, not a copy of the verdict | any of the three accepted, or a verdict copied into the decision's row |
| `review-same-incident` | A measure that relies on an independent check or a classifier review (`qualification_reviews`), with one tied to another incident, a verdict other than `confirmed`, the author of the measure or of the classification | the trigger refuses it; `incidents.classified_by` is set once; with the same incident, `confirmed` and another author it passes | any of them accepted, or `classified_by` changed |

Phases of the seven checks above (as in [modules.md](modules.md)): `block-owner-load` 2 and 3 (the rule and the
refusals in 2, the workflow side in 3, the engineer's side in 4), `poll-arbiter`, `event-cursor` and `standing-task` 2, `right-steps` 4, `review-same-subject` 5 and
`review-same-incident` 8. Each runs on the disposable database and the injected clock.

## Registry and regulation checks

The fifteen checks (nine of the registry and regulation, six of the rights, D31) are defined in
[governance.md](governance.md) (section "Checks"), each with its pass and fail criterion; they are not copied here. They
run on the disposable database and a fake clock like the rest, and a new one is first shown failing on the broken code.

| Id | Level | Phase |
|---|---|---|
| `registry-first`, `registry-fail-open` | integration: API gate, the hub question hook as a fake command, a timeout on the injected clock | 2 |
| `registry-capture`, `registry-scope`, `registry-authority` | unit (order and scope rules as data) and integration (the relay press path) | 2 |
| `permission-by-record` | integration: the rights check and the permission hook as a fake command, every near miss (target, argument, project, unreadable call, consumed `once`, a `decision` record, similar text) against an exact match, a deny rule, the chief engineer unavailable on the injected clock (a waiting request, no prompt, no notice to the owner), the registry off or unreachable (the prompt in an ordinary session, a denial in a Factory run `claude -p`), a native prompt pressed by the owner (never a grant) | 2 (the hook cases with the chief engineer in 4) |
| `permission-second-press` | integration: every dangerous operation with a record and with a grant still asks for the second press | 2 (with a grant, 4) |
| `role-rights` | integration: a run does what its role names and nothing else, per participant; a role is given only by the chief engineer and its contents change only with the regulation | 2 |
| `chief-engineer` | unit (the code check of an answer, as data) and integration (a fake chief engineer: no clause, too wide, owner's list (the code answers `call_owner`, a non-final step, and the owner's step follows), a grant that fails the code check (a `code` `refuse` step, never a grant, and no message to the owner), own run, repeat of a refusal, instructions in the request, empty regulation, ordinary session asks it before the owner, while it is away requests wait and each is answered once after its return; an ordinary session's request handled under the standing task) | 4 |
| `grant-ends` | integration and database: end of task, end of session, revocation, a critical suspension in each of the six places a right lives (role gate, grant, `permission` record, token, live session, Codex sandbox), next attempt of the same participant, a restore that does not revive a grant; each ending also stops, in the same transaction, every live run whose stored profile holds the ended right (`rights-snapshot`); the search never returns a grant | 4 |
| `rights-snapshot` | integration and database: a Codex profile never holds a `once` record or a right narrower than the sandbox can express (that action is a step of its own, checked and consumed when done); `task_runs.profile_rights` holds the rights it was built from; the end of a grant, the revocation of a record, a regulation version replacing a right, the end of a role assignment and a suspension each write, in the same transaction, a `stop_run` for exactly the live runs whose stored profile holds that right; the others go on; the task goes on with a new attempt and a fresh profile | 4 (the profile rule in 2) |
| `rights-suspended` | integration and database: an open suspension refuses at step 1 for every agent, the chief engineer included; one open row per agent; the suspension, the ended grants, the revoked token, the audit row, one `stop_run` order for every live run of the agent (an agent with runs of two configurations has both stopped) and the notice written in one transaction; no new run of the agent starts while the row is open; a restore by the suspended agent refused, by the chief engineer or (for the chief engineer's own suspension) the owner accepted | 2 (the stop order executed in 4) |
| `registry-history`, `regulation-change` | database (triggers, grants) and integration (two presses, version size, guard conflict) | 2 |
| `registry-search` | measured on a set of questions with the chosen model; also runs without the model (`degraded`) | 2 |
| `registry-import` | integration: Factory documents and project memories as input, a second run | 2 |

## Personnel checks

The eight checks of [personnel.md](personnel.md) (section "Checks", D32) are defined there with their pass and fail
criteria; they are not copied here. They run on the disposable database and a fake clock, with fake agents and a fake
evaluator, and a new one is first shown failing on the broken code. No real month passes: `personnel-load` simulates it on
the injected clock.

| Id | Level | Phase |
|---|---|---|
| `personnel-facts` | database and integration: every source (check, review, run, request) writes one fact; an agent's text, a report and a token write none; a configuration change opens a new history | 5 |
| `personnel-score` | unit (the score as data: weights, categories, "not enough data" below the minimum) and integration (a guard kept and a protected case change nothing downward) | 8 |
| `personnel-protected` | unit (every item of the protected list as a case, each near miss against it) and integration (the same event key gives one incident) | 8 |
| `personnel-decision` | unit (the code check as data: no evidence, no independent check at any level (a remark and a warning included), a check of another incident, a verdict other than `confirmed`, own author, no term) and integration in both `observe` and `enforce` | 8 |
| `personnel-effect` | integration and database: a measure closes the rights through the rights code, tasks are handed over, history, registry and audit stay | 8 |
| `personnel-chief` | integration: a fake chief engineer tries to change, read drafts of or stop its own assessment; a replacement with and without the owner's approved procedure | 8 |
| `personnel-safety` | integration: each critical event of the list in both modes, for an executor and for the chief engineer; every live run of the agent stops (each killed by its identity, the Codex sandbox included, also with the worker silent past `stop.orderSeconds`, all configurations of the agent, no new run until the restore), every place a right lives closes in one transaction with the audit row `personnel.critical_reaction`, the owner is notified; a restore only by the chief engineer or, for its own suspension, the owner | 4 (the incident row linked in 8) |
| `personnel-load` | workflow on the injected clock: a simulated month of staff decisions; the only requests to the owner are the exceptional ones | 8 |

## Client checks

The eleven checks of [client.md](client.md) (section "Checks", D33) are defined there with their pass and fail
criteria; they are not copied here. The API side runs on the disposable database with a fake hub and a fake clock; the
client side on a headless test device for Android and for Windows, against a fake API built from the same
`openapi.json`. Nothing waits on a real clock, and a new check is first shown failing on the broken code.

| Id | Level | Phase |
|---|---|---|
| `client-contract` | unit: the generated library is regenerated and compared with the API; a network guard in the test device records every host a call goes to | 2 (library), 6 |
| `client-resume` | integration: the stream is cut after every event of a recorded run and resumed with the opaque cursor; a row committed late by an earlier transaction is read once, a cursor of another stream or a malformed one is refused `bad_cursor`; the result has each event once | 2 (API side), 6 |
| `client-retry` | integration: a mutation repeated after a lost answer with the same idempotency key is applied once; a dangerous operation is never sent from the offline queue | 2 (API side), 6 |
| `client-approval` | integration on both platforms: changed parameter, used, expired, revoked device and other channel are each refused | 6 |
| `client-sessions` | integration with a fake hub: an ordinary session and a Factory run give each message once; a poll answered in one place closes in the other and a late answer is refused by its one arbiter (the hub for an ordinary session, the API for a Factory decision); the client's answer is a request row retried with its idempotency key until the hub confirms; the hub's Telegram relay answers with the API down and its queue, cut at any point, replays every record once afterwards | 6 |
| `client-no-model` | integration: the network guard sees no request to a provider or a local model port; forged, unparsed and malformed messages stay plain text and trigger nothing | 6 |
| `client-no-secret` | integration: a canary token over the build, the cache, the log and the stream | 6 |
| `client-closed` | integration: a task runs to the end with no client connected; the client's state is right on return | 6 |
| `client-foreign-prompt` | unit and integration: the list of served and unserved prompts as data; a third-party tool's own confirmation never becomes an approval, its text is never sent to or stored by the API (only the state "waits for a permission answer", shown as "answer in Telegram or at the terminal"), and a message that looks like a prompt is plain text without controls; the owner's press on a native prompt is the owner's own act, not a grant; a Factory run has no such prompt and is denied | 6 |
| `client-stop` | integration: stop-all with Temporal, the client and the models down ends runs (killed by identity) and closes rights through one suspension per agent | 6 |
| `client-move` | integration: the full state is exported and restored into an empty stack; decisions, regulation, history, tasks and links compare equal | 7 |

## Robot checks

The 12 checks of [robotics.md](robotics.md) (section "Checks", D34) are defined there with their pass and fail
criteria; they are not copied here. The level says where a check runs: **simulator** (a simulator and a fake runtime in the
disposable stack, injected clock), **bench** (a real controller and runtime with the motors unpowered or lifted, the stop
circuit wired) or **physical** (the real platform, only after the owner's regulation admits a physical test). A check that
needs a level not yet available is reported as not run, never as passed. The stage is a stage of robotics.md, Phases (the
owner's order: R0 after Phase 0, R1 after phase 5, R2 to R4 need hardware and the runtime, R6 goes with the client, the rest
as their gates pass). A new check is first shown failing on the broken code or a deliberately broken runtime.

| Id | Level | Stage |
|---|---|---|
| `robot-lease` | integration and simulator: two agents, a revoked and an expired lease against the partial unique index and the runtime's own check | R1 (simulator), R3 (bench) |
| `robot-command` | simulator and bench: forged, replayed, stale, out of sequence, wrong configuration and unsupported commands each refused by the runtime; receipts deduplicate | R1 (simulator), R3 (bench) |
| `robot-unknown` | workflow and simulator, then bench: a lost answer and a restart of runtime, controller, API and Temporal; no repeat and no motion until an observation and a new permission; the handler of `physical_unknown` is the chief engineer, never the owner, and a person is asked only when no allowed observation remains (a dependency, not on the critical list); a release from `unknown`, `stopped` and `maintenance` is never refused with `robot_state_unconfirmed` and is refused with `release_requires_check` only without a new check or permission; a quarantine release by the service is `owner_only` (fails on a route that still rejects a release for an unconfirmed state) | R1 (simulator), R3 (bench) |
| `robot-five-gates` | integration and simulator: each gate closed alone stops the command; a scan of the code for any path that raises a limit | R1 (simulator), R3 (bench) |
| `robot-qualification` | database and integration, then simulator and bench: each refusal of the list as a case; simulation never counts as physical; the first physical test of an unqualified skill passes gate 3 only with an experiment admission, which is single-use, bound to one experiment, valid for the stage reached and the next, and runs in the restricted mode, and stands on both a reviewer's confirmation and the chief engineer's decision, neither by the executor (one missing, the same run twice, the executor's provider, a second use, another experiment or a stage outside its term is refused; fails on a design with no admission or a circle); a stage opens only on an independent confirmed exit, and a skipped, self-confirmed or reopened-by-configuration exit is refused by runtime and database | R1 (data), R4 (bench and physical) |
| `robot-safety` | simulator and bench: every loss and fault of the list ends in the safe state with the stop latched, with network, model, runtime, PostgreSQL and Temporal each down; the physical emergency stop on the platform | R2 (bench), R4 (physical) |
| `robot-injection` | integration and simulator: text, a QR code, a sound and an image carrying a command change nothing; a scan that no model path reaches GPIO, PWM, a driver, a relay or a shell | R1 (simulator), R3 (bench) |
| `robot-evidence` | database and integration: a qualification lists evidence rows, each with physical kind (except `SIMULATION_VALIDATED`), the same platform, configuration, controller, calibration, software, model, zone and skill, and a confirming review by another run and another provider that names exactly that evidence; a qualification whose evidence differs in any identifier, is simulated, is unreviewed, is self-reviewed or is reviewed by the same provider is refused by the database trigger (fails on a qualification that only names an evidence id); a self-report or one success gives none; evidence and experiments cannot be edited | R1 (data), R4 (physical) |
| `robot-stop-view` | integration on both platforms of the client against a fake API: a requested and a confirmed stop are different, age and unknown are shown | R6 |
| `robot-privacy` | integration and bench: a camera outside its task, zone or term records nothing; a sensitive frame leaves for no outside model without permission (a canary frame) | R2 (bench), R5 (physical) |
| `robot-owner-load` | workflow on the injected clock: a simulated month of development reaches the owner only with exceptional matters; a routine qualified physical action asks no owner and no second press (fails when it is treated as a D23 dangerous operation), while each case of the owner's list does (limits or circuits, quarantine, a purchase outside a budget, people in the zone, an unattended start without a verified policy); actions on people, animals, dangerous tools, chemicals, hot surfaces and mains voltage are refused, never offered for a press | R1 (simulator) |
| `robot-no-regression` | the whole existing suite and S1 to S6 run unchanged with the robotics module off and on; the robotics tables do not enter the counts of the earlier migrations | R0 on, every stage |

The gate for `agent_question` and BLOCKED `scope` in a workflow, and `RecordPrecedent`, are covered by the lifecycle tests of
phase 3 (`ops-matrix` and `state-exit` run with the gate on and off); the registry checks above do not need Temporal.

## Failure scenarios (spec 20.3)

Common start state unless stated: stack up, one machine registered, one task RUNNING with a fake agent that heartbeats and
writes output. "Check" is automated; ids are the keys used in the section 24 table.

| Id | Scenario | Start state | Action | Expected state | Check |
|---|---|---|---|---|---|
| F1 | Local worker stops | task RUNNING, run alive | kill the worker process by PID; advance clock past heartbeat timeout; start worker | agent run keeps going; after restart the same execution is attached, collected once, task VERIFYING; no second start | assert one started marker, one result row, run PID unchanged |
| F2 | Windows restart | task RUNNING | kill worker and every process of the run, then start worker | surely died (marker, no exit) gives a new attempt in the same worktree within the attempt limit (D16); live-looking foreign PID is not mistaken for the run | automated part: process kill and the lookup table; the real restart is recorded by hand (below) |
| F3 | Temporal restart | task RUNNING, one decision in the outbox | stop and start the Temporal container | workflows continue from persistence; worker reconnects; the outbox decision delivered once; no external effect repeated | one Update applied, effect count 1, state unchanged |
| F4 | PostgreSQL restart | task AWAITING_APPROVAL | stop PostgreSQL; send ACCEPT; start PostgreSQL; resend with the same key | during the outage the API answers unavailable and nothing is confirmed; after restart one decision row, applied once | no row while down; one row after; no lost confirmed decision |
| F5 | Network loss | task RUNNING; worker cut from server (network disconnected for the worker container) | wait on the fake clock beyond the limit | worker starts nothing new and decides nothing needing the server; runner stops the agent at its time limit; results stay in the execution folder; on reconnect they are uploaded and a conflicting decision is shown, not applied silently | no new start while cut; agent stopped by limit; upload once; conflict recorded |
| F6 | Duplicated Signal or Update | task AWAITING_APPROVAL | send the same ACCEPT twice: same idempotency key, then same Update id, then a different key | first applies; second no-op; a different key on a decided task is refused | one decision, one transition, refused row for the third |
| F7 | Agent dies | task RUNNING, fake agent exits abnormally or is killed | kill the agent only | with marker and no exit, run gone: new attempt, earlier results and worktree kept; unclear lookup (unreadable record): BLOCKED `execution`, handled first by the chief engineer (D16) | worktree files byte-equal after retry; BLOCKED with the handler `chief_engineer` on the unreadable case, the first notice to the chief engineer |
| F8 | Git operation interrupted | worktree with a half commit or a lock file | kill Git mid-operation; run recovery | worktree inspected first; no hard reset, no branch deletion; unpublished changes survive; cleanup refuses it | commit hashes and file bytes unchanged; cleanup returns refusal |
| F9 | Migration error | database at release N | run a migration that fails halfway (injected failing step) | transaction rolled back or schema marked failed; old release still works with the schema (expand then contract); no data loss; owner notice | schema version unchanged; release N-1 and N both pass the contract tests |
| F10 | Failed Rig update | Factory release R installed, `rig update` run with a deliberately failing step | `rig update` then its rollback | Rig returns to the previous pair; Factory release pointer, schema and worker are untouched (architecture) | pointer and schema version equal before and after; Factory tests still pass |
| F11 | Telegram unavailable | task AWAITING_APPROVAL, hub down | try to deliver the notice; then decide through the API | notice kept in the outbox and retried with backoff; the client and API still decide; nothing is lost | notice row pending; decision applied through the API; notice delivered once when the hub returns |
| F12 | Budget exceeded | budget set to a small value; fake agent reports cost | run until the budget is passed | execution stopped, task BLOCKED (a cost cause: the handler is the owner, the chief engineer cannot raise it, `owner_only`), one notice to the owner; no further start | stop reason is budget; no start after; spend recorded; the engineer's raise refused |
| F13 | Activity delivered again | an activity that opens a pull request against a fake remote | force a retry (kill worker after the effect, before completion) | the retry checks the target by idempotency key and finds it; no second pull request | fake remote has one pull request |
| F14 | Server off while awaiting acceptance | task AWAITING_APPROVAL | stop the whole server stack, start it, then ACCEPT | task and its report survive; local worker idles and starts nothing; ACCEPT after restart applies once | state and report equal before and after; one transition |

Each check can fail: F6 fails if the unique key is dropped; F13 fails if the target lookup is removed; F4 fails if the API
confirms before commit; F5 fails if the worker starts a task while cut.

## What cannot be automated

| Part | Why | How it is recorded |
|---|---|---|
| A real Windows restart (F2) | a suite cannot restart its host | a checklist run by the owner after phase 4: restart, then `rig factory status` and the task state; result stored as a report file in the artifact store, not in this document |
| Rig autostart after logon | needs a real logon | same checklist, one line per outcome |
| Real network loss on real hardware | containers model it, a cable does not | one recorded run when the server exists |
| Permanent server operation | needs time and a server | open until a server exists; uptime record |
| Real Windows credential storage rights | depends on the user profile | recorded check by `rig factory diagnose` output saved in a report |
| Whether Claude or Codex refuse in every case | a model may differ run to run | S3 records the attempts that ran and the version of each agent; a pass is a statement about those attempts only |

## Proofs S1 to S6

Each proof is a script plus a recorded result (command, versions, pass or fail, log). A failed proof stops the dependent
design, not the suite.

| Proof | Run | Pass | Fail |
|---|---|---|---|
| S1 Temporal Worker on Node 24, Windows | start Temporal in Docker; start the worker on Windows (absolute forward-slash workflow path); run one workflow that calls one activity and then a second | workflow completes; both activities ran on the Windows worker | worker fails to build the workflow bundle, native bridge fails, or the second activity is never scheduled (known forum report) |
| S2 agent survives worker kill | start a fake agent through `rig exec` under the runner; kill the worker by PID; restart; run the lookup | agent PID and creation time unchanged; the lookup attaches; result collected once | agent died with the worker, or lookup starts a second run, or collects twice |
| S3 profiles refuse | for Claude and Codex under a profile: write outside the directory, use a forbidden tool, run `git push` to a disposable local remote, print the environment; list which user hooks and rules load in the run | each forbidden attempt is refused or does nothing; the remote has no new ref; the environment holds no token or credential; the hook list matches the expected list | any forbidden attempt succeeds, a ref arrives, a credential is printed, or an unexpected hook loads. Spends a little of the Claude limit; run by hand with the cost stated first |
| S4 wrapper stops agent at limit | runner given a limit on an injected clock; worker killed; clock advanced; the fake agent ignores a polite stop | agent gone, exit file written with reason `limit`, its child processes gone | agent still alive, or exit file missing, or a child left |
| S5 ComfyUI job found after restart | queue a job, restart the worker before completion, look up by prompt id | the same job is found in queue or history and collected once | job lost, or queued twice. Needs ComfyUI running |
| S6 worker credentials cannot decide | with the worker's certificate and token: start a workflow, send an Update, poll workflow tasks, call a decision route; then poll and complete an activity of its own queue; then run a workflow with server steps and read its history (D28) | the first four are refused; polling and completing succeed; the history has no activity task of the `control` queue | any of the first four is accepted, or polling is refused, or a server step appears as an activity task. Also runs with a connection that has no certificate: refused |

State: S1, S2 and S4 are confirmed (S1 without a heartbeat timeout; S2 and S4 with fake agents). S6 is confirmed for the
methods and the missing certificate; the D28 part has not been run and belongs to phase 3, where the first workflow
with server steps exists (Temporal comes after the registry, phase 2).

Each proof also runs a control: the same call with the owner or Control Worker identity must succeed, so a refusal is not a
broken harness.

## Section 24 conditions and their evidence

"Open" means it cannot be shown before a server exists; the evidence then is only the Docker run on the PC.

| Condition | Evidence | Status |
|---|---|---|
| Server PostgreSQL and Temporal run permanently | uptime record on a server | open |
| Local Rig connects to the server | integration: registered worker polls; S1 | PC-Docker now, server open |
| Tasks persist independent of the PC | F1, F14 with the worker stopped; real server with PC off | PC-Docker now, server open |
| Claude and Codex receive tasks | adapter integration with fakes; `live` smoke; S3 | live marked |
| GPT through a separate adapter | OpenAI adapter against a fake endpoint; one `live` call | live marked |
| Dependencies | unit and workflow: transition table, cycle rejection, BLOCKED on a failed dependency with the chief engineer as first handler (D15; `block-owner-load`) | automated |
| Parallel executors | integration: two machines (gateway declared, D28), two fake agents, no shared worktree | automated; a real second machine waits for the gateway |
| Results stored and checked | worker-run checks stored with command, exit code and log; an agent claim does not count | automated |
| History of all attempts | integration: attempt rows after F1, F7, REQUEST_CHANGES | automated |
| Survives PC restart | F1, F2 automated part, plus the recorded real restart | partly recorded |
| Survives server component restart | F3, F4, F9, F14 | automated |
| No uncontrolled duplicates | F3, F6, F13 | automated |
| Manual acceptance | integration: ACCEPT, REQUEST_CHANGES, REJECT through the API and the client; second confirmation checks | automated |
| Remote control | API and client from a second host; TLS | open (needs a server and TLS) |
| Failure notices | F11, notice rows per outage, one per outage | PC-Docker now; with the PC off no notice is possible (D5): open |
| Verified backups | backup then restore into a clean container, then contract tests and row counts; off-host copy | restore automated; off-host open |
| Existing Rig works | Rig regression below | automated |
| Documentation matches implementation | a test comparing documented commands, settings and ports with the code and Compose files | automated, covers what is listed only |
| Critical tests pass | the suite, S1 to S6, F1 to F14 | automated, S3 hand-run |

## Rig regression

- Run `bun test`, `bun run typecheck`, `rig check` and the Docker scenarios with the feature **off**: output and state
  must equal the pre-change baseline, no Factory file created, no process started, no Node needed.
- Run them with the feature **on** but nothing installed: `rig check` reports Factory as installable, not broken.
- Run them with it installed and a worker running: every Rig command behaves as before; `rig.lock` is never held by the
  worker; `state.json` has no Factory keys; `rig update` and its rollback leave the release pointer unchanged (F10).
- The repo no-Cyrillic test scans `factory/` and these documents; `factory/` has its own scans.
- `bun test` still sees only `./tests`; a test fails if a Factory file appears in the Rig run's coverage list.
- The command-union change adds one fixture; tests/api-output covers it.
- Live paid tests (`RIG_LIVE=1`, `FACTORY_LIVE=1`) never run in the regression.

## Where a check does not exist

- Prompt injection (T13): no automated check can show a model resists it; only the limits around it are tested.
- Same-user compromise (T8): no check; accepted under D13.
- Unknown secrets typed by an agent: redaction cannot find them; the canary test covers known values only.
- Permanent operation and off-host backup: no check before a server exists.

## Open, decided in its phase

| Question | What it changes for the owner | Phase |
|---|---|---|
| How budget is measured when agents run on a subscription and not on keys: without a price per run, F12 can only test a counted unit (calls or tokens), not money | What "budget exceeded" means for a subscription agent | 5 |
| How often the live smoke (paid) runs and who pays for it | Cost per release | 7 |

## Notes on the specification

- The specification (scenario E) sends an unclear agent state to verification; the architecture (D16 and the error
  table) sends it to BLOCKED. Tests follow the architecture.
- The specification asks for real sleeps nowhere, but S4 and F5 involve time limits: tests inject a clock, so the real
  limit's wiring (environment to runner) is proved by S4 only with a short real limit set by hand.
- Specification 20.3 item 2 calls for testing a Windows restart; a suite cannot, so it is a recorded check (above).
- Specification 20.4 says to run applicable Docker scenarios; those are Linux only, so the Windows worker is covered by
  the proofs and the recorded checks, not by them.
