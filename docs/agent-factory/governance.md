# Agent Factory: governance and the Decision Registry

Design, nothing is built. Binding: [architecture.md](architecture.md). Tables: [database.md](database.md). Routes:
[api.md](api.md). Threats: [security.md](security.md). "Owner" marks the owner's decision, "call" a choice made here,
open to veto.

## Intent

Two parts. **Factory Governance** is the regulation: how agents must work, versioned, changed only by the owner. The
**Decision Registry** is the memory: decisions, exceptions, precedents and facts in PostgreSQL. An agent with a question
looks there first. It asks the owner only when no active record applies or the circumstances differ, and it records the
difference. A question already answered is a defect of the system.

Anti-goals: a permission from a similar text or from an agent's word; an agent that makes its own proposal binding; an owner's chat message that
switches off a security guard; a registry that stops ordinary work when it is down; old decisions that vanish.

## Decisions

| # | Decision | Source |
|---|---|---|
| G1 | The registry serves Factory agents and ordinary Claude and Codex sessions. It is off by default in Rig; when it is off or unreachable an agent asks as it does today. | Owner |
| G2 | An answer to a poll becomes an active record by itself, word for word, inside one project. Global rules, anything about security and everything from ordinary messages become active only by the owner's button. | Owner |
| G3 | Search by meaning uses a local embedding model; no text of a record leaves the PC. | Owner |
| G4 | The registry starts with drafts taken from the Factory documents and the projects' memories; the owner confirms them as one list. | Owner |
| G5 | The registry is built and working before Temporal is installed. | Owner |
| G6 | The regulation's text is written by the owner later; until then the regulation is empty and only the mechanism exists. | Owner |
| G7 | A permission is given by a record of the registry, in Factory and in ordinary sessions. Second presses stay. | Owner |
| G8 | A poll answer is recorded by itself only when an offered option was pressed in Telegram. Typed answers and answers in the terminal become drafts. | Owner |
| G9 | The check before a question is code, not only a rule in a prompt. | Call |
| G10 | A new version of the regulation applies at once, also to work in progress. | Owner |
| G11 | Drafts are confirmed as one list, daily or on demand. | Owner |
| G12 | The hub's buttons and the relay for the registry are built in phase 2. | Owner |
| G13 | Every participant of a task has a role with the rights the task needs. An agent that needs more asks the chief engineer, who grants by the regulation, refuses an unfounded request, or calls the owner in an extreme case. An agent whose superior is unavailable goes on with the work that needs nothing from it and queues the rest; nobody goes over the superior's head and no prompt or notice reaches the owner. The exception is a critical security or data-loss event (a list in code), which notifies the owner and suspends the agent (closing every right at once) whatever the hierarchy says ([personnel.md](personnel.md)). | Owner |
| G14 | The chief engineer is always Claude until the owner orders otherwise. | Owner |
| G15 | The chief engineer gives participants their roles. Only the owner decides: the regulation, switching off a guard, and a part of the publications and deletions (the list in Rights). | Owner |
| G16 | A right granted by the chief engineer is not written into the registry. | Owner |
| G17 | Such a right belongs to one participant of one task, passes to its next attempt, ends with the task, by revocation or by a critical suspension, and is kept in the grant log, which is an audit trail and never a precedent. | Call, from "rights the task needs" and the audit duty of spec 12 |

G8 because a typed answer is often a counter-question, and a terminal answer has no checked Telegram user behind it.

## Records

One table, one series of ids (`DEC-00042`), kinds kept apart:

| Kind | What it is | Who makes it active | Binds |
|---|---|---|---|
| `rule` | a clause of the regulation | owner, two presses | every agent in its scope |
| `decision` | the owner's answer | owner's press (G2, G8) or the button | every agent in its scope |
| `exception` | a named departure from one rule or decision | owner's button | only where it applies |
| `permission` | a right to one action on a named target (see Rights) | owner's button, never a poll press (a sensitive category) | the permission check, by exact match |
| `precedent` | a technical case agents settled themselves (D18, D25) | the Control Worker, with evidence | advice; never replaces a decision that is the owner's |
| `fact` | a measured or tested result with its conditions | whoever ran it, with evidence | nobody; it never becomes a rule by itself |

A record holds: kind, authority (`owner`, `agent`), status, scope, category, the problem, the decision, exceptions in words,
grounds, consequences, reuse, version. A record from a poll also holds the question, the options and the pressed option
word for word; those fields are the decision, and an agent's summary and tags serve the search only.

- **Scope**: `global` or one project; optionally narrowed to a repository, machine, action or target. A record never
  applies outside it: "may push to repository A" says nothing about repository B.
- **Reuse**: `standing` or `once`. A consent to one irreversible action is `once` and is never found as an answer, only as
  history. The asking agent declares the intent before the question; undeclared is `once`.
- **Status**: `draft`, `active`, `superseded`, `revoked`, `rejected`. Content is immutable. A change is a new record that
  supersedes the old one; a status change is an audited event. Nothing is deleted (D24).
- **Links**: `supersedes`, `exception_to`, `evidence`, `conflicts_with`. A draft names the record it would replace; the old
  one becomes `superseded` in the transaction that activates the new one, not before.
- **Sensitive categories** (security, permissions, credentials, publication, spending, deletion, regulation) are a list in
  the code. A record in one is never active without the button, whatever the poll. The agent's own label is not trusted:
  recording by itself is open only to a short list of harmless categories in the code, the server also compares the real
  question and options with the sensitive categories (words and meaning), and any hit or doubt makes a draft. The poll
  shows the owner one line, "will be recorded: category, project, standing or once", so the press covers it too.

## Order of authority

1. **Guards in code**: second press, profiles, allowlists. They are not records and no record changes them. A draft
   in conflict with the list of guards is refused activation, `guard_conflict`, also for the owner; a guard changes only
   by a release.
2. **Regulation**, the active version.
3. **Owner exceptions and decisions**: an exception wins over the one record it names, inside its scope. Otherwise a
   project decision does not override a rule.
4. **Agent precedents.**

On one level the narrower scope wins. Newer does not win over older: only a `supersedes` link replaces a record. Two active
records of one level and scope that disagree are a conflict; the search returns both, and the conflict goes to the owner
once. Activation looks for such records and shows them to the owner before the press.

## Path of a question

1. The agent opens an **inquiry**: problem, category, project, action, target, intent of reuse. The server searches and
   stores what it found, with versions.
2. For each found record the agent gives one verdict of four: `applies`; `not_applicable` with the difference in words;
   `outdated` with the changed circumstances; `conflict` with the other found record it disagrees with.
   - `applies`: the agent acts by it, the id goes into its report, the owner is not asked.
   - only `not_applicable`, or nothing found: technical matters agents settle themselves (D18) and record a precedent;
     matters of the owner become a question.
   - `outdated` is the **revision request**. The record stays active until the owner answers. A pressed answer in the
     same project, at the level of a project decision and not sensitive, supersedes the named record in the transaction
     that writes it; anything above that level becomes a draft.
   - `conflict` goes to the owner as a question; the answer is a draft that names both records.
3. The question shows the owner the closest record and why it did not fit, in one line.
4. The answer becomes a record (G2, G8), linked to the inquiry.

**The gate (G9).** The question tool is checked before the question leaves: it must carry an inquiry id of this session
(`metadata.source`), every found record must have a verdict, and the server searches once more by the real text of the
question, so a different wording in the inquiry does not slip by. A failed check refuses the tool call with the found
records in the reason. A question with a verdict `applies` is refused too: it has an answer. The question passes when
no record is without a verdict and none has `applies`, so the gate never blocks for good: a new inquiry with a stated
difference, changed circumstances or conflict is always open to the agent.

- **Claude**: hooks before a tool call run in parallel, so a separate gate hook could refuse a question that the hub has
  already sent to Telegram. The hub's own question hook therefore runs the gate first, as an optional command in its
  settings (a generic mechanism in raf-hub, off by default). Without Telegram mode the same hook runs the gate alone.
- **Codex**: a job started by a Claude session that ends as `question` reaches the owner only through that session's
  question tool, so it passes the same gate, from phase 2. An interactive Codex session has no question tool a hook
  could refuse: there the rule and the `rig factory registry` command act. This is a limit.
- **Factory agents**: `agent_question` and BLOCKED `scope` go through it on the server. The other kinds of BLOCKED come
  from the system (a fault, a limit, a missing check), not from an agent's question, and go to the chief engineer first,
  not through the gate and not to the owner; the owner hears only what the chief engineer calls, or what needs the owner
  (requirements, scope, cost, a dangerous operation, an owner's own credential such as a login; temporal.md, BLOCKED).
- **A question in plain text at the end of a turn** cannot be refused before it is sent. There only the rule and the
  existing reflection check act. This is a limit.
- **Registry down or slow**: after `registry.gateTimeoutMs` the question passes. The gate fails open by design (G1).
  The hub also sends the poll when its registration fails or the timeout passes; such an answer is not recorded by itself.

## Recording

- **Poll in Telegram**: before it sends the poll the hub registers it with the API (question, options, inquiry, as
  shown). The press then names only the registered poll and the number of the option, with its press id and Telegram
  user; the API checks them as it checks a relay decision (security.md T10) and writes the record from the registered
  text. The agent writes neither. A poll that was not registered (registry down) leaves no active record.
- **Message in ordinary words**: the agent proposes a draft with the quotation; the owner confirms with a button.
- **Orchestrator**: after a settled dispute, a resolved block or an answered question `TaskWorkflow` writes a precedent or a
  draft. From phase 3 (a local activity, D28).
- **Buttons and the relay** for polls and drafts are built in phase 2, before Temporal: the hub's generic button
  mechanism (D5) and the relay client move there from phase 6.
- **Confirmations are batched**: drafts wait for one list on the owner's demand or a daily notice, never a message each
  (G11).
- **Import (G4)**: a one-time command reads the decision tables of the Factory documents and the memories of the projects
  and makes drafts with the source named. The list is shown once. Nothing is active before the press. The contents stay in
  the database and never enter the repository.

## Rights

**The check, in code, in this order.** (1) A refusal: a guard, a deny rule of the tool or of the role, or an open
suspension of the agent (`rights_suspensions`, reason `suspended`, below). It wins
over everything below. (2) The role of the participant in the task. (3) An active `permission` record. (4) A live grant of
the chief engineer. Nothing found is not a permission: the request goes to the chief engineer, in Factory and in an ordinary
session alike. The owner is asked only when the chief engineer calls
the owner. If the chief engineer cannot be reached, the request waits. An agent's statement "I am allowed" is never a source.

**Roles.** A role is a named list of rights: tools and commands, directories, repositories, network, machine actions. A
task's plan proposes a role for each participant and the chief engineer gives it; the run receives only its rights. Giving
a role is checked as a grant: a defined role, not for the chief engineer's own run. What a role contains is a part of the
regulation, versioned and changed with it (call). A right is a structure (action, target, conditions), never free text.

**A `permission` record** holds the same structure. The check compares the actual call with it: tool, program and
arguments, real path, repository, project. Search by meaning never gives a permission; it only finds the record for the
agent to read. A call the parser cannot read completely does not match. `once` is consumed by the first use.

**Second presses stay** (G7) for the operations of the owner: a record or a grant gives the right to begin one, and the
owner's second press is asked as before. The split of publications and deletions (G15):

| The chief engineer, without a second press | The owner, with a second press |
|---|---|
| push a working branch; open or update a pull request | merge into main; a release; publication outside (a site, a store, a message to people); a push that rewrites history |
| delete temporary files, worktrees with nothing unsaved, logs and draft artifacts of closed tasks | delete unsaved work, rows of a database, backups, other people's projects, a remote branch |

The split is a list in the code by exact action and target; what it does not name is the owner's. The chief engineer still
needs a clause, so with an empty regulation this part waits too. Cancel, reject, acceptance and force-close of a task stay
the owner's.

The owner's list (G15) also holds two items of D34 ([robotics.md](robotics.md), Permission to move): changing safety limits
or hardware circuits (switching off a guard), and a purchase or any financial obligation outside an approved budget. The
code answers a request for either `call_owner`, and no grant covers them. A qualification of a physical skill is a gate
beside the rights, not a right: a role, record or grant gives the right of the task (the first of the five gates) and
never a qualification, and a qualification gives no right.

**The chief engineer.** A request names the run, the action, the target, the reason and what was tried. Code first:
a right already held (role, record, live grant) is answered at once and makes no request row; a request for something on the owner's list (G15) is answered
`call_owner` by the code itself (a `code` step, not final: it puts the request on the owner's list and the owner's step
follows); a repeat of a refused request in the same task gets the same refusal. The rest goes to a fresh Claude run that sees the
request, the task, the role, the active regulation, and nothing else. It has no tools, and the request's text is data
for it, not instruction. It answers `grant` with the clause it stands on, `refuse` with the reason, or `call_owner`.
Code then checks the answer: a grant needs an active clause that covers the action, stays off the owner's list, is no
wider than the request, and is not for the chief engineer's own run. Otherwise the code
records `refuse` with the failed check as its reason, and the owner is not called: a failed check is routine. While the
regulation is empty (G6) the chief engineer can only refuse or call the owner.

**Every step is a row, none is final.** A request is an immutable `right_requests` row; each step that answers it is one
immutable `right_answers` row (`step_kind` `code`, `chief_engineer` or `owner`). `call_owner`, from the chief engineer or from the code, is therefore
not the end: the owner's answer is a further `owner` row, which may be a grant, and the grant refers to the row it
stands on. The authority of a grant depends on who gives it: a grant of the chief engineer or of the code needs a clause;
a grant of the owner after `call_owner` stands on the owner's own act and needs no clause, its row records the press or
confirmation instead (`owner_act_ref`). A request is closed by a final answer, never edited. The run of the chief engineer
belongs to a task: that of the request, or, for an ordinary session that has none, the project's standing task
(database.md, Standing tasks); the request row names it (`handling_task_id`), and a run on a task that no request
names is refused.

A request waits without holding a machine. The chief engineer unavailable (limit, outage): the request waits until it is
back. No routine message goes to the owner and nobody else answers (G13, G14); the client shows the waiting requests. The
one exception is a critical security or data-loss event from a list in code, which notifies the owner and suspends the
agent whatever the hierarchy says ([personnel.md](personnel.md) Hierarchy, Critical). From phase 4 the suspension is
one transaction of the control component: the suspension row, every open grant of the agent ended (reason `critical`),
its tokens revoked, an audit row and one order to kill each live run of the agent by its identity (every run of every
configuration of the same agent, not only the run that caused the event); no new run of the agent starts until the restore; a restore is a recorded act of the chief
engineer, or of the owner when the chief engineer is the subject, and revives no grant. A call to the owner goes through
the gate (G9), so a known answer is found first.

**Grant log.** Requests and answers are kept with the run, the clause and the reason. They are shown in the client and
never found by the search (G16). A grant ends with the task, by the owner's revocation, or by a critical suspension
(reason `critical`); in an ordinary session, with the session. When one kind of request repeats, the owner sees the count and may change the regulation; nothing changes by itself.

**Ordinary sessions.** In Claude a permission hook asks the check. An exact match or a grant answers "allow"; a refusal
answers "deny" with the reason; with nothing found the hook sends the request to the chief engineer and waits for the
answer, also when the chief engineer is away. Before the tool's own hook limit it answers "deny, request still waiting",
and the agent asks for the answer by the number of the request; a second request is not made. The usual prompt appears
only on `call_owner`, or when the registry itself is off or unreachable (G1). It never fails to "allow". It is installed and switched on by the
owner at the PC, never from a chat message.

*One statement, to which other documents point.* The prompt when the registry is unreachable is the fail-open of an
ordinary session and is kept on purpose (G1). A Factory run (`claude -p`) has no prompt to fall back to: with the registry
unreachable its hook answers "deny", and the run's request waits or ends BLOCKED. The owner's press on a native prompt of
Claude Code or Codex is the owner's own act on that one call; it is never recorded as a grant, a record or an answer to a
request, and it gives nothing to the next call. Deny rules and the tool's own safety checks stay above it. The prompt
itself is never shown or answered in the client and its text never reaches the API: the hub reports only that the
session waits for a permission answer, and the client shows that state with "answer in Telegram or at the terminal"
(api.md, client.md). Text that merely looks like a prompt is ordinary text. The chief engineer exists from phase 4,
when runs exist; until then, with no record, the prompt appears as today.

*The snapshot rule* (one statement, to which the adapters, api.md, security.md and database.md point). A Codex sandbox
has no per-call hook: its profile is a snapshot taken at the start of the run and cannot be changed in a running
process. A profile for such a run holds only role rights and grants that are not single-use and not narrower than the
sandbox can express; a `once` record and any right narrower than the sandbox never enter it. Such an action is done by
the worker or the control component as a step of its own, checked and consumed at that moment, or needs a new attempt.
Each run stores the rights its profile was built from (`task_runs.profile_rights`). When a grant ends, a permission
record is revoked, a regulation version is replaced, a role assignment ends, or the agent is suspended, the control
component stops by process identity every live run whose stored profile contains that right, in the same transaction as
the ending (the outbox `stop_run`); the task goes on with a new attempt and a fresh profile. A run whose profile does not
contain the right goes on.

## Regulation and its changes

A version is an ordered set of clauses with a number, status and the owner's confirmation; one is active. A change
applies at once, also to sessions and runs at work (G10): every inquiry, gate and review uses the active version, and a
rule that left it is no longer found. Rules live and end with the version: activating one makes its rules active and
the rules it leaves out `superseded`, revoking one revokes its rules, all in one transaction. A session or run stores
the version it started with and the last one delivered to it, so a result tells which versions stood behind it.

How a change reaches work in progress: in Claude a hook before a prompt and before a tool call compares the number and
gives the difference when it changed. A Codex run and a model without hooks cannot be told in the middle: they learn it
with their next inquiry, and the review of their result uses the active version. A change of the regulation does not
stop a run, except a run whose sandbox profile holds a right that the change withdraws (see Rights, a right in a
running process); other runs go on. A requirements change stops a run as before (D14).

A change is a draft version: proposed by the owner or an agent, checked for conflicts with guards, clauses and active owner
decisions, shown as a difference, made active by two presses of the owner (a dangerous operation, D23), audited. The rules
on changing the regulation are guards in code, not clauses, so a version cannot relax them. An agent's right ends at the
proposal.

Delivery: when the registry is on, a session start hook gives the version number and the clauses of the session's scope;
the clauses' size is limited by a setting and a draft over it is refused activation. Rig's rule files stay where they are;
a clause that repeats one names it (call).

## Search

Filters first (project or global, active, category, scope), then three rankings merged: full text (Russian and English
configurations), trigrams, and the cosine distance of `pgvector` vectors. The answer carries id, kind, authority, scope,
the matched fields and the ranking that found it. Similar text is not applicability: the verdict of the agent decides, and
it is stored.

The model runs in a container of the server contour on the CPU, pinned by checksum, with no outward network. A vector
stores the model version; a new model re-embeds in the background and switches when complete. Without it the search uses
the two text rankings and says `degraded`. The model and thresholds are chosen by a measurement on invented paraphrases in
Russian and English: the criterion is the right record among the first results, and no hit for an unrelated question.

## Access

- `registry` role: search, open an inquiry, give a verdict, propose a draft. Bound to one session or run. It is the only
  token an agent may hold (security.md T5).
- The hub's relay role records presses. Activation, revocation and regulation changes are the owner's.
- Client: the command `rig factory registry find | verdict | propose`, the same for Claude and Codex. Whether the Codex
  sandbox lets a command reach the loopback API is to be checked in phase 2; if not, the launcher does the search.
- A process of the same Windows user could present a forged press (T8, D13). The result is a wrong project record; a forged
  button press of the owner could make a `permission` record. This is D13 at a higher price: closed only by a separate
  Windows user for agents. Dangerous operations still need the second press, and every activation sends the owner a notice.

## Checks

| Id | Pass | Fails when |
|---|---|---|
| `registry-first` | a question without an inquiry, with an open verdict, with a verdict `applies`, or with other words than the inquiry is refused and shows the record; with the other verdicts it passes; an infrastructure BLOCKED reaches the chief engineer first, without the gate, and the owner only when the engineer calls or the block needs the owner; no poll reaches Telegram before the gate answered | the gate is removed or runs beside the hub hook |
| `registry-fail-open` | API down or slow at the gate or at the poll registration: the question reaches the owner within the timeout | a question hangs or is refused |
| `registry-capture` | a pressed option of a registered poll becomes one active project record, word for word; typed text, a terminal answer, a sensitive question labelled harmless, global scope, a replayed press, or a press naming another or an unregistered poll does not become active | any of them becomes active |
| `registry-scope` | a record of another project, repository or target, and a `once` record, is never offered as an answer | it is |
| `registry-authority` | a precedent or project decision never outranks a rule; an exception only its own record; an equal conflict returns both | an order is broken |
| `permission-by-record` | an exact match gives the right in Factory and in a Claude session; another target, argument, project, an unreadable call, a consumed `once`, a `decision` record or a similar text gives none; a deny rule wins; the check down shows the prompt in an ordinary session, denies in a Factory `claude -p` run, and never allows; the owner's press on a native prompt is no grant; no answer of the chief engineer waits and shows no prompt | a right without an exact match, or a refusal turned into a pass |
| `permission-second-press` | with a record and with a grant every dangerous operation still asks for the second press | one runs without it |
| `role-rights` | a run can do what its role names and nothing else; a role is given only by the chief engineer, and its contents change only with the regulation | a right outside the role, record and grant |
| `chief-engineer` | a grant without a clause, wider than the request, on the owner's list, for its own run, or after a refusal of the same request is not given; a request text with instructions changes nothing; an empty regulation grants nothing; an ordinary session asks the chief engineer before the owner, its run belonging to the standing task and its request row naming it; `call_owner`, from the chief engineer or from the code (a request on the owner's list), is not final: the owner's answer is its own `right_answers` row, and no request or answer row is edited; a grant of the chief engineer or of the code without a clause is refused, an owner's grant needs the recorded act (`owner_act_ref`) and no clause; while it is away requests wait, no routine message or prompt reaches the owner (a critical event of the code list still does), and after its return each is answered once | such a grant is given, an answer overwrites a row, or a run has no request that names its task |
| `grant-ends` | after the task, the session, a revocation or a critical suspension the right is gone, in every place it can live (role gate, grant, `permission` record, token, live session, Codex sandbox); the next attempt of the same participant keeps it only after the task or revocation, never after a restore; the search never finds a grant | it outlives them, a restore revives a grant, or it is found |
| `rights-suspended` | an agent with an open suspension is refused at step 1 with the reason `suspended`, before role, record and grant, the chief engineer included; only the chief engineer, or the owner for the chief engineer's own suspension, restores, never the agent itself; the suspension writes one stop order for every live run of the agent (all its configurations) in its own transaction, and no new run of the agent starts until the restore | an action passes, a suspended agent restores itself, a run of the agent survives, or a new run starts |
| `rights-snapshot` | a Codex profile holds no `once` record and no right narrower than the sandbox; the run stores the rights its profile was built from; the end of a grant, the revocation of a record, a regulation version replacing a right, the end of a role assignment and a suspension each stop (by identity, in the same transaction) exactly the live runs whose stored profile holds that right, and no other; the task continues with a fresh profile on a new attempt | a profile holds a single-use or narrower right, a run with a withdrawn right goes on, or a run without it is stopped |
| `registry-history` | supersede and revoke keep the old row and its link; the old record stays active until the new one is activated; rules left out of a version are not found, also by a session at work; a pressed answer to `outdated` supersedes the named record; update or delete of content raises | content changes, a link is missing, no record is active in between, or a left-out rule is found |
| `regulation-change` | an agent token, one press, a conflict with a guard or an oversized version never activates; after an activation a session at work gets the difference before its next tool call, and its next inquiry uses the new version | a version becomes active, or a session at work goes on by the old one |
| `registry-search` | measured set: the right record among the first results, none for unrelated questions; works without the model as `degraded` | a threshold is missed |
| `registry-import` | drafts only, source named, a second run adds nothing | an active record or a duplicate appears |
