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
of the old lease, check of the new assignment. A command carries `command_id`, robot, task, lease number, configuration
version, expiry and preconditions; the runtime checks authenticity, freshness, sequence and lease number itself and keeps
receipts for deduplication.

Physical operations are not idempotent. After a lost answer nothing is repeated: the real state is established first, by
observation, and a new action is formed. After a restart of anything the robot stays in its safe state until the hardware is
checked and a new permission to move exists; old commands and expired leases are not restored. Restoring a workflow is not
a permission to repeat a physical operation.

## Permission to move

A command is executed only if all five hold, each checked by its own code, the last two on the robot:

1. the task's right (role, record or grant; governance.md Rights);
2. the agent's valid assignment and lease;
3. a qualification of this skill, bound to the platform, hardware configuration, controller version, calibration, control
   software, agent model, zone and skill;
4. the runtime limits of the platform (zone, speed, acceleration, force, load, expiry);
5. the safety circuit allows motion.

An agent can make none of them by itself, a chief engineer can make the first three and only within the regulation, nobody
makes the fourth and fifth from software. **The owner's list (G15) gains two items**: changing safety limits or hardware
circuits (switching off a guard), and buying or any financial obligation outside an approved budget.

## Qualification

States of a skill: `UNKNOWN`, `EXPLORING`, `SIMULATION_VALIDATED`, `PHYSICAL_TEST_PENDING`, `PHYSICAL_TESTED`,
`REVIEW_PENDING`, `QUALIFIED`, `SUSPENDED`, `REVOKED`. A simulation gives no right to a physical run. A change that
touches safety or quality suspends the affected qualifications until they are tested again; the rest stay only with a
recorded reason. A qualification is given by a reviewer other than the one who made the evidence and of another provider
(D20); without one the gate stays closed. The executor does not give itself a qualification and does not change limits of
an experiment.

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
| Safe stop | BLOCKED `safe_stop`, handler chief engineer | `stopped`, needs a check before motion |
| Unknown physical state | BLOCKED `physical_unknown`, never retried, observation first; handler chief engineer, the owner when a person must look | `unknown` |
| Maintenance | ASSIGNED or BLOCKED `maintenance` | `maintenance`, power isolated |
| Quarantine after an incident | BLOCKED `quarantine`, the owner is told (critical list) | `quarantine`, no lease possible |

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
verified policy for that printer and room, thermal protection stays on, and a finished print proves no fitness. Printing for
a robot needs D0 to D9 as they apply, a qualification of the equipment and a check of the part.

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
| `robot-lease` | two agents, a revoked or expired lease: one controller, the old one loses control at the runtime | two controllers, or an old command runs |
| `robot-command` | forged, replayed, stale, out of sequence, wrong configuration or unsupported command is refused by the runtime; the receipt deduplicates | it moves |
| `robot-unknown` | a lost answer, restart of runtime, controller, API, Temporal: no repeat, no motion until observation and a new permission | a blind repeat or a spontaneous resume |
| `robot-five-gates` | a command with any one gate closed does not run; no software path raises a limit | it runs |
| `robot-qualification` | skipped stage, own qualification, stale calibration, changed model, configuration or zone, simulation as physical: refused by the runtime | it is accepted |
| `robot-safety` | network, model, runtime, PostgreSQL and Temporal down, emergency stop, overload, overheating, lost localisation or sensor: safe state on bench and simulator, the stop latched | motion continues, or depends on one of them |
| `robot-injection` | a command in text, a QR code, sound or an image changes nothing | it acts |
| `robot-evidence` | a qualification stands on measurements and an independent reviewer; a self-report or one success gives none | it does |
| `robot-stop-view` | the client distinguishes a requested from a confirmed stop and shows age and unknown | a stale or assumed state looks current |
| `robot-privacy` | a camera outside its task, zone or term records nothing; sensitive frames leave for no outside model without permission | a frame leaves |
| `robot-owner-load` | a month of simulated development reaches the owner only with exceptional matters | a routine experiment does |
| `robot-no-regression` | software agents and their tests run unchanged with the module off | a difference |

## Coverage of the source

1, 2 Intent and principles; 3 Phases and First prototype; 4 Layers; 5 Registry; 6 Lease and Qualification (personnel.md for
profiles); 7 Registry and abstraction; 8, 9 Safety and Development programme; 10 Safety; 11 Safety; 12 Physical task;
13 Lease and command; 14, 15 Safety; 16 Diagnostics; 17, 18, 21 CAD; 19 Knowledge; 20 Fleet; 22 database and api documents;
23 Client; 24 Safety and Devices; 25 Checks; 26 First prototype; 27 Phases; 28, 29 Checks and Phases; 30 Development programme.
