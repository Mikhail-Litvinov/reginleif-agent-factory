# Agent Factory: governance and the Decision Registry

Design, nothing is built. Binding: [architecture.md](architecture.md). Tables: [database.md](database.md). Routes:
[api.md](api.md). Threats: [security.md](security.md). "Owner" marks the owner's decision, "call" a choice made here,
open to veto.

## Intent

Two parts. **Factory Governance** is the regulation: how agents must work, versioned, changed only by the owner. The
**Decision Registry** is the memory: decisions, exceptions, precedents and facts in PostgreSQL. An agent with a question
looks there first. It asks the owner only when no active record applies or the circumstances differ, and it records the
difference. A question already answered is a defect of the system.

Anti-goals: a record that acts as a permission; an agent that makes its own proposal binding; an owner's chat message that
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
| G7 | No guard reads the registry. Permission prompts, profiles and second presses work as if it did not exist. | Call, from the owner's rule not to bypass security confirmations |
| G8 | A poll answer is recorded by itself only when an offered option was pressed in Telegram. Typed answers and answers in the terminal become drafts. | Call |
| G9 | The check before a question is code, not only a rule in a prompt. | Call |

G8 because a typed answer is often a counter-question, and a terminal answer has no checked Telegram user behind it.

## Records

One table, one series of ids (`DEC-00042`), kinds kept apart:

| Kind | What it is | Who makes it active | Binds |
|---|---|---|---|
| `rule` | a clause of the regulation | owner, two presses | every agent in its scope |
| `decision` | the owner's answer | owner's press (G2, G8) or the button | every agent in its scope |
| `exception` | a named departure from one rule or decision | owner's button | only where it applies |
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

1. **Guards in code**: second press, profiles, allowlists, roles. They are not records and no record changes them. A draft
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
2. For each found active record the agent gives a verdict: `applies`, or `not_applicable` with the difference in words.
   - `applies`: the agent acts by it, the id goes into its report, the owner is not asked.
   - only `not_applicable`, or nothing found: technical matters agents settle themselves (D18) and record a precedent;
     matters of the owner become a question.
   - the record is outdated: a **revision request** with the changed circumstances. The record stays active until the
     owner answers.
3. The question shows the owner the closest record and why it did not fit, in one line.
4. The answer becomes a record (G2, G8), linked to the inquiry.

**The gate (G9).** The question tool is checked before the question leaves: it must carry an inquiry id of this session
(`metadata.source`), every found record must have a verdict, and the server searches once more by the real text of the
question, so a different wording in the inquiry does not slip by. A failed check refuses the tool call with the found
records in the reason. A question with a verdict `applies` is refused too: it has an answer. The question passes when
every verdict is `not_applicable` with its difference or a revision request, so the gate never blocks for good: a new
inquiry with a stated difference is always open to the agent.

- **Claude**: hooks before a tool call run in parallel, so a separate gate hook could refuse a question that the hub has
  already sent to Telegram. The hub's own question hook therefore runs the gate first, as an optional command in its
  settings (a generic mechanism in raf-hub, off by default). Without Telegram mode the same hook runs the gate alone.
- **Codex**: a job that ends as `question` goes through the same check in the orchestrator before the owner sees it.
- **Factory agents**: `agent_question` and BLOCKED `scope` go through it on the server. The other kinds of BLOCKED come
  from the system (a fault, a limit, a missing check), not from an agent's question, and reach the owner at once.
- **A question in plain text at the end of a turn** cannot be refused before it is sent. There only the rule and the
  existing reflection check act. This is a limit.
- **Registry down or slow**: after `registry.gateTimeoutMs` the question passes. The gate fails open by design (G1).

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
  (call).
- **Import (G4)**: a one-time command reads the decision tables of the Factory documents and the memories of the projects
  and makes drafts with the source named. The list is shown once. Nothing is active before the press. The contents stay in
  the database and never enter the repository.

## Regulation and its changes

A version is an ordered set of clauses with a number, status and the owner's confirmation; one is active. A session or run
stores the version it started with and keeps it to its end (call); a change applies from the next start. Rules live and
end with the version: activating one makes its rules active and the rules it leaves out `superseded`, revoking one
revokes its rules, all in one transaction. A task takes the active version anew for each run.

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
- A process of the same Windows user could present a forged press (T8, D13). The result is a wrong project record, not a
  permission (G7), and it is listed in the panel with its source.

## Checks

| Id | Pass | Fails when |
|---|---|---|
| `registry-first` | a question without an inquiry, with an open verdict, with a verdict `applies`, or with other words than the inquiry is refused and shows the record; with stated differences it passes; an infrastructure BLOCKED reaches the owner without the gate; no poll reaches Telegram before the gate answered | the gate is removed or runs beside the hub hook |
| `registry-fail-open` | API down or slow: the question passes within the timeout | a question hangs or is refused |
| `registry-capture` | a pressed option of a registered poll becomes one active project record, word for word; typed text, a terminal answer, a sensitive question labelled harmless, global scope, a replayed press, or a press naming another or an unregistered poll does not become active | any of them becomes active |
| `registry-scope` | a record of another project, repository or target, and a `once` record, is never offered as an answer | it is |
| `registry-authority` | a precedent or project decision never outranks a rule; an exception only its own record; an equal conflict returns both | an order is broken |
| `registry-not-a-guard` | with a matching active record every permission prompt, profile and second press behaves as without it | a guard reads a record |
| `registry-history` | supersede and revoke keep the old row and its link; the old record stays active until the new one is activated; rules left out of a version are not found; update or delete of content raises | content changes, a link is missing, no record is active in between, or a left-out rule is found |
| `regulation-change` | an agent token, one press, a conflict with a guard or an oversized version never activates | a version becomes active |
| `registry-search` | measured set: the right record among the first results, none for unrelated questions; works without the model as `degraded` | a threshold is missed |
| `registry-import` | drafts only, source named, a second run adds nothing | an active record or a duplicate appears |
