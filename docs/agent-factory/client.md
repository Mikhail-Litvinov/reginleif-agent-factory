# Agent Factory: the client application

Design, nothing is built. Binding: [architecture.md](architecture.md), [governance.md](governance.md),
[personnel.md](personnel.md), [api.md](api.md), [security.md](security.md). Source: the owner's document on the client.
"Call" marks a choice made here, open to veto.

## Intent

One application for the owner's phone (Android) and PC (Windows) that runs the factory: tasks, agents, machines, projects,
the registry, approvals. It is for personal use: one owner, no distribution, no store, no registration of other people.
Telegram stays as the reserve channel. The client talks only to the Factory API: it has no database account, no Temporal
access, no secret of a provider, SSH or storage.

It parses messages and controls the Rig; it is not a client for language models (owner). It holds no model connection, no
prompt box to a provider and no model picker as a chat service has: what the owner writes goes to the Factory API and the Rig,
and only the Rig starts the unmodified `claude` and `codex` programs. Messages the agents wrote in the Rig come back parsed
into typed records (result, question, approval, blocker, status), so the state is read from fields, not from a wall of text.

Anti-goals: an unofficial ChatGPT or Claude client; a chat that is the only memory; a factory that stops when the client is
closed; a notification per routine event; rewriting a part that works.

## Scope

| Section | First | Later |
|---|---|---|
| Dashboard, Chat, Tasks, Agents, Workers, Approvals, Notifications | MVP | |
| Projects, Decision Registry, Governance, Infrastructure, Personnel | | by dependency, after the MVP |
| Robotics | | by the stages of [robotics.md](robotics.md), Phases; R6 goes with the client (below) |

The API already serves the MVP: tasks, revisions, decisions with the second press, agents, workers, notifications, the
registry, rights. New for it: conversations, devices and sessions, an event stream (below). The server-rendered web panel
of phase 6 is not built: the Windows build of the client is the panel (call: one code base instead of two panels).

## Platforms and stack

Android and Windows only (owner); no web and no iOS. Flutter, one code base (call). The owner's PC builds both; the Android
package is signed with the owner's own key, kept outside the repository, and installed directly. The toolchain is pinned;
no account secret in the build.

## Structure

- **Contract first**: a client library is generated from `openapi.json`; a drift fails the build.
- **State**: a local cache of read data with one opaque cursor per stream (the client never reads or builds it); a mutation is sent with an idempotency key, so a retry
  after a lost connection never doubles it. An offline press is not sent later by itself for a dangerous operation: a
  second press needs a live connection (the confirmation window).
- **Screens** are thin; rules (what may be pressed, whether a second press is asked) come from the API, never from the client.

## Events

`GET /events/stream` (server-sent events, call; a WebSocket only if a section needs the client to talk upstream) with
one opaque cursor per stream (`task_events`, `audit_log`, `notifications`, `messages`), sent as `Last-Event-ID`. After a
break the client asks for everything after its last cursor, so nothing is missed and nothing is taken twice. The server
serves only rows older than the oldest running transaction, so a row committed late can never fall behind a cursor that
has passed it (api.md, Events and pagination; database.md, Conventions). A cursor of another stream or a damaged one is
refused `bad_cursor`; the client then reads the stream again from its start. Closing the client stops nothing. The stream
carries no secret and no raw agent log.

## Chat

The chat is a message view of the Rig, not a dialogue with a model. It shows every session of the Rig, ordinary ones
included, not only Factory tasks (owner): the owner follows the agents and the factory, reads formatted text and answers
choices with native controls.

- **Source.** telegram-hub stays the one relay of ordinary sessions and additionally hands each message, poll and state to the
  Factory API (call: a second output of the hub, not a second reader of the sessions). Factory runs write to the API
  themselves. Records carry session, kind and a key, so a repeat is stored once.
- **Choices.** A poll of a session and a Factory decision look the same: question, options, recommendation. Each kind has
  exactly one arbiter (api.md, One arbiter per poll kind). A poll of an ordinary session (`rig_session`) is arbitrated by
  the hub: the client's answer is a `poll_answer_requests` row (pending, then accepted or refused) sent to the hub with an
  idempotency key and retried until the hub confirms; the API never decides it, so Telegram keeps working with the API
  down, and a late answer is refused by the hub and shown as such. A Factory decision is arbitrated by the API through
  `task_decisions`: the answer is written before it is delivered, delivered at least once and applied once; the hub is told
  the result through the same records, with a catch-up when it starts.
- **Tool permission prompts** of Claude Code and Codex are never displayed or answered in the client: the hub does not
  send their text to the API, which records only that the session waits for a permission answer. The session shows that
  state with "answer in Telegram or at the terminal", without the text of the prompt, its tool or its arguments, and
  without buttons. A message cannot become a prompt: text that merely looks like one is ordinary text, shown without
  controls (Approvals).
- **Reserve.** The hub's Telegram relay does not depend on the API or the client: with both down, it works as now. With both
  up, Telegram keeps relaying as now until the owner changes it (call).
- **Untrusted text.** A message that does not parse is shown as plain text and never becomes a command or an approval; links and
  markup in it are inert until pressed.

A conversation has a project, messages, attachments and the tasks it made or continued. A message is stored before it is
answered, queued when the agent is busy, and becomes an instruction to a task, a new task (the executor is chosen by
routing unless named) or an answer. The task state lives in the task, never in the chat. Voice input is later; its
recognition stays on the device or on the owner's machine (call: audio is not sent to a third party without the owner's
order). Attachments are artifacts (`task_artifacts`).

## Approvals

An approval shows the action, reason, proposed decision, real alternatives, consequences, risk, project, task, author,
expiry. The press is bound to the operation and its parameters by a hash: a changed parameter voids it, a used one cannot be
used again (the existing `confirmations` row and the press rules of governance.md). The client never takes over a
confirmation that belongs to a third-party tool's own trusted interface: Claude Code's and Codex's own prompts stay where
they are, are never shown in the client and never reach the API as text (only the state "waits for a permission
answer" does), and only the official hooks of governance.md Rights answer them. A test lists which prompts are and are
not served.

## Security

- **Login**: the owner, with a long-lived device session made on the PC by a one-time code; a device token is in the system
  key storage (Android Keystore, Windows credential store) and can be revoked alone. The API serves no browser session, so
  there are no cookies and no CSRF tokens. Roles come from governance.md; a device never gets a role of an agent.
- **Network**: cleartext on loopback only. The phone reaches the PC over the home network by TLS with the PC's own certificate,
  whose fingerprint the device takes with the one-time code and pins; a changed certificate is refused, not asked about.
  Outside the home network nothing is served until the owner switches it on (D6, T25). Nothing of PostgreSQL, Temporal or their interfaces is reachable.
- **Independent stop**: a button on the PC and the API route `stop all` end runs and close rights (every agent is
  suspended with the reason `owner_stop`: grants ended, tokens revoked, runs killed by identity) without the client, the
  Temporal server or a language model; for robots the stop is a hardware circuit and is not part of this client.
- **Audit**: every press records the device and session.

## Notifications

By default: significant results, decisions the owner owes, critical threats (security.md). Never a journal line, a
reasoning step, a staff measure or a routine operation. Push through Google is an external service and starts
only after the owner's order; until then Telegram and the open client deliver. Critical ones cannot be switched off, the
others by category and period.

## Provider terms

Checked before phase 4 and before any client work that starts an agent: [provider-terms.md](../reports/provider-terms.md)
with sources and date. The client is an interface to the factory, never to the provider's consumer service. Rules that hold
whatever the terms say: no unofficial consumer API, no token taken from another application, no bypass of a limit, no
automation of a consumer web page, no shared subscription, no secret through an open channel. A limit found in the terms
changes the integration; it is not worked around.

## Autonomy and migration

The factory works without the client, Telegram, the owner, or the internet, within its resources. PostgreSQL, Temporal and the
control components can move from the PC to a server with decisions, regulation, history, task state, configuration and
links intact; nothing in the code names an address or a place, the PC stays an executor. The move has no date and no stage
until the owner orders it. What that needs already: no host names in data, artifact storage behind an interface (file now,
S3 possible), a restore check, and an export of the full state that a test restores into an empty stack.

## Robotics

The content is defined by [robotics.md](robotics.md) (D34) and arrives by its stages, in the client's own sections as the
data exists: the robot registry and state, assignments and leases, skills and qualifications, diagnostics, maintenance, the
stop view and evidence. Physical tasks are ordinary tasks; a routine action of a qualified skill is not a dangerous operation and shows no second
press (the list of cases that do is in robotics.md, Ordinary physical work; actions on people, animals, dangerous tools, chemicals, hot
surfaces and mains voltage are refused, never offered for a press); hardware limits that no record or
grant can change stay on the robot. The client sends no motor command and has no motor screen; a stop pressed in it is a
request, and the screen shows the confirmed state reported by the robot, never the request (api.md, Robotics): after a
stop request the platform shows `stopping` until the robot confirms `stopped`, and its lease is already ended. The
client also shows the zones (`fenced` with the interlock and its last report, or `open`), and asks the owner's press
(one per task and zone, bound to them) for a start that may have people in the zone or that is unattended without a
valid unattended policy; changing a zone's access is a second press. The emergency stop never depends on a model, a cloud, Temporal or this client. The checks of this part are the `robot-*` ids
of [testing.md](testing.md), not the `client-*` ones below.

## Interface

Result before process, state clear without logs, details on request, few actions, no repeated questions. One navigation,
light and dark, Russian and English, the Reginleif Tech style. Texts come from the same message catalogue as Telegram.

## Metrics

Autonomous tasks, owner requests and unfounded ones, repeated questions, success, restarts, regressions, recoveries,
availability, cost, resources, time. The long goal is 99.99% of tasks done without the owner with the resources and rights
given. It is measured with its error and its sample; nobody splits tasks or hides errors for it.

## Phases

| Phase | Adds |
|---|---|
| 2 | conversations, devices, event stream, poll answer requests and approvals contracts in the API; nothing of the interface |
| 6 | the hub's second output to the API (the owner's hub fork) before the client's chat |
| 6 | the client MVP for Android and Windows: login, Dashboard, Chat, Tasks, Agents, Workers, Approvals, Notifications; it takes the place of the panel |
| 8 | Personnel, Registry, Governance, Projects, Infrastructure sections, as their data exists |
| 9 | push and voice, each on the owner's order or when its need exists |
| with R6 | the robotics sections by the stages of [robotics.md](robotics.md), Phases (the owner's order: R6 goes with the client) |

## Checks

| Id | Pass | Fails when |
|---|---|---|
| `client-contract` | generated library equals the API; only API calls leave the client | a drift or another host |
| `client-resume` | stream cut at any event: after reconnection every event is there once, also when a transaction that began earlier commits during the break (a row with a lower sequence number committed late); a foreign or damaged cursor is refused `bad_cursor` | one missing or doubled, or a late-committed row lost |
| `client-retry` | a mutation repeated after a lost answer is applied once; a dangerous operation never runs from an offline queue | applied twice, or sent by itself |
| `client-approval` | an approval with a changed parameter, used, expired, from a revoked device or from another channel is refused, on both platforms | accepted |
| `client-sessions` | an ordinary session and a Factory run appear in the chat, each message once; a `rig_session` poll has one arbiter, the hub: the client's answer is a durable request retried with its key until the hub confirms, a late answer is refused by the hub, and with the API down Telegram still relays and answers, and afterwards the hub's queue brings every missed record once; a Factory decision has one arbiter, the API, and its answer is written before delivery and applied once | a missing or doubled message, two answers, the API deciding a hub poll, a lost request, or Telegram stops with the API |
| `client-no-model` | the client makes no request to a provider or a model, directly or through a local model port; unparsed, forged or malformed messages stay plain text | a provider request leaves the client, or such a message acts as a command or an approval |
| `client-no-secret` | no token, key or password in the build, cache, log or stream; canary over all of them | a canary appears |
| `client-closed` | tasks go on with the client closed, and its state is right on return | a task depends on it |
| `client-foreign-prompt` | a third-party tool's own confirmation is never shown as an approval of the client, and its text never reaches the API (only the state "waits for a permission answer" is stored and shown with "answer in Telegram or at the terminal"); a message that looks like a prompt is plain text without controls; the owner's press on a native prompt is not recorded as a grant; a Factory `claude -p` run with an unreachable registry is denied, not left to a prompt (governance.md, Ordinary sessions) | it is shown, its text is stored or sent, a look-alike message gets controls, it is recorded as a grant, or a Factory run is left to a prompt |
| `client-stop` | stop-all ends runs and closes rights with Temporal, the client and the models down: a suspension with `owner_stop`, grants ended, tokens revoked, runs killed by identity | something runs on, or a right survives |
| `client-move` | the full state exported and restored into an empty stack: decisions, regulation, history, tasks and links are equal | a difference |
