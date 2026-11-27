# Agent Factory: history and the chronicle

Design, nothing is built. Binding: [architecture.md](architecture.md). Tables: [database.md](database.md). Registry and
rights: [governance.md](governance.md). Audit: [audit.md](audit.md). Recovery: [recovery.md](recovery.md). "Owner" marks
the owner's decision, "call" a choice made here, open to veto.

## Intent

The factory keeps how and why it became what it is. This is institutional memory for its agents and for the owner. It
is not a technical log (that is the audit), not the knowledge base (that is the registry), and not task management (that
is the task tables). History never becomes an instruction: no agent is bound by anything written here.

Two parts. The **history** is objective: one thin append-only table of events, each pointing at the rows that already
record what happened. The **chronicle** is a separate space of texts the factory writes itself. "Subjective" means the
system's own interpretation of events; it implies no consciousness.

Anti-goals: a past view that an agent follows as a rule; a history that grows into a second audit; a text written
"for history" because the system was asked to; a secret or personal data kept for good; shaping the factory to produce
research results.

## Decisions

| # | Decision | Source |
|---|---|---|
| H1 | The history is one table, `history_events`, append-only. A row holds the time, the initiator (agent, role, human or system), the kind, a short rationale, links to related events, observed consequences, and references to source rows that already exist. | Owner |
| H2 | Source rows are referenced, never copied: registry decisions and their supersession, regulation changes, audit rows, task history, right grants. | Owner |
| H3 | Own content is kept only for kinds that no other table records (see Kinds). | Owner |
| H4 | Rows are immutable by a database trigger, as the other history tables are. A correction is a new row linked to the original. | Owner |
| H5 | An event that already lands in a source table gets its history reference by itself, in the same transaction. Manual selection of what is significant applies only to the own kinds, and the selection rule is itself recorded in the history. | Owner |
| H6 | The chronicle is a separate space. It has no schedule, no size floor, no style and no format rule. Writing it is an option and no entries is a valid outcome. | Owner |
| H7 | A chronicle entry may link history events but does not have to. A new reading of an old matter is a new entry beside the old one; the old one is not changed. | Owner |
| H8 | Everything lives in the factory database: backup and restore cover it, and it does not depend on sessions, agents, models, reorganisation or changes of the architecture. | Owner |
| H9 | Readers are the agents of the factory and the owner. Nothing is published outside. | Owner |
| H10 | There is no stimulus: the chronicle plays no part in evaluating agents, and agents are told it exists in one line, with no prompt to write. | Owner |

## Kinds

Events that already have a source table are recorded as a reference only: the kind names the source and the row.

| Kind | Source | Own content |
|---|---|---|
| registry decision, supersession | registry records and links | none |
| regulation change | `regulation_versions` | none |
| audit event of note | audit log | none |
| task history event of note | task transitions and events | none |
| right grant, revocation, suspension | grant log | none |
| own initiative of the factory or of an agent | none | rationale, consequences |
| disagreement and how it was resolved | none | the positions, the resolution |
| human intervention | none | what the human did and the reason given |
| model replacement | none | what was replaced, by what, why |
| significant error and its consequences | none | what failed, what followed |
| activity started with no external task | none | what started and why |
| role created, changed or removed | none | the change |
| change of the organisation structure | none | the change |

The set of own kinds is a list in code. A new kind is a change of this document and of the code together.

## Rows

A row never changes. The consequence of an event is usually known later, so it is a new row of the kind `consequence`
linked to the event, not an edit. A mistaken row stays; the correction is a row linked to it that says what was wrong.
The only exception is the emergency erase.

The initiator is stored as a kind (agent, role, human, system) and an id, so a replaced model or a removed role leaves
the row readable.

## The chronicle

An entry holds its author (the same kind and id as in the history), its time, its text, and optional links to history
events. It is never edited; a later view is a new entry. There is no required topic and nothing prompts for one. The
chronicle is not read by any evaluation, reward or ranking, and no check counts its entries.

## Rules held by code

These are not wishes in a prompt.

- (a) The chronicle and the history are excluded from the registry search the question gate uses. They are never
  injected into agent rules, profiles or session starts. An agent reads them only through a separate read route, on its
  own decision. Every chronicle entry comes back marked as opinion, not rule.
- (b) Every write to the history or the chronicle passes the secret scan and is refused if it holds a secret. The same
  scan and the same list of patterns serve the registry and the audit.
- (c) Every entry has a size cap. The cap is a setting; a write above it is refused, not cut.

## Emergency erase

Only for a leaked secret or personal data that got past the scan. The owner blanks the text of one row or entry, and
the action takes a second press (D23). A tombstone stays with who did it and when, and the row keeps its links. Nothing
else is ever deleted from the history or the chronicle, and the owner is the only one who may erase.

## Continuity and load

The tables are in the factory database, so the backup of [recovery.md](recovery.md) covers them and a restore brings
them back whole. A write is one row insert per significant event; the events that already have a source table add a
reference in the transaction that writes the source, so there is no extra round trip. A counter of rows and bytes per
space is shown to the owner, so growth is seen before it is a problem.

## Risks

| Risk | Mitigation |
|---|---|
| An agent adopts a past view as dogma | Rule (a): never injected, read only on its own decision, entries marked as opinion |
| The history is incomplete because someone chose what to record | H5: events that land in source tables are referenced automatically; selection applies only to own kinds and its rule is recorded |
| An erroneous row cannot be removed | Correction rows; the emergency erase for a leaked secret or personal data |
| Growth | The size cap and the space counter |
| Writing "for history" | H10: no stimulus, no evaluation, no count |

## Research use

Not a goal of the build, kept as a purpose: institutional memory, stable practices, self-organisation, continuity across
model changes, the evolution of the regulation, initiatives, and the gap between the objective history and the
chronicle. Nothing in the factory is shaped to produce such results.

## Phase

Phase 4, before the first agent works without a task of the owner (see [modules.md](modules.md), Phase 4). Migration
numbers are assigned there.
