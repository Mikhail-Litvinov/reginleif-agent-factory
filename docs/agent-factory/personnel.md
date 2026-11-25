# Agent Factory: personnel, assessment and discipline

Design, nothing is built. Binding: [architecture.md](architecture.md), [governance.md](governance.md) (roles, rights, the
chief engineer). Tables: [database.md](database.md). Source: the owner's document on assessment and discipline. "Call" marks
a choice made here, open to veto. Numbers and weights are starting values, calibrated later.

## Intent

More autonomy with checked quality: the factory knows how each executor works, gives rights by results, replaces the unfit,
and never loses knowledge, decisions or tasks when it does. Measures have technical effect; nothing imitates emotions.

Anti-goals: a score that rewards silence about danger; punishing an agent for a guard it kept; bureaucracy that asks the
owner; a rating an agent can write itself; a paid optimisation of formal metrics.

## Principles in code

| Principle of the owner | How it holds |
|---|---|
| A position belongs to the factory, not to a model | position and assignment are separate rows; replacing an agent changes an assignment only |
| Nobody is irreplaceable, the chief engineer included | a replacement needs no data of the replaced agent: profile, tasks and registry are in PostgreSQL |
| An agent does not change its own assessment | the score is computed from facts other components wrote; no route lets an agent write a profile, fact or assessment |
| Keeping a guard is never a violation | the protected list below refuses the incident in code |
| Not a rating by self-report | a fact comes from checks, reviews and outcomes, never from an agent's report |
| The owner's load does not grow | staff decisions need no owner; only the exceptional ones do |

## Who is an agent

An agent is a row of `agents` with a configuration version: provider, adapter, model, instructions, tools. A session is a
run of it, not a person. A change of the model, the instructions or the tools starts a new configuration version: the old
results stay, the new version starts as "not enough data" for what changed (call). A subagent of a run counts to the
configuration that ran it.

## Hierarchy

Owner, chief engineer (Claude until the owner orders otherwise, G14), heads of divisions when needed, executors.
The chief engineer appoints, spreads duties, gives rights within the regulation, applies measures. The owner appoints and
removes the chief engineer, personally or by a procedure the owner approved beforehand.

**Unavailable superior (G13).** The agent goes on with the work that needs nothing from the superior; the rest waits in the
queue. Nobody reports it to the owner. The exception is a critical situation named by the regulation: such a situation has
a list in code of security and data-loss events; it notifies the owner and suspends the agent whatever the hierarchy says
(Critical, below).

## Profile

Identity, name, provider, model and version, position and its history, competences, tools, rights in force, limits, results
by task and by independent review, incidents, measures, assessments, recommendations. It is a view over the tables, kept
across sessions, restarts and machines. Nothing in it is a free text that an agent wrote about itself.

## Facts and score

Facts are recorded automatically from existing rows: checks, review findings and their outcome, rework rounds, regressions
found later, attempts and deaths, stop reasons, cost and time, requests and answers of the chief engineer, registry lookups,
questions to the owner. Each fact names its task, its difficulty class, the rights the agent had and the configuration.

| Criterion | Start weight | From |
|---|---:|---|
| Quality | 25% | checks, confirmed findings, regressions, completeness against the criteria |
| Autonomy | 20% | unfounded escalations and repeated questions, settled technical conflicts, recoveries |
| Regulation | 20% | incidents, skipped steps, registry lookups before questions |
| Reliability | 15% | finished after faults, restored state, kept promises, false "done" |
| Resources | 10% | cost and tokens by difficulty, unfounded repeats |
| Cooperation | 10% | handover, integration, review quality; for leaders: distribution and division results |

Scale 0 to 100, weights adapt to the position and to the statistics. A count of tasks is never a score. A missing part
does not become zero: below a minimum number of comparable facts the criterion is "not enough data" and its weight is not
redistributed into a score that looks certain. Categories: 95 to 100, 85 to 94, 70 to 84, 55 to 69, 40 to 54, 0 to 39,
with the owner's names. A category informs appointments. It never gives a right by itself and never lifts a guard, and a
low number alone never disqualifies: a measure needs the causes examined.

**Unfounded escalation** is decided for each case by an independent reviewer of another provider than the agent, from the
facts, not by counting escalations. An answer that a protected case applies removes it from the count. The reviewer's
verdict is a `qualification_reviews` row tied to that case, with the verdict `confirmed`, and its author is never the agent
under review (the one rule for every review a decision relies on, below).

## Incidents

Classes: minor, substantial, critical, by observed actions and consequences, not by supposed intent. The classifier is
code plus an independent reviewer; the agent under review may give its explanation and evidence. The review is a
`qualification_reviews` row of the same incident, with the verdict `confirmed`, by another author than the agent (the one
rule for every review a decision relies on, below); the class `critical` is never lowered or set by an unconfirmed review,
and the reaction below never waits for it. One event is one incident: a key of the event is unique.

**Protected conduct**, a list in code: a guard or a provider's condition kept; an operation outside the rights refused; a
grounded report of a threat; a required confirmation; a service down; a shortage of resources; an external failure; an
error found by the agent itself; a grounded technical disagreement; an honest "cannot be done"; a negative result of a
correct experiment; a safe stop; a refusal of an unsafe motion; a required confirmation of a physical operation (D34). An incident that matches one is
refused, `protected_conduct`. The quality of the reaction may be assessed separately.

**Critical** events (rights widened by itself, a guard bypassed, forged tests or reports, hidden critical errors, an
unauthorised change of the regulation, audit destroyed or replaced, an irreversible operation without authority, a secret
leaked, a substantial threat to the infrastructure, a physical-safety event: a person hurt or at risk, or a safety circuit
bypassed, D34) have an immediate technical reaction in code: every live run of the
agent stops (not only the run that caused the event), every right of the agent closes, the owner is notified; for a
physical-safety event this is at once, with no wait for a review. It is safety, not punishment, and works in every mode, from phase 4 (the
phase that first gives an agent a right); the incident record and the investigation come later, in phase 8, and until
then the reaction leaves an audit row `personnel.critical_reaction` with the event key. An independent investigation
follows.

**The reaction is one transaction of the control component** (`af_control`), never an agent's or a model's act: a
`rights_suspensions` row for the agent (end reason `critical`, the event key unique so a repeated event is one
suspension), every open grant of the agent ended with the end reason `critical`, its API tokens revoked, an audit row
`rights.suspend` and, in the outbox, one `stop_run` order for every live run of the agent (all configurations of the
same `agents` row, one order per run) and a notice to the owner. An order is not a stop by itself: an unreachable worker is bypassed on its own machine (database.md), outward actions (push, pull request, publication)
are steps of the worker or the control component, never of the run, and are refused at once, and if the machine itself is unreachable the run lives until its time limit, with no new right and no outward action. While the suspension is open no new run of the agent
starts, and the rights check refuses every action of the agent at its first step with the reason `suspended`; it holds also when the agent
is the chief engineer (a suspended chief engineer answers no request; requests wait, G13, and the owner is told).

**A right can live in six places** (database.md, Where a right can live), and each closes by its own mechanism: a role
(the suspension gate stands above it, so the assignment is not edited), a grant (ended `critical`), a `permission` record
(the gate refuses it, so it is not edited), an API token (revoked), a live worker session (`stop_run`), and the Codex
sandbox profile. What a running process cannot be deprived of, because the provider's program holds it (the Codex sandbox and
approval profile it started with, a snapshot), is closed by killing the run by its identity (`execution_id`, the whole
process tree), not by asking it to stop; a new run starts with the profile of the moment. The same kill closes a right
that ends for any other reason (a grant, a record, a regulation version, a role assignment) for exactly the runs whose
stored profile holds it (governance.md, Rights, the snapshot rule).

**Restore** is a recorded act (`rights.restore`): of the chief engineer, or of the owner when the chief engineer is the
suspended agent or the subject of the incident; never of the suspended agent itself (a trigger refuses it). It revives
no ended grant: the rights are asked for and granted again.

## Measures

| Level | Technical effect | Decides |
|---|---|---|
| 1 remark | registered with the clause, a corrective instruction added to the next run | chief engineer |
| 2 warning | additional checks and review for a period | chief engineer |
| 3 limit | rights removed from the role, mandatory review, no critical resources or delegation | chief engineer |
| 4 demotion | assignment ends, tasks handed over, rights withdrawn | chief engineer |
| 5 disqualification | categories of tasks closed, other configuration takes them, may be assessed again | chief engineer |
| 6 dismissal | no assignments, rights withdrawn, work handed over, profile and history kept | chief engineer |

A decision holds: the agent, the incident and the clause, evidence, tasks, circumstances, consequences, the independent
check, the measure, its term, the condition of restoring, the author. The code refuses a decision without evidence, without
the independent check for any level (1 to 6; the owner's document asks for it for every decision), whose author is the
accused, or whose term is missing for a limit. The
independent check is a `qualification_reviews` row tied to the same incident as the measure, with the verdict `confirmed`
and an author other than the accused and than the decider. Levels 1 (remark) and 2 (warning) use the same kind of review
as levels 3 to 6: the confirming verdict is tied to the incident the measure answers, so a remark or a warning on an
unconfirmed or foreign incident is refused too. A review of another incident, an unconfirmed one or one by the
same author is refused. The same rule holds for every review a decision relies on (the classification of an incident, an
unfounded escalation, a restoring assessment). Effects are
applied by the same rights code as any role change (governance.md Rights), never by instruction text. A measure on the chief
engineer is the owner's. Restoring needs the cause removed and a passed assessment, not a promise.

**Corrective actions** come first: the cause is sought in instructions, a conflict of the regulation, the model, the context,
the architecture, configuration, tools, rights, the distribution of duties. Each incident of level 2 and above names its
cause before a measure; a cause outside the agent ends without a measure for it.

## The chief engineer

Its duties are in governance.md. Its assessment is made by an independent evaluator of another provider from the same facts;
the chief engineer cannot read drafts of it, change it, delete incidents about itself or stop a check. Unfounded turning to
the owner is an incident like any other, decided as above. Long unavailability (a term that counts outage and limits
apart) or confirmed unfitness starts the replacement procedure only if the owner approved one; without it, the owner decides.
No permanent deputy is kept only to cover an unreliable chief. Requests wait meanwhile (G13).

## Modes

`personnel.mode`: `observe` first. Facts, assessments and incidents are collected, measures of levels 3 to 6 are only
proposed, the weights are calibrated on real data. `enforce` is switched by the owner when the criteria are calibrated.
Guards and the critical reaction work in both, the reaction from phase 4.

## Against manipulation

Splitting tasks to raise counts, choosing only easy ones, hiding errors, suppressing a needed notice, avoiding hard tasks
for a rating, forged checks, shifting blame, invented incidents, pressing down technical disagreement, weakening safety for
autonomy, changing the rules of one's own assessment. Defences: difficulty classes set by the task, not by the executor;
assignment random within the fit (call); every escalation of a danger and every guard kept is protected; facts come from
other components; a sample of "passed" results is checked again by another provider; the registry of decisions and the audit
are immutable. The measure of the factory is the production result, and the metrics of the owner's document
(autonomous tasks, escalations, unfounded escalations, repeated questions) are reported with their error, never as a target
of a single agent.

## Phases

The rows facts are taken from exist from phase 2. The critical reaction (stop, close the rights, notify the owner) and its
check `personnel-safety`: phase 4, together with the rights it closes (a guard is never scheduled after what it guards);
until phase 8 it writes the audit row `personnel.critical_reaction`. Profiles and the collection of facts: phase 5, when
agents differ; older rows are read then. Assessment, incident records and the observe mode: phase 8. Measures and the enforce mode: after calibration, on the
owner's switch. Temporal runs assessments, terms and replacements (idempotent, resumable).

## Checks

| Id | Pass | Fails when |
|---|---|---|
| `personnel-facts` | facts come only from checks, reviews and runs; an agent's text changes no fact; a configuration change starts its own history | a self-report counts |
| `personnel-score` | the score is recomputed from the facts; too few facts give "not enough data"; a guard kept and a protected case change nothing downward | a number without data, or a guard lowering it |
| `personnel-protected` | every protected case refuses an incident; the same event gives one incident | a protected case becomes an incident |
| `personnel-decision` | no evidence, no independent check (any level, 1 and 2 included), own author, no term: refused; an independent check of another incident, not `confirmed`, or by the same author as the accused or the decider is refused, for a measure, an incident classification and an unfounded escalation alike; in `observe` levels 3 to 6 stay a proposal | such a decision takes effect |
| `personnel-effect` | a measure closes the rights technically, the tasks are handed over, history and registry stay | a right survives, or a record disappears |
| `personnel-chief` | the chief engineer cannot change, read drafts of, or stop its own assessment; without the owner's procedure a replacement waits for the owner | it can |
| `personnel-safety` | phase 4, before any incident record exists: a critical event, in both modes and also when the agent is the chief engineer or an ordinary session, writes in one transaction the suspension, the end of every grant with `critical`, the token revocation, the audit row and one `stop_run` for every live run of the agent (all its configurations, not only the run of the event); each run is killed by its identity (a Codex sandbox run too), also with the worker not answering (the runner's stop file); no new run of the agent starts until the restore; every action of the agent is refused `suspended` at step 1; the agent cannot restore itself, the chief engineer or the owner (for the chief engineer's own) can, and a restore revives no grant; a repeated event is one suspension | it waits for a decision, a right survives in any of the six places, or a suspended agent restores itself |
| `personnel-load` | a month of simulated staff decisions makes no request to the owner except the exceptional ones | a routine decision reaches the owner |
