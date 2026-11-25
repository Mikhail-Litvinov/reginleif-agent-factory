# Agent Factory testing

Design, nothing is built. [architecture.md](architecture.md) is binding (D1 to D30 are its decisions; "call" marks a choice made in these documents, open to veto); threats and their
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

Factory tests live in `factory/tests` with their own commands; the Rig suite never imports them.

## State, decision and queue checks

Table-driven where the rule is data; each can fail (a cell removed, a check dropped).

| Id | Check | Pass | Fail |
|---|---|---|---|
| `ops-matrix` | Walks the 16 states by the 12 decision kinds of [temporal.md](temporal.md) (the operations matrix); for each pair sends the decision to a workflow in that state | every cell has the stated effect (applied, or refused with one of `not_allowed_in_state`, `revision_stale`, `actor_not_allowed`, `already_resolved`, `block_kind_mismatch`, `task_closed`); no cell is empty or leaves the workflow stuck | a cell without an effect, an unknown refusal reason, or a state change outside the transition table |
| `state-exit` | For every state, the "every state has an exit" table: drive the task to the state, then take the stated exit | each state reaches a final state or its normal successor, CANCELLING and BLOCKED included (D21, D26) | a state with no exit |
| `decision-recorded` | Send a decision that must be refused (stale revision, closed task, wrong actor, wrong block kind) through the API | one `task_decisions` row, `refused` with a reason and a notice; the API answers 202, never an error for state | no row, or an HTTP refusal for a state fact |
| `decision-kinds` | The enum in [database.md](database.md), the API routes of [api.md](api.md) and the handler table of the workflow list the same 12 kinds (`allow_agent` included) | identical sets | any set differs |
| `second-press` | Each dangerous operation (`cancel`, `reject`, `force-close`, publication) with one press, with a second press in another channel, with an expired or reused one | only the same-channel second press inside the window is accepted, once | any other form accepted |
| `relay-press-once` | The relay submits the same `press_id` twice, and a press from an unmapped Telegram user | the first decision recorded; the second refused; the unmapped user refused | a second row for one press id, or an unmapped user accepted |
| `control-no-queue` | Run the lifecycle tests with the real Control Worker options and read the histories; compare the activity catalogue with the options (D28) | no history has an activity task of the `control` queue; every `local` row is reached through local activities; the Control Worker has `enableNonLocalActivities: false`; `act.<Name>.S` of each is below the workflow task timeout | one server step scheduled as an ordinary activity, or the option missing |
| `second-machine-refused` | Register a second machine, with and without the gateway declared in the deployment; register the first one again (D28) | without the gateway the second is refused `queue_isolation_required` and gets no work; the first may register again; with it the second registers | a second machine registers without the gateway |
| `gpu-order` | Several tasks request one machine's GPU slot with different priorities and request times, while one job runs | grants go by highest priority, then oldest request; one holder at a time; no preemption | a lower priority or a later request granted first, or two holders |
| `cleanup-command` | Cleanup of a final task, a task not final, a task awaiting approval, a worktree with unpublished changes; and a day count passing on the injected clock | nothing is deleted by itself; the command removes only files and keeps rows; refusals as listed in [database.md](database.md) | anything removed without the command, or a row deleted |
| `review-provider` | Review of a task whose implementer ran on one provider, with and without another provider eligible (D20) | another provider reviews; with none the task waits and a notice is sent | the same provider reviews |
| `check-not-run` | A mandatory check that cannot run (D26) | agents get a repair attempt; then BLOCKED `check_environment`; never AWAITING_APPROVAL | a `not_run` check counted as passed or sent to the owner as complete |

## Registry and regulation checks

The ten checks are defined in [governance.md](governance.md) (section "Checks"), each with its pass and fail criterion;
they are not copied here. They run on the disposable database and a fake clock like the rest, and a new one is first
shown failing on the broken code.

| Id | Level | Phase |
|---|---|---|
| `registry-first`, `registry-fail-open` | integration: API gate, the hub question hook as a fake command, a timeout on the injected clock | 2 |
| `registry-capture`, `registry-scope`, `registry-authority` | unit (order and scope rules as data) and integration (the relay press path) | 2 |
| `registry-not-a-guard` | integration: every permission prompt, profile and second press with and without a matching active record | 2 |
| `registry-history`, `regulation-change` | database (triggers, grants) and integration (two presses, version size, guard conflict) | 2 |
| `registry-search` | measured on a set of questions with the chosen model; also runs without the model (`degraded`) | 2 |
| `registry-import` | integration: Factory documents and project memories as input, a second run | 2 |

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
| F7 | Agent dies | task RUNNING, fake agent exits abnormally or is killed | kill the agent only | with marker and no exit, run gone: new attempt, earlier results and worktree kept; unclear lookup (unreadable record): BLOCKED | worktree files byte-equal after retry; BLOCKED on the unreadable case |
| F8 | Git operation interrupted | worktree with a half commit or a lock file | kill Git mid-operation; run recovery | worktree inspected first; no hard reset, no branch deletion; unpublished changes survive; cleanup refuses it | commit hashes and file bytes unchanged; cleanup returns refusal |
| F9 | Migration error | database at release N | run a migration that fails halfway (injected failing step) | transaction rolled back or schema marked failed; old release still works with the schema (expand then contract); no data loss; owner notice | schema version unchanged; release N-1 and N both pass the contract tests |
| F10 | Failed Rig update | Factory release R installed, `rig update` run with a deliberately failing step | `rig update` then its rollback | Rig returns to the previous pair; Factory release pointer, schema and worker are untouched (architecture) | pointer and schema version equal before and after; Factory tests still pass |
| F11 | Telegram unavailable | task AWAITING_APPROVAL, hub down | try to deliver the notice; then decide through the API | notice kept in the outbox and retried with backoff; the web panel and API still decide; nothing is lost | notice row pending; decision applied through the API; notice delivered once when the hub returns |
| F12 | Budget exceeded | budget set to a small value; fake agent reports cost | run until the budget is passed | execution stopped, task BLOCKED, one notice; no further start | stop reason is budget; no start after; spend recorded |
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
| Dependencies | unit and workflow: transition table, cycle rejection, BLOCKED on a failed dependency (D15) | automated |
| Parallel executors | integration: two machines (gateway declared, D28), two fake agents, no shared worktree | automated; a real second machine waits for the gateway |
| Results stored and checked | worker-run checks stored with command, exit code and log; an agent claim does not count | automated |
| History of all attempts | integration: attempt rows after F1, F7, REQUEST_CHANGES | automated |
| Survives PC restart | F1, F2 automated part, plus the recorded real restart | partly recorded |
| Survives server component restart | F3, F4, F9, F14 | automated |
| No uncontrolled duplicates | F3, F6, F13 | automated |
| Manual acceptance | integration: ACCEPT, REQUEST_CHANGES, REJECT through API and panel; second confirmation checks | automated |
| Remote control | API and panel from a second host; TLS | open (needs a server and TLS) |
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
