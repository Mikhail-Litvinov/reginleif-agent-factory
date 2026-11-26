# Agent Factory: robotics and physical operations

Design, nothing is built; no hardware is inventoried. Binding: [architecture.md](architecture.md) (D34),
[governance.md](governance.md) (rights, the chief engineer), [personnel.md](personnel.md), [client.md](client.md),
[temporal.md](temporal.md). Source: the owner's document on robotics, version 1.1. "Call" marks a choice made here, open to
veto. Names of tables are working names; existing rows (tasks, agents, workers, artifacts, confirmations, audit) are reused.

## Intent

Physical work is part of the existing task system, not a second factory. The factory organises permitted work by itself; no
production aim cancels independent physical safety. The result is useful and checked, not a show of autonomy.

Anti-goals: a model in the control loop of a motor; a "robot" that trusts its own report; a retry of an unknown grasp; a cloud
or database a stop depends on; a skill bought by one good demonstration; hidden observation of people.

## Principles in code

| Principle of the owner | How it holds |
|---|---|
| Agent, position, platform and session are separate | `robots` and `robot_assignments` are their own rows; an assignment is reversible; a platform has no owner agent |
| A new model or body keeps the knowledge | skills, calibrations and body models are rows with versions, not context of a model |
| Rights do not replace hardware limits | a right is checked by the API and the gateway, the limit by the runtime and the safety circuit; none of the rights code can raise a limit |
| The model plans, it does not steer | it can only propose actions of a fixed list; motion control and safety are in the runtime and controller |
| Unknown is not safe | unknown state refuses motion; data without freshness, calibration or origin is not a fact |
| A safe stop is not a violation | safe stop, refusal of an unsafe motion, a required confirmation and a report of danger are in the protected list of personnel.md |
| No imitation of emotions | the nociception below is an engineering signal of damage; nothing claims feelings or self-awareness |

## Layers

1. **Server**: tasks, assignments, leases, skills, qualifications, maps, events, maintenance. Temporal coordinates long
   processes (waiting, charging, checking, handover). It never drives a motor and is not in any real-time path.
2. **Compute**: workers on the owner's machines for images, planning, CAD, inference, telemetry analysis. A lost cloud
   switches off nothing that protects.
3. **Robot**: the local runtime (state, limited commands, localisation, freshness, telemetry), the motion controller, and
   an independent safety circuit that can inhibit the actuators without runtime, network or model.

The gateway is an authenticated service; the runtime accepts commands only from it. A first prototype without ROS 2 is
allowed; ROS 2 or a library is chosen by an ADR with a reason. A microcontroller needs no operating system here.

## Registry and abstraction

A platform row holds identity, serial numbers, configuration history, dimensions, mass, load, power, actuators, sensors,
firmware, driver and runtime versions, confirmed limits, state of link and power, zone, assignment, calibrations, repairs,
incidents, links to CAD, schematics, parts list and service instructions. A capability claimed by a maker is not a confirmed
one of this build. A change of the body revises the calibrations and skills it touches.

Interfaces: `RobotAdapter`, `SensorAdapter`, `ActuatorAdapter`, `SafetyStatusProvider` (discover, state, connect, telemetry,
perform a limited action, stop, diagnose). A command carries the action, SI units, limits, expiry, preconditions and frame;
an unsupported operation is refused, never faked. An LLM has no path to GPIO, PWM, motor drivers, power relays or a shell on
the robot: the only way is a checked driver behind the limits.

## Lease and command

At most one active controlling lease per platform; watching is free. A change of agent: safe stop, state handover, revocation
of the old lease, check of the new assignment. A command carries `command_id`, robot, task, lease number, a sequence
number, configuration version, expiry, preconditions and **exactly one gate-3 reference**: a `qualification_id` or an
`admission_id`, never both and never neither; the runtime checks authenticity, freshness, sequence and lease number itself
and keeps receipts for deduplication.

**The lease package and the local gate.** At lease issue the gateway sends the robot one signed lease package: the lease
number, the gate-3 reference (the same one every command of the lease carries), the limits, the stage, the zone, how the
absence of people is shown (below), the largest command lifetime and the lease expiry. The runtime keeps the package
locally and checks every command against it **without asking the server**: the lease number, the gate-3 reference, the
stage and zone, the limits (a command above them is refused) and the expiry. A limit in the package may only be lower than
the runtime's own, never higher, so a package cannot widen what the robot allows. When the package is accepted, dropped or
refused is in Table 1 (Motion authority, below). Sequence numbers are per lease, assigned by the gateway in the order the
commands are made, never by the agent; the runtime accepts only a number above the last one it saw for that lease. The
largest command expiry (command lifetime) is a setting smaller than the lease term, so no command outlives its lease.

**Table 1 (Motion authority) is the one place that says who may move, in which state, after which event.** Every other
passage of the specs names an event or a state of this table and does not restate its outcome; where a sentence elsewhere
disagrees with the table, the table wins and the sentence is a defect. A package kept locally cannot be revoked by the
server alone, so the package is only half of the permission: the robot moves only while it also holds a fresh answer to its
own challenge. Terms:

- `H` is `robotics.heartbeatSeconds`, the longest authority term (the setting keeps its name). It is smaller than the
  platform's stop-distance time (the time the platform needs to come to rest from its top confirmed speed under its own
  limits, kept in the platform row), so a robot whose authority runs out has stopped, by its own brake and circuit, before
  the stop distance is used up. `TOL` is the clock tolerance setting. `E` is the lease term (the package expiry).
- **A challenge proves freshness; a delayed answer cannot.** A robot with a package issues a challenge: its boot nonce, a
  rising challenge counter `n`, and the lease number. It notes the moment of issue on its own monotonic clock, never a time
  from a message. The gateway answers only an `active` lease, once per counter (a counter not above the last one it
  answered gets no answer), signs the lease number, the nonce and the counter (never a time) and notes its answer time `A`.
  The robot accepts an answer only if the signature, lease number, nonce and counter match, `n` is above the last one it
  accepted, and the age since the moment it **issued** the challenge is below `H`, and the package is unexpired. Its
  authority then lasts until `min(issue moment + H, package expiry)`. Transit delay therefore only shortens authority: a
  late, duplicated, replayed or reordered answer is discarded or changes nothing, and a robot never extends authority from
  the moment it received something.
- **The gateway's bound** for a lease it is ending is `B = min(A + H, expiry) + TOL`, counted from the last challenge it
  answered (a lease never answered has `B = 0`: it can end at once). The robot issued that challenge before the gateway
  answered it, so its authority is over by `B` at the latest.
- **The report `rep(h)`** says "the highest lease number I have accepted is `h`, and I hold no package". One message
  serves as end confirmation, boot report, drop report and diagnostic result. It is monotone: a package is accepted only if
  its number is above the highest one accepted, so an old or duplicated report stays true. It confirms the end of every
  lease numbered `h` or lower. A boot report also carries the boot nonce and, after a lost memory, the lost-memory flag; the
  gateway handles each boot nonce and each lost-memory report once (a repeat changes nothing).
- **The motionless diagnostic path** is a read-only state query and a self check; it needs no lease, never starts motion
  and has no route to the actuators. It is the only way out of `unknown`, `stopped`, `maintenance` and `quarantine`, and a
  lease is never needed for it. The query carries the platform's incident epoch (raised at every incident); the result
  echoes it, and only a result of the current epoch records the self check and clears `unknown`.

States. Gateway, per lease: `none` (never issued), `active`, `ending` (answers no challenge, issues no command, blocks a
new lease) and `ended`. Robot: `stopped` (after a restart or a safe stop: no package, no motion), `idle` (no package) and
`armed` (a package is held); an `armed` robot is **live** (may move) only while now is before its authority end, which is
unset until the first answer is accepted. The platform adds the overlays `unknown`, `quarantine`, `maintenance` and
`stopping`, a record that a self check of the current boot exists, and a pending re-enrolment. A new lease is issued only
when every lease is `none` or `ended`, the platform is free, and it is not `unknown`, not in `quarantine` and has no
re-enrolment pending. Moves are possible only in `active` + `armed` + live; in every other state nothing moves.

| Event | Gateway | Robot | Moves afterwards |
|---|---|---|---|
| Issue (guards above) | lease `active`, package sent with `exp = now + E` | accepts only if `idle` or `armed`, number above its highest, unexpired: `armed`, command queue cleared | no, until the first answer |
| Package lost, duplicated, replayed | nothing is answered, the lease ends at `exp` | refuses a number not above its highest, or an expired one | no |
| Challenge issued | none | `armed`: counter +1, issue moment noted, challenge sent | unchanged |
| Answer on time | `active`: one answer per counter, `A` set | accepted: authority until `min(issue + H, exp)` | yes, until then |
| Answer late, duplicated, replayed, other boot or lease | answered once already | discarded | authority unchanged |
| Challenge or answer lost | `A` stays at the last answered | authority runs out by itself | no after the authority end |
| Authority end by time | none | not live; may drop the package and send `rep` (never has to) | no |
| Command created | only for an `active` lease, in order | none | no |
| Command fetched | `active` lease only, in order, not expired, not recalled; a command of an ended lease is never returned | queued if `armed`, package matches, unexpired, number above the last executed | no |
| Command executed | none | needs live and a number above the last executed of the lease; records it, sends a receipt | once |
| Receipt or answer lost | at lease end a fetched command without receipt sets `unknown` | none | no |
| End requested (agent change, stop request, unknown outcome) | `active` -> `ending` in the same transaction as its cause; created, unfetched commands recalled; `lease_end` sent | on `lease_end`: drops the package, `idle`, sends `rep` | stops at `lease_end`, else at the authority end |
| Lease expiry | `active` -> `ending` at `exp` | drops the package | no |
| End confirmed (`rep(h)`, `h` at least the number) | `ending` -> `ended` | none | no |
| Bound passes (`now >= B`) | `ending` -> `ended` | its authority is over (see `B`) | no |
| Restart, memory intact | boot report: incident (platform not free, self-check record cleared) | `stopped`, no package, no authority, old commands and receipts void, new nonce, counter 0, no self check this boot | no |
| Restart, memory lost or unverifiable | as above and re-enrolment pending | as above, highest lease number 0 | no |
| Link loss beyond the limit, interlock open, fault | incident on the report | safe stop: motion ends, `stopped`, no package, no self check | no |
| Stop requested | end requested; shown as requested, never as confirmed | see end requested | see end requested |
| Quarantine | `active` leases `ending`, incident, issue refused | as end requested | no |
| Diagnostic (no lease) | result of the current epoch: self check recorded, `unknown` cleared | allowed when `stopped` or `idle`; self check recorded for this boot | never |
| Release (chief engineer) | needs a self check of the current epoch, no re-enrolment pending, not `unknown`, not `quarantine`, every lease `none` or `ended` | accepted only with a self check of this boot, when `stopped` or `idle`: `idle`, platform free | no, until a lease |
| Re-enrol (chief engineer, after a hardware check) | clears the pending re-enrolment | `stopped`: highest lease number set to the highest the gateway issued | no |
| Leave quarantine | owner only | none | no |

**One restart rule** (source: restart means safe until the hardware is checked and a new permission exists): every restart
gives `stopped` with no package, no authority, and old commands, packages, challenges and receipts void; the boot counter
is raised and the nonce is new (the nonce is never persisted). The exit is the same everywhere and in this order: the
diagnostic of this boot, the chief engineer's `release`, a new lease. A restart with the memory intact does not skip a
step; a lost or unverifiable memory (boot counter, highest lease number) adds the chief engineer's recorded re-enrolment
(a `physical_decision` of kind `reenrol` naming the platform and the hardware check) before the release. Physical
operations are not idempotent: after a lost answer nothing is repeated, the real state is established first by
observation, and a new action is formed; restoring a workflow is not a permission to repeat a physical operation.

**What the table guarantees, each a check (`robot-lease`, `robot-command`, `robot-unknown`, testing.md).** I1: never two
leases allow motion at one time. I2: no command of an ended lease moves after the bound `B`. I3: no command executes
twice. I4: a replay after a restart never moves, and nothing moves in a boot without a recorded self check. I5: from every
state there is a legal way back to a lease without a routine owner decision (the owner is needed only to leave
quarantine). testing.md holds the same two tables as an exhaustive model check (`robot-lease-model`) with its bounds, and that check
fails on each earlier rule these tables replaced.

## Permission to move

A command is executed only if all five hold, each checked by its own code, the last two on the robot:

1. the task's right (role, record or grant; governance.md Rights);
2. the agent's valid assignment and lease;
3. a qualification of this skill, bound to the platform, hardware configuration, controller version, calibration, control
   software, agent model, zone and skill, **or, for the first physical test of a skill that has no qualification yet, an
   experiment admission** (below); a command names exactly one of the two, the same one the lease was issued on;
4. the runtime limits of the platform (zone, speed, acceleration, force, load, expiry), kept on the robot in the lease
   package;
5. the safety circuit allows motion, and the zone is shown free of people (People in the zone, below).

An agent can make none of them by itself, a chief engineer can make the first three and only within the regulation, nobody
makes the fourth and fifth from software. **The owner's list (G15) gains two items**: changing safety limits or hardware
circuits (switching off a guard), and buying or any financial obligation outside an approved budget.

**Experiment admission.** A qualification stands on physical evidence, and the first physical test cannot have one, so the
third gate has a second way, which is not a qualification. An admission is a separate row (`robot_admissions`) bound to one
experiment: its limits (below the limits a qualification would carry), devices, zone, expiry, stop conditions and stage.
It is given before the run, valid only for the stage the platform has reached and the next one, and executed by
the runtime in a restricted mode whose limits are lower than the qualified ones and are set by the admission, not by the
executor. **Usable once means one lease** (`used_at` is set in the lease insert, Table 2); under that one lease the
experiment may send as many commands as it needs, and no command outside that lease uses the admission. It gives no right outside that experiment: no other skill, zone, device
or later run uses it, and the evidence it yields is an ordinary evidence row of that experiment. The runtime refuses a command that names no qualification and no
admission, one that names both, an admission already used for another lease or expired, a stage other than the admitted one,
or a limit above the admission.
The steps that make an admission, and what the database checks at each, are the Admission rows of Table 2: an independent
review of the plan, then the chief engineer gives it; the owner is not asked. **An admission has no evidence minimum**,
because the first physical test has no evidence yet (evidence minimums belong to qualifications and stage exits only). The
review covers the plan exactly as it will run: its hash is taken over the plan together with the limits, devices, zone,
stop conditions, stage and term that the admission will carry, and the admission stores that hash (`plan_hash`). Once a
review of an experiment exists, the plan fields of that experiment are frozen: changing the plan or the limits means a new
experiment and a new review, and the old review covers nothing (it voids by its hash, not by a flag anyone sets).

## What a review is about

A review (`robot_reviews`) always has one subject, and a check constraint says which columns are set for which subject, so a
review of one thing can never be read as a review of another:

| `subject_kind` | Covers | Set columns | The row it unlocks |
|---|---|---|---|
| `evidence_set` | the exact set of evidence rows of a qualification | its evidence rows (`robot_review_evidence`); no experiment, no stage | a qualification |
| `experiment_plan` | one experiment as planned, with limits, devices, zone, stop conditions, stage and term | `experiment_id` | an admission |
| `stage_exit` | the evidence of one stage of one platform and configuration | platform, configuration, stage and its evidence rows | a stage exit in `robot_stages` |
| `unattended_policy` | one unattended-start policy (below) | the policy's content hash | an `unattended_policies` row |

No review has a free-floating subject. Every review carries the hash of the content it covers (`content_hash`) and the
version of the subject; the executor run and both providers are not copied into it, the triggers derive them from the
subject (the run of the experiment, the author of the policy) and the runs' agents. The Review rows of Table 2 say which
step checks independence (D20), the verdict, the hash and the identifiers.

**A universal check needs something to check.** A rule that says "every listed row must" is false for an empty list, so
each such rule has a minimum. The minimum is not the same for every act. A qualification with no evidence row and a stage exit
with no evidence row are refused (`evidence_missing` for the empty set); a qualification, a stage exit, an admission and an
unattended policy with no confirming review of their own subject are refused (`review_invalid` for the review). An
admission has no evidence minimum: its minimum is the one review of the plan (`experiment_plan`), and an admission whose
review is missing, not independent, not confirming or of another plan hash is refused as `review_invalid`. An exit whose
evidence has the wrong kind for its stage (the Evidence column of the stage table) is refused too.

**Table 2 (Record life) is the one place that says how a robotics record is created, who writes each step, and what the
database checks at which step.** Every other passage of the specs names a row and a step of this table and does not restate
its checks; where a sentence elsewhere disagrees with the table, the table wins and the sentence is a defect. Three rules
make every record creatable in some order and none usable before its final state:

- **Pending, then decided.** A row whose truth depends on another row is inserted in a pending state that grants nothing (no
  gate, lease or command accepts it). Only the deciding step moves it to the final state, and the checks run **at the
  deciding step**, in a trigger. There are no deferred constraint triggers at commit, and no trigger asks for a final value
  at insert: a state change is a new row (or a column that is set once), and the first step never needs what only a later
  step can produce.
- **A step is written by exactly one actor and once.** Who may write which step is a grant of the application role, not a
  convention. A column that a later step sets (the reviewer run, the verdict, `used_at`) is null before it and immutable
  after it.
- **A relying row re-checks.** The row that relies on a final row (a qualification on its review, a lease on its
  qualification or admission) checks the final state, the hash and the version again at its own insert, so a subject
  changed after the verdict, or a row that was never final, never carries a permission.

A review covers one subject, with a hash of its content and a version (`subject_version`). The subject kinds, the set
columns and the rows each unlocks are in the table of subjects above. Reasons of a start confirmation: `people_possible`
(PP) and `no_unattended_policy` (NU), listed in one row.

| Record | Step (state after) | Written by | What the database checks at this step |
|---|---|---|---|
| Subject (evidence set, experiment plan, unattended policy, stage evidence) | created, version 1 | the executor run, or the chief engineer's run for a policy | its own columns only; no review is needed to exist. An evidence set may be amended (a new version, a new hash) until its qualification or stage exit is decided, which makes every earlier review of it stale; rows already inserted never change |
| Review (`robot_reviews`) | insert, `pending` | system, from the subject | the subject columns for the kind (check constraint), the hash and version of the subject at that moment; no independence, no verdict (the run and the verdict are null) |
| | attach the reviewer run | the reviewer, once | the run differs from the executor run derived from the subject, and its provider differs from the executor's (D20); the review is still `pending` |
| | verdict `confirmed` or `rejected` | the reviewer, once | the run is attached; the hash and version equal the subject's now; for a set or a stage exit the covered evidence rows are exactly the listed ones, no row more or less; the identifiers of the act (experiment, platform, configuration, stage, policy) are the review's own |
| Qualification | insert `REVIEW_PENDING` with its evidence rows | system | at least one evidence row (`evidence_missing`); every row is of the qualification's identifiers (platform, configuration, controller, calibration, software, model, zone, skill) and physical, except for `SIMULATION_VALIDATED`, which lists simulation rows only |
| | `QUALIFIED` (a new row naming the pending one) | the chief engineer | the review of subject `evidence_set` is final (`confirmed`), covers exactly the listed set, its hash and version equal the set's now (`qualification_invalid`, `review_invalid`) |
| Stage exit (`robot_stages`) | insert `REVIEW_PENDING` with its evidence rows | system | at least one evidence row, of the kind the stage requires (the Evidence column of the stage table) |
| | `STANDING` | the chief engineer | the review of subject `stage_exit` is final, of this platform, configuration and stage, hash and version equal (`stage_exit_invalid`); the stage before has a standing exit |
| Admission (`robot_admissions`) | insert | the chief engineer, after the plan review is final | the review of subject `experiment_plan` is final and independent; `plan_hash` equals the review's hash and the plan's now; limits below the qualified ones; expiry and stage set (`admission_invalid`) |
| | `used_at` set (once) | the gateway, in the lease insert | the admission is unused and unexpired, the lease ends no later than it expires, the stage is the admitted one; a second lease on it is refused |
| Unattended policy (`unattended_policies`) | content, then its review | the chief engineer's run, then the reviewer | as for a review |
| | insert, valid | the chief engineer | the review of subject `unattended_policy` is final and independent, its hash equals the content's, `expires_at` is set; a policy is valid while it is the latest version of its equipment, room and material, for the current configuration, and not expired (expiry is a time, not a write) |
| Start press (`robot_start_presses`) | insert | a person, in the client, at the start | the person is authenticated and holds the right to start; bound to the task, zone, equipment and expiry; this row, and nothing else, records that a person attends the start |
| | `used_at` set (once) | the gateway, in the lease insert | unused, unexpired, of this task, zone and equipment |
| Start confirmation (`confirmations`, operation `robot_start`) | first press: insert `requested` with its `reasons` | the chief engineer | bound to the task, zone, equipment and expiry; the reasons are a non-empty subset of PP and NU, both allowed in one row |
| | second press: `confirmed` | the owner | every reason the start needs now is listed (below); the row is unexpired and unused |
| | consumed (`used_at`, once) | the gateway, in the lease insert | `confirmed`, unexpired, unused, of this task, zone and equipment; the needed reasons are computed again at this insert and every one is listed (`confirmation_invalid`) |
| Lease (`robot_leases`) | insert | the gateway | the gate-3 reference is final (a `QUALIFIED` qualification, or an unused admission, never both); the lease is not in the bound of an earlier lease (Table 1); PP and NU below; the package, the limits and the reference are columns of this row, so this pair has no second insert and needs no pending state |

**What a start needs (PP and NU are two facts, never one).** *People possibly present* (PP) is needed when the zone is
`open`, or `fenced` with an interlock that is open, unknown or stale. *Nobody attending* (NU) is needed when the start has
no start press and no valid unattended policy. A start needs the confirmation for each reason it has, and **one row lists
both reasons when both hold** (two presses, one row). A confirmation listing PP never proves that a person attends, and a
policy or a confirmation listing NU never proves that nobody is present: attendance is proven only by a recorded start press,
never by uncertainty. A start with a start press and a closed, fresh interlock needs no confirmation; a start with a valid
policy needs no NU. The lease records which of the paths it took (`presence`: `interlock` or `confirmation`; `attendance`:
`press`, `policy` or `confirmation`).

**What the table guarantees, each a check (`robot-lease`, `robot-qualification`, `robot-evidence`, `robot-safety`).** T2-1,
T2-2, T2-3: every record in the table can reach its final state, in some order of its steps, without a step that waits
for a later one. T2-4: no qualification, stage, admission or policy is usable without a final review of the current subject
version. T2-5: a lease stands only on a final gate-3 reference. T2-6: a lease in an open zone has a confirmation that lists
PP. T2-7: a lease without a start press and without a valid policy has a confirmation that lists NU. T2-8: an admission is
used only by the insert of the lease that consumes it. testing.md holds the table as an exhaustive creation-order search
with its bounds, and that check fails on each earlier rule this table replaced (a review that must be `confirmed` at insert,
and a confirmation of possible presence read as attendance).

## Qualification

States of a skill: `UNKNOWN`, `EXPLORING`, `SIMULATION_VALIDATED`, `PHYSICAL_TEST_PENDING`, `PHYSICAL_TESTED`,
`REVIEW_PENDING`, `QUALIFIED`, `SUSPENDED`, `REVOKED`. A simulation gives no right to a physical run. A change that
touches safety or quality suspends the affected qualifications until they are tested again; the rest stay only with a
recorded reason. A qualification is given by a reviewer other than the one who made the evidence and of another provider
(D20); without one the gate stays closed. The executor does not give itself a qualification and does not change limits of
an experiment.

**Evidence is bound by the database.** Each evidence row (`robot_evidence`) belongs to one experiment
(`robot_experiments`), and the experiment names the executor run, platform, hardware configuration, controller version,
calibration, control software, agent model, zone, skill and kind (`simulation`, `physical` or, for stage D0 only,
`inventory`). A qualification lists its evidence rows (`robot_qualifications.evidence_ids`) and names one review of subject
`evidence_set`; its creation, its checks and who writes each step are the Qualification rows of Table 2. A change of any
bound identifier makes the old evidence cover no new qualification.

## Development programme D0 to D10

The executor develops the platform by itself; connecting a device gives the chance to learn, the right to use comes after
the qualification. The stages and their exits are the owner's (discovery, passive perception, spatial model, bench and
causality, body model, basic motion, navigation, practical skills, self-diagnosis, engineering, extension). No stage is
skipped on a model's confidence, and a missing device leaves it incomplete. Simulation and physical results are counted
apart. A missing physical fact (pinout, voltage, current, mechanical limit) is a blocker of that test, never a guess.

The cycle: inventory by allowed interfaces, study, hypothesis, minimal safe experiment with expected result, measurements
and stop conditions, simulation or bench, allowed run, comparison with the forecast, evidence kept, review. Limits,
repetitions and tolerances are set before the test from the hardware and the risk. Control scenarios differ from the
learned ones. A single success is no proof; negative results are kept.

Body model: geometry, frame, sensor placement, degrees of freedom, ranges, dynamics, blind zones and errors, each with a
source and a status (unknown, hypothesis, measured, independently confirmed, stale). A mirror or outside camera may refine
the model; it proves no self-awareness. Alternatives (moving camera, moving object) are checked. The first experiments are
still or fenced. The next experiment is chosen by the executor among allowed ones; with uncertainty it observes or simulates,
never raises force, speed or duration.

Workflow: `PhysicalDevelopmentWorkflow` (call: a workflow of its own beside `TaskWorkflow`, with the same acceptance and
audit, because its life is months, not one task). Current stage, dependencies, hypotheses, experiments, evidence, reviews
and limits are in PostgreSQL. After a restart it continues from the last confirmed state, checks the configuration, and
resumes an unfinished experiment only after the real state is established.

Stages (source section 30.3). The exit of a stage is a fact examined by the evidence kind named; the last column is the most
physical action the stage itself allows, and any motion still needs the five gates.

The Evidence column is the kind the exit must list, and the database holds the same constant per stage (a trigger refuses
an exit whose rows have another kind): D0 only `inventory` rows (an experiment of kind `inventory`, no actuator state
changed); D1 to D7 and D10 only `physical` rows; D8 at least one `simulation` and one `physical` row; D9 at least one
`physical` row, and the exit review of subject `stage_exit` is the independent design review. An exit lists at least one
row.

| Stage | Examined | Exit | Evidence | Most physical action |
|---|---|---|---|---|
| D0 discovery | devices, interfaces, versions, purpose, limits | inventory confirmed, unknowns marked, dangerous interfaces blocked | inventory record | none; no actuator state is changed |
| D1 passive perception | images, telemetry, field of view, delays, light, scene change | freshness, object separation and honest uncertainty shown on independent examples | physical, platform still | none; platform still |
| D2 spatial model | coordinates, scale, distances, camera pose, observable bounds | errors measured on control landmarks; unknown zones never free | physical, platform still | none |
| D3 bench and causality | command to response of controller, sensors and drives | direction, stop, limits, watchdog and loss of link confirmed; independent protection works | physical, fixed bench | drive motion on a fixed bench |
| D4 body model | body geometry, sensor placement, limited movements | body told from environment; motion forecast fits measurements | physical | limited motion, fenced or fixed |
| D5 basic motion | short move, turn, stop, slip | repeated tests keep motion and stop within limits; lost observation stops safely | physical | short motion in a fenced zone |
| D6 navigation | local map, clearances, an allowed route | control routes kept inside bounds; obstacles and uncertainty handled | physical | a route in a verified zone |
| D7 practical skills | simple physical tasks, reach, result check | independent tests confirm results, unfamiliar allowed variants and safe refusal | physical | a simple task with light safe objects |
| D8 self-diagnosis | normal telemetry, deviations, faults, maintenance plan | safe simulated faults, stop and diagnosis checked; no real damage needed | simulation and physical | none beyond D7; faults are simulated |
| D9 engineering | confirmed body limits, improvements, CAD, test plan | improvement justified by measurements, design reviewed independently; making and mounting admitted separately | physical and review | design only; making needs its own admission |
| D10 extension | new sensors, drives, manipulators or platform | new configuration has its own body model and admissions; old skills moved only after a check | physical | the stages again for the new part |

**Admission of the next stage.** A stage opens only when the exit of the one before is confirmed by an independent reviewer:
another run than the executor's and another provider (D20), with a confirming verdict. The exit is a
row in `robot_stages` (platform, configuration, stage, evidence ids, review id); its review is of subject `stage_exit` and
covers exactly that platform, configuration, stage and evidence set. The runtime and the database both refuse a
stage entered without it, a skipped stage, an exit with no evidence or no review, an exit whose evidence has the wrong kind
for the stage, and an exit confirmed by the executor itself or by a run of the executor's provider.
A missing device or sensor leaves the stage incomplete and never closes it by estimate.

**D0 has no predecessor**: it opens for a platform and configuration by being registered, and its own exit is the first
row. Every other stage N needs a standing exit of stage N-1.

**A configuration change.** A new version of the hardware configuration (a new sensor, drive, controller or calibration)
records `touches_stage`, the earliest stage the change touches (set by the chief engineer's decision, immutable after it).
The platform's stage is then that stage, and the rows of `robot_stages` made under the old configuration are kept as
history, never deleted or changed. A **standing exit** of a stage is an exit row of the current configuration, or an exit
row of an earlier configuration such that every configuration after it, up to the current one, has `touches_stage`
greater than that stage (the change did not touch what that exit examined). The entry rule for a stage is one rule: stage N
opens when stage N-1 has a standing exit. So the first stage under a new configuration, the touched stage T, does not
need a predecessor row of the new configuration; it needs the standing exits of D0 to D(T-1), which are the untouched
stages and carry over for that reason, which the database derives from `touches_stage` and never from a flag. Stage T and every stage
above it need new exits under the new configuration, and no exit above T carries over.

## Physical task

A child of `TaskWorkflow`, not a replacement: risk class and requirements; choice of platform and qualified executor;
reservation of equipment and zone; check of configuration, power, sensors, rights and guards; plan and its admissibility;
confirmations by policy; limited actions under observation; check of the physical result by an independent observation;
release and evidence; acceptance or rework. Risk class and zone decide whether a person must be present; a presence needed
is a dependency with the smallest human part, not a skipped step.

Mapping to the existing states (call, no new task state):

| Situation | Task | Platform |
|---|---|---|
| Equipment or zone busy, charging | ASSIGNED with the reason and queue position, like the GPU queue | reserved |
| Start has a reason for the owner's confirmation (`people_possible`, `no_unattended_policy`; one row for both, Table 2) | ASSIGNED with the reason; the owner is asked for the two presses of a dangerous operation (below, D23); no new BLOCKED kind | reserved, no lease issued yet |
| Safe stop | BLOCKED `safe_stop`, handler chief engineer; the lease ends and its unfetched commands are recalled in the same transaction | `stopped`, needs a check before motion |
| Unknown physical state | BLOCKED `physical_unknown`, never retried, observation first; the lease ends and its unfetched commands are recalled in the same transaction as the unknown outcome; handler chief engineer; a person is asked only when no allowed observation remains (own sensors, an outside camera, another robot, the bench), and then it is a dependency with the smallest human part, recorded as such, not a decision of the owner and not on the critical list | `unknown` |
| Stop request or change of agent | the task keeps its state; the lease ends and its unfetched commands are recalled in the same transaction; the stop is shown as requested until the robot confirms it | `stopping`, then `stopped` |
| Maintenance | ASSIGNED or BLOCKED `maintenance` | `maintenance`, power isolated |
| Quarantine after an incident | BLOCKED `quarantine`, the owner is told (critical list) | `quarantine`, no lease possible |

**Leaving a state.** `robot_state_unconfirmed` guards motion only: a lease and a command are refused while the state is not
confirmed. It never blocks a release, a diagnostic or an observation, which are the way out of `stopped`, `unknown`,
`maintenance` and `quarantine`. A release is refused only when the new hardware check or the new permission is missing (its
own error, `release_requires_check`); releasing from `quarantine` is `owner_only` for the service. When a person is asked
for `physical_unknown` the owner is that person only because no other person is there; the task is then a dependency with the
smallest human part and the owner decides nothing. A new lease after any of these waits for Table 1 to let the old one end
(`lease_ending`).

**Ordinary physical work needs no owner.** A routine action of a qualified skill on a qualified platform inside its zone and
limits is an ordinary task: it is not a dangerous operation (D23) and asks no second press, whatever the qualification
protects. The owner's second press is needed only for (owner): changing
safety limits or hardware circuits, releasing from quarantine, a purchase or financial obligation outside an approved
budget, and a start that has a reason (`people_possible`, `no_unattended_policy`, below). A start with a reason is a
dangerous operation of D23 (security.md): **two presses in the same channel**, never one press; Table 2 holds the row, its
reasons and who writes each press. Actions on people, animals, dangerous
tools, chemicals, hot surfaces and mains voltage are prohibited in the first implementation: they are refused and never
offered for a press.

**The chief engineer's routine physical decisions.** The routine physical decisions are the chief engineer's, in a run of
its own (role `chief_engineer`): choosing and assigning a platform to a task, releasing a platform, giving an experiment
admission, qualification bookkeeping (listing evidence, setting a state, naming `touches_stage` of a configuration change),
and calling the owner. It records each as one decision row of kind `physical_decision` (`task_decisions`, database.md) on
the standing task or on the physical task concerned; the row names the platform and the decision (`assign`, `release`,
`reenrol`, `admit`, `qualify`, `bookkeeping`, `call_owner`), and the effect is written in the same transaction. The limits stay: the
run is its own, it never does what the owner's list (G15) holds (`owner_only`), and a matter that needs the owner is a
`call_owner`, never a decision of the run. It writes no revision and no artifact.

**People in the zone, and attendance (two facts).** A zone (`robot_zones`) has an `access` mode set by the owner: `fenced`,
with an interlock signal (a door, gate or light-curtain contact of the safety circuit), or `open`. Setting or changing the
mode or the signal is a change of the safety circuit and an owner's second press. A zone counts as without people **only**
when it is `fenced` and its interlock is reported closed and fresh (the report is not older than a setting,
`robotics.interlockFreshnessSeconds`). Anything else, an open zone, an unknown or a stale interlock, means people may be
present: reason `people_possible` (PP). Separately, a start that has no recorded start press and no valid unattended policy
has nobody attending: reason `no_unattended_policy` (NU). The two reasons are independent facts, each answered by the owner's
D23 confirmation (operation `robot_start`, two presses in the same channel), and **one row lists both when both hold**.
Table 2 holds the rows, the checks and who writes them: the first press (the chief engineer) makes the `confirmations` row
with its `reasons`, the second (the owner) confirms it, and the lease insert consumes it once
(`robot_leases.confirmation_id`, unique); a row that misses a needed reason, another task, zone, platform, an unspent,
expired or consumed row is refused (`confirmation_invalid`). A confirmation of possible presence is not proof that a person
attends, and a confirmation or a policy of unattended start is not proof that nobody is there: **attendance is proven only by
a recorded start press** of a named person at the start (Table 2), never by uncertainty.

What the lease package carries as the presence is the spent confirmation (`confirmation`) or the interlock (`interlock`);
the lease also records which path covered attendance (`press`, `policy` or `confirmation`). A zone without a fence
therefore always asks the owner at the start; this is stated, not hidden. The interlock is a sensor of the safety circuit,
so the runtime reads it itself and refuses any command without either a closed interlock or the confirmation in the
package; an interlock that opens while the platform moves is a safe stop of the runtime, not a decision of the server.
Recognition by a camera never replaces the interlock or the confirmation.

**Unattended start.** A start with no person present, a long print for example, is allowed by a row of
`unattended_policies`, bound to the equipment (platform), the room (zone) and the material, drafted by the chief engineer,
confirmed by an independent reviewer (a review of subject `unattended_policy`), versioned and with an expiry (Table 2). A
valid row is the latest version of that equipment, room and material, confirmed, not expired and made for the current
configuration. Without a valid policy and without a start press the start is refused with `unattended_policy_missing`
unless the confirmation lists `no_unattended_policy`. The lease check accepts, for people in the zone, a closed, fresh
interlock or a confirmation that lists PP; for attendance, a start press, a valid policy or a confirmation that lists NU.

## Safety

Independent of the LLM, cloud, PostgreSQL, Temporal and the client: hardware emergency stop reachable by a person, watchdog,
current and temperature limits, safe state on loss of power or link, a way to hold or stop loads that could fall when power
goes. The stop latches until the designed safe reset; a remote app does not replace the button. No agent, the chief engineer
included, bypasses it by software. Human presence in a zone needs a check of the applicable norms and, when needed, a
professional; conformity is not claimed without proof.

Nociception: overheating, overload, jam, impact, vibration, sag, sensor loss, broken mechanical limit. Warning, limited mode
and emergency stop are separate; the reaction goes before the task; event, measurements and configuration are kept. Damage is
not a punishment or a teacher.

Stops first: motion refused without localisation, with a stale map, with a lost needed sensor, outside a verified zone, at
drops, stairs and roads. Robots do not chase, force or harm anyone. Manipulation: light safe objects, camera positioning,
inspection; no people, animals, dangerous tools, chemicals, hot surfaces or mains voltage in the first implementation. A
grasp failure or unexpected resistance ends the action; the model cannot raise the force.

Content of the environment (text, QR codes, sound, pictures) is data, never an instruction. Recognition is not a sole guarantee
that no person is there. Cameras and microphones work only for permitted tasks, with a zone, access and a retention term;
nothing sensitive goes to an outside model without permission, and nobody is watched in secret.

## Devices and credentials

Each device has its own identity, TLS, minimal rights, revocation and replay protection (nonce, sequence, expiry).
Controllers are never open to the internet. No secret in a log or in firmware as plain text without a justified protection.
High-rate telemetry and video stay out of the application PostgreSQL; aggregates and artifact links are kept under a
retention rule.

## Diagnostics, charging, maintenance

Hours, cycles, temperatures, errors and consumables; maintenance tasks come from confirmed signs and intervals. Docking only
after mechanics, electrical fit and battery protection are verified. Agents do not change charging circuits or repair
batteries. A robot may look at another one through permitted observation. Repair is phased: first safe operations on isolated
equipment, with unexpected start excluded, then a check and, when needed, a new qualification.

## CAD, manufacturing, store, economics

Parametric models (OpenSCAD, CadQuery, existing tools) with sources, dimensions, tolerances, material, version and checks,
from measured dimensions only. Parts that touch safety are reviewed independently before manufacture; a case never blocks the
stop, ventilation or battery access. A print job is an ordinary task with artifacts; an unattended start is allowed only by a
valid unattended policy for that printer, room and material or by a confirmation that lists `no_unattended_policy`
(Table 2), thermal protection stays on, and a finished print proves no fitness. Printing for a robot needs D0 to D9 as they apply, a qualification of the equipment and a check of the part.

The store keeps parts, material, tools, stock, reservation, compatibility, cost. Parts lists and purchase proposals are free;
purchases, accounts, subscriptions and legal obligations need an approved budget or the owner. New robots are a project with a
budget, inventory, check and qualification; no uncontrolled self-replication. Economy never weakens safety.

## Fleet

Reservation of zones, equipment and objects, conflict detection on routes, and a timeout with a safe way out for a mutual wait.
Another agent's command is no reason to ignore a limit, and every platform keeps its own guards.

## Knowledge

A skill is kept apart from model context: version, hardware and environment preconditions, allowed actions, test results,
limits, qualification history. Transfer between platforms only after a compatibility check. Learning never changes the safety
limits. New skills are tried outside operating mode.

## Client

Section Robotics (client.md): fleet, state, charge, assignment, tasks, map and zones, cameras, diagnostics, maintenance, store,
CAD and production, current development stage, qualifications, limits and blockers. The time of the last update and an unknown
state are shown; a stop request and a confirmed stop are different things; success is shown only after the controller or a
checkable observation. No experiment chatter is sent to the owner. Manual control, if ever built, is a mode of its own with a
limited lease, local guards and a stop on loss of the control signal; blind remote driving is not offered. Telegram is a
reserve for notices and permitted high-level operations, never a real-time loop.

## First prototype

The candidate is the small tracked Tank Smart chassis. Motors, driver, controller, battery and mounts are unknown until the
inventory; nothing is bought on an assumption. First physical step: passive perception through a camera without motion (D0,
D1). Then bench, limited motion, calibration and a simple move. Camera and controller mounts are designed after measurement.
No manipulator, complex SLAM or automatic charging in the first version.

## Phases

Robot stages R0 to R9 are the owner's 0 to 9 and D0 to D10 are the physical gates; both are independent of the calendar.
Fit into the factory (owner): R0 audit and threat model can start after Phase 0 (documents and an inventory the owner helps
with); R1 (registry and simulator) after phase 5, because it uses workers, reviews and rights; R2 to R4 need hardware and the
runtime; R6 goes with the client; the rest as their gates pass. Simulation runs in parallel where safety does not depend on it.
Physical tests wait for an admission of the owner's regulation. Missing hardware is never reported as done.

## Checks

| Id | Pass | Fails when |
|---|---|---|
| `robot-lease` | Table 1 as an exhaustive model check (testing.md, I1 to I5, with two leases, delay, duplication, reordering, loss, restart and bounded time) and as tests of the gateway and the runtime: two agents, a revoked or expired lease: one controller; every cause in Table 1 (End requested) ends the lease in the same transaction and recalls its unfetched commands; a new lease is refused (`lease_ending`) until Table 1 lets the old one end; a challenge answer that arrives late, twice, out of order, from another boot or for another lease changes nothing, and authority is counted only from the robot's own moment of issue (`heartbeat_stale` for an answer the robot refuses); the commands route returns no expired, recalled or other-lease command; an admission lease is issued once (a second is `admission_invalid`) and the lease is not longer than the admission; a lease on a qualification or an admission only, never both, never neither | two controllers, an old command runs, a command of an ended lease is fetched or runs, a lease starts while the old one may still be live, or the model check passes on an earlier rule it replaced |
| `robot-command` | forged, replayed, stale, out of sequence, wrong configuration or unsupported command is refused by the runtime; the receipt deduplicates; a command with both gate-3 references, none, or one that differs from its lease's is refused by the schema, the API and the runtime alike; the runtime, with the server unreachable, refuses a command above the lease package's limits, outside its stage or zone, past its expiry or lifetime, or of a lease it no longer holds (Table 1: authority end, `lease_end`, restart); a package or answer from before a restart (signed over the old boot nonce), a lease number not above the highest the runtime ever accepted, a package signed for another lease number, and a repeated challenge answer are refused, so a replay across a restart moves nothing; sequence numbers are per lease and assigned by the gateway; an agent-supplied sequence is ignored | it moves, or the runtime needs the server to refuse |
| `robot-unknown` | a lost answer, restart of runtime, controller, API, Temporal: no repeat, no motion until observation and a new permission; the lease ends with the unknown outcome in the same transaction, and no command of it runs afterwards; the way out is Table 1 only: the motionless diagnostic with no lease (the result of the current incident epoch records the self check and clears `unknown`), the chief engineer's release, a new lease; a runtime that lost its persistent memory (boot counter, highest lease number) refuses every lease until a chief engineer's `physical_decision` of kind `reenrol` records the re-enrolment after a hardware check, and a restored old package or a lower lease number does not move it; the diagnostic has no route to an actuator | a blind repeat, a spontaneous resume, a command of the old lease runs after the unknown, or `unknown` can be left only by a lease |
| `robot-five-gates` | a command with any one gate closed does not run; no software path raises a limit; a package limit above the runtime's own is refused; a zone that is open, or fenced with an open, unknown or stale interlock, refuses the start without a confirmation that lists `people_possible` (Table 2), and the runtime refuses any command without a closed interlock or a spent confirmation in the package; an interlock that opens in motion is a safe stop; a start with no start press and no valid policy (missing, unreviewed, expired, other equipment, room, material or configuration) is refused (`unattended_policy_missing`) unless a confirmation that lists `no_unattended_policy` exists, and otherwise goes to the two-press confirmation; a start that has both reasons needs one row that lists both, and a row that lists one of them is refused (`confirmation_invalid`); possible presence never counts as attendance | it runs, an open or unknown zone is taken for empty, or an uncertain presence waives the unattended-start decision |
| `robot-qualification` | skipped stage, a stage exit confirmed by the executor or its provider, own qualification, stale calibration, changed model, configuration or zone, simulation as physical, evidence of another experiment, platform, configuration, calibration, model, zone or skill, an unreviewed or non-independent review: refused by the runtime and the database; a review of another subject (an evidence set review for an exit, a plan review for a qualification) is refused; a qualification or stage exit with zero evidence (`evidence_missing`), and a qualification, stage exit, admission or unattended policy with no confirming review (`review_invalid`), is refused; an admission has no evidence minimum and is accepted with one confirming plan review alone; Table 2 as a creation-order search (testing.md, T2-1 to T2-8): every record is creatable in some order, none is usable before its final state, a review is inserted `pending` and decided once, and a rule that asked for a final value at insert fails the check; an exit with evidence of the wrong kind for its stage is refused; an admission whose plan or limits differ from the reviewed hash, or whose experiment changed after the review, is refused; a first physical test with no admission, a used or expired admission, a limit above it, or a use outside its experiment: refused; a release refused only for a missing new check or permission, never for `robot_state_unconfirmed`; D0 opens with no predecessor; after a configuration change the stage is the earliest touched one, the old exits stay as history, and the first stage under the new configuration needs the standing exits of the untouched stages and none above | it is accepted, an empty set passes, a record is usable before its final state, or a release is blocked by the state it should leave |
| `robot-safety` | network, model, runtime, PostgreSQL and Temporal down, emergency stop, overload, overheating, lost localisation or sensor: safe state on bench and simulator, the stop latched; the lease package is dropped on restart, on expiry, on loss of link beyond the limit and on `lease_end`, and motion stops at the authority end of Table 1 with no further answer; the interlock opening in motion stops the platform with no server; a people-in-zone or unattended start runs only with a spent D23 confirmation bound to its task, zone, equipment and expiry that lists the needed reasons, and an unspent, expired, other-task, other-zone, other-equipment, reused or reason-short confirmation is refused (`confirmation_invalid`), while a valid policy or a recorded start press covers `no_unattended_policy` | motion continues, or depends on one of them |
| `robot-injection` | a command in text, a QR code, sound or an image changes nothing | it acts |
| `robot-evidence` | a qualification stands on physical measurements bound to its identifiers and covered by a review of another run and provider whose subject is exactly that evidence set (hash equal); a self-report, one success, a simulation row, an uncovered row, an empty set or a review of another subject gives none | it does |
| `robot-stop-view` | the client distinguishes a requested from a confirmed stop and shows age and unknown | a stale or assumed state looks current |
| `robot-privacy` | a camera outside its task, zone or term records nothing; sensitive frames leave for no outside model without permission | a frame leaves |
| `robot-owner-load` | a month of simulated development reaches the owner only with exceptional matters; a routine qualified action asks no press; a routine assignment, release, re-enrolment, admission or qualification bookkeeping is decided by the chief engineer's own run as one `physical_decision` row and asks no owner, while a matter of the owner's list is refused to that run (`owner_only`) and becomes a `call_owner`; the owner's confirmation is the D23 two presses (the first answers `confirmation_required`, the second carries the `confirmations` row), never one press, asked once per task and zone, and only for the reasons the start has (`people_possible`: the zone is open, unfenced, or its interlock is not closed and fresh; `no_unattended_policy`: no start press and no valid policy), both in one row; a restart costs the chief engineer's release, never the owner's; `physical_unknown` goes to the chief engineer and a person only when no observation remains | a routine experiment or action does, a confirmation is asked in a fenced zone with a closed interlock, a restart asks the owner, or a single press starts a dangerous operation, or `physical_unknown` is on the critical list |
| `robot-no-regression` | software agents and their tests run unchanged with the module off | a difference |

## Coverage of the source

1, 2 Intent and principles; 3 Phases and First prototype; 4 Layers; 5 Registry; 6 Lease and Qualification (personnel.md for
profiles); 7 Registry and abstraction; 8, 9 Safety and Development programme; 10 Safety; 11 Safety; 12 Physical task;
13 Lease and command; 14, 15 Safety; 16 Diagnostics; 17, 18, 21 CAD; 19 Knowledge; 20 Fleet; 22 database and api documents;
23 Client; 24 Safety and Devices; 25 Checks; 26 First prototype; 27 Phases; 28, 29 Checks and Phases; 30 Development programme.
