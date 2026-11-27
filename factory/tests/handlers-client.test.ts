import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { clientPromptPolicy, readClientEvents, registerClientHandlers } from '../api/handlers/client.ts';
import { streams } from '../api/cursor.ts';
import { recordDecision } from '../api/decisions.ts';
import { createApiServer } from '../api/server.ts';
import { migrate } from '../db/migrate.ts';
import { createRepo, type Repo } from '../db/repo/index.ts';
import { connectBench, databaseBench, type DatabaseBench } from './database-bench.ts';

const benchPromise = databaseBench(import.meta.url);
const ownerId = randomUUID();
const taskId = randomUUID();
const factoryConversationId = randomUUID();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const roles = ['owner', 'hub', 'reader'] as const;
const tokens = Object.fromEntries(roles.map(role => [role, `afk_${role}_${randomUUID()}`])) as Record<typeof roles[number], string>;
const seconds = 1000; // Convert the test's settings in seconds to the injected clock's milliseconds.
const confirmationWindow = 60;
const codeTtl = 300;
// The injected API clock is fixed at module load. A slow file (parallel load) runs minutes after it, so the fixed clock is modelled
// as already stale by more than the confirmation window; the database's own now() (triggers) must never be compared against it.
let now = new Date(Date.now() - 2 * 60 * 1000);
let admin: ReturnType<typeof connectBench>;
let database: ReturnType<typeof connectBench>;
let bench: DatabaseBench;
let repo: Repo;
let api: ReturnType<typeof createApiServer>;
let base: string;
let horizon: (() => Promise<string>) | undefined;
let waitForEvents: ((signal: AbortSignal) => Promise<void>) | undefined;

async function startApi() {
  api = createApiServer({ tokens: repo.tokens, clock: () => now });
  registerClientHandlers(api, repo, {
    horizon: () => horizon ? horizon() : repo.audit.snapshotXmin(),
    waitForEvents: signal => waitForEvents?.(signal) ?? new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })),
  });
  base = `http://127.0.0.1:${(await api.listen(0)).port}`;
}

before(async () => {
  bench = await benchPromise;
  await migrate({ url: bench.migratorUrl });
  admin = connectBench(bench.migratorUrl);
  database = connectBench(bench.apiUrl);
  repo = createRepo(drizzle(database));
  await admin`INSERT INTO owners (id, name) VALUES (${ownerId}, 'Client owner')`;
  await admin`INSERT INTO tasks (id, depth, current_revision) VALUES (${taskId}, 0, 1)`;
  await Promise.all(roles.map(role => repo.tokens.create({
    id: randomUUID(), ownerId: role === 'owner' ? ownerId : null, role, prefix: role, tokenHash: hash(tokens[role].split('_')[2]!),
  })));
  await repo.settings.set('confirm.windowSeconds', confirmationWindow, ownerId);
  await repo.settings.set('device.codeTtlSeconds', codeTtl, ownerId);
  await repo.conversations.create({ id: factoryConversationId, source: 'factory', state: 'active', title: 'Factory conversation', taskId });
  await startApi();
});

after(async () => {
  await api?.close();
  await database?.end();
  await admin?.end();
});

async function call<T = Record<string, unknown>>(method: string, path: string, input: {
  token?: string; body?: unknown; status?: number; key?: string; confirm?: string;
} = {}): Promise<T> {
  const headers = new Headers();
  if (input.token) headers.set('Authorization', `Bearer ${input.token}`);
  if (method !== 'GET') headers.set('Idempotency-Key', input.key ?? randomUUID());
  if (input.confirm) headers.set('X-Confirm', input.confirm);
  if (input.body !== undefined) headers.set('Content-Type', 'application/json');
  const reply = await fetch(base + path, { method, headers, body: input.body === undefined ? undefined : JSON.stringify(input.body) });
  const raw = await reply.text();
  assert.equal(reply.status, input.status ?? 200, `${method} ${path} (code ${raw ? JSON.parse(raw).code : 'empty'})`);
  return raw ? JSON.parse(raw) as T : undefined as T;
}

type Confirmation = { confirmation_id: string; nonce: string; code: string };
type DeviceCode = { id: string; code: string; code_expires_at: string };
type Session = { id: string; secret: string; device_id: string };
type Message = { id: string; conversation_id: string; kind: string; body: string; parsed: unknown };
type Poll = { id: string; conversation_id: string; state: string; arbiter: string; answer_key: string | null; answer_requests: AnswerRequest[] };
type AnswerRequest = { id: string; state: string; delivered_at: string | null; refusal_reason: string | null; device_session_id: string | null };
type Page<T> = { items: T[]; next_cursor: string | null };
const confirmHeader = (first: Confirmation) => `${first.confirmation_id}.${first.nonce}`;
const deviceBody = { name: 'Owner phone', platform: 'android' };

async function createDevice() {
  const key = randomUUID();
  const first = await call<Confirmation>('POST', '/devices', { token: tokens.owner, body: deviceBody, key, status: 409 });
  assert.equal(first.code, 'confirmation_required');
  return call<DeviceCode>('POST', '/devices', { token: tokens.owner, body: deviceBody, confirm: confirmHeader(first), key, status: 201 });
}
async function enroll(code: string) {
  return call<Session>('POST', '/devices/enroll', { body: { code, name: 'Client install' }, status: 201 });
}
const token = (secret: string) => ({ token: secret });
const hub = token(tokens.hub);
const owner = token(tokens.owner);
const reader = token(tokens.reader);

test('device enrolment spends a code once, binds the second press and revokes devices and sessions immediately', async () => {
  const first = await call<Confirmation>('POST', '/devices', { ...owner, body: deviceBody, status: 409 });
  assert.equal(first.code, 'confirmation_required');
  const changed = await call('POST', '/devices', { ...owner, body: { ...deviceBody, name: 'Changed' }, confirm: confirmHeader(first), status: 409 });
  assert.equal(changed.code, 'confirmation_invalid');
  const key = randomUUID();
  const device = await call<DeviceCode>('POST', '/devices', { ...owner, body: deviceBody, confirm: confirmHeader(first), key, status: 201 });
  assert.equal(new Date(device.code_expires_at).getTime() - now.getTime(), codeTtl * seconds);
  assert.equal((await repo.devices.get(device.id))?.codeHash, hash(device.code));
  const replay = await call('POST', '/devices', { ...owner, body: deviceBody, confirm: confirmHeader(first), key, status: 409 });
  assert.equal(replay.code, 'token_already_issued');
  const reusedPress = await call('POST', '/devices', { ...owner, body: deviceBody, confirm: confirmHeader(first), status: 409 });
  assert.equal(reusedPress.code, 'confirmation_invalid');

  const session = await enroll(device.code);
  assert.equal((await repo.deviceSessions.get(session.id))?.tokenHash, hash(session.secret.replace(/^afk_[^_]+_/, '')));
  const enrollAgain = await call('POST', '/devices/enroll', { body: { code: device.code, name: 'Other install' }, status: 401 });
  assert.equal(enrollAgain.code, 'unauthenticated');
  const expiredDevice = await createDevice();
  const earlier = now;
  try {
    now = new Date(now.getTime() + codeTtl * seconds);
    const expired = await call('POST', '/devices/enroll', { body: { code: expiredDevice.code, name: 'Late install' }, status: 401 });
    assert.equal(expired.code, enrollAgain.code);
  } finally { now = earlier; }
  const devices = await call<Page<Record<string, unknown>>>('GET', '/devices?limit=1', token(session.secret));
  assert.ok(devices.next_cursor);
  const next = await call<Page<Record<string, unknown>>>('GET', `/devices?limit=1&cursor=${devices.next_cursor}`, token(session.secret));
  assert.notEqual(devices.items[0]?.id, next.items[0]?.id);
  const sessions = await call<Page<Record<string, unknown>>>('GET', `/devices/${device.id}/sessions`, owner);
  assert.deepEqual(sessions.items.map(row => row.id), [session.id]);
  assert.ok(sessions.items[0]?.last_used_at);
  for (const row of [...devices.items, ...next.items, ...sessions.items]) {
    for (const field of ['code', 'secret', 'code_hash', 'token_hash']) assert.equal(Object.hasOwn(row, field), false);
  }
  const denied = await call('POST', '/devices', { ...token(session.secret), body: deviceBody, status: 403 });
  assert.equal(denied.code, 'device_not_allowed');
  const revoked = await call('DELETE', `/device-sessions/${session.id}`, token(session.secret));
  assert.ok(revoked.revoked_at);
  const revokedSession = await call('GET', '/devices', { ...token(session.secret), status: 401 });
  assert.equal(revokedSession.code, 'device_revoked');

  const another = await createDevice();
  const secondSession = await enroll(another.code);
  assert.ok((await call('DELETE', `/devices/${another.id}`, owner)).revoked_at);
  assert.ok((await repo.deviceSessions.get(secondSession.id))?.revokedAt);
  assert.equal((await call('GET', '/devices', { ...token(secondSession.secret), status: 401 })).code, 'device_revoked');
  const audit = await admin<{ action: string; device_session_id: string | null }[]>`SELECT action, device_session_id FROM audit_log WHERE action IN ('device.enroll', 'device.revoke', 'session.revoke') AND outcome = 'ok'`;
  assert.ok(audit.some(row => row.action === 'device.enroll' && row.device_session_id === session.id));
  assert.ok(audit.some(row => row.action === 'session.revoke' && row.device_session_id === session.id));
  assert.ok(audit.some(row => row.action === 'device.revoke'));
});

const hubItem = (session_ref: string, key: string, kind: string, content: object) => ({ session_ref, key, kind, content });
const chatMessage = (sessionRef: string, body: string) => hubItem(sessionRef, randomUUID(), 'text', { body });
const options = [{ key: 'yes', label: 'Yes', recommended: true }, { key: 'no', label: 'No', recommended: false }];
const hubPoll = (sessionRef: string) => hubItem(sessionRef, randomUUID(), 'poll', { question: 'Choose', options });
const pollPath = (poll: Poll) => `/conversations/${poll.conversation_id}/polls/${poll.id}`;
const hubResult = (request: AnswerRequest) => `/hub/poll-answers/${request.id}/result`;

// xids are cluster-wide: a transaction open in another database (a parallel test file) holds the snapshot xmin below this database's
// own commits, so a stream read with the default horizon can miss rows committed a moment ago. Reads that assert on fresh rows use
// the next xid as the horizon, which covers every commit of this database.
const nextXid = async () => String((await admin<{ horizon: string }[]>`SELECT (pg_current_xact_id()::text::bigint + 1)::text AS horizon`)[0]!.horizon);

test('client-sessions: the fake hub can keep taking presses while the API is down and replay the queue', async () => {
  // Deterministic model of a parallel test file: a foreign transaction holds an xid open for the whole test.
  const holder = connectBench(bench.apiUrl);
  const holding = await holder.reserve();
  await holding`BEGIN`;
  await holding`SELECT pg_current_xact_id()`;
  horizon = nextXid;
  try {
    await replayWhileApiIsDown();
  } finally {
    horizon = undefined;
    await holding`ROLLBACK`.catch(() => {});
    holding.release();
    await holder.end();
  }
});

async function replayWhileApiIsDown() {
  const sessionRef = randomUUID();
  const first = chatMessage(sessionRef, 'First delivered item');
  const message = await call<Message>('POST', '/hub/messages', { ...hub, body: first, status: 201 });
  const poll = await call<Poll>('POST', '/hub/polls', { ...hub, body: hubPoll(sessionRef), status: 201 });
  assert.equal(poll.arbiter, 'hub');
  const pendingKey = randomUUID();
  const client = token((await enroll((await createDevice()).code)).secret);
  const pending = await call<AnswerRequest>('POST', pollPath(poll) + '/answer', { ...client, body: { answer_key: 'no' }, key: pendingKey, status: 202 });
  assert.equal(pending.state, 'pending');
  assert.equal((await call<Poll>('GET', pollPath(poll), client)).state, 'open');
  await api.close();
  // The fake hub decides from its locally open choice and retains outbound records across the HTTP outage.
  const telegram = { answer_key: 'yes', answered_via: 'telegram' };
  const queued = [first, chatMessage(sessionRef, 'Queued while the API was down')];
  await assert.rejects(fetch(base + '/conversations'));
  await startApi();
  assert.equal((await call<Poll>('POST', `/hub/polls/${poll.id}/result`, { ...hub, body: telegram })).answer_key, 'yes');
  assert.equal((await call<{ code: string }>('POST', `/hub/polls/${poll.id}/result`, { ...hub, body: telegram, status: 409 })).code, 'poll_closed');
  const refused = { state: 'refused', refusal_reason: 'poll_closed', hub_ref: randomUUID() };
  assert.equal((await call<AnswerRequest>('POST', hubResult(pending), { ...hub, body: refused })).state, 'refused');
  const retry = await call<AnswerRequest>('POST', pollPath(poll) + '/answer', { ...client, body: { answer_key: 'no' }, key: pendingKey, status: 202 });
  assert.equal(retry.id, pending.id);
  assert.equal(retry.refusal_reason, 'poll_closed');
  assert.equal((await call<Message>('POST', '/hub/messages', { ...hub, body: queued[0] })).id, message.id);
  const second = await call<Message>('POST', '/hub/messages', { ...hub, body: queued[1], status: 201 });
  assert.equal((await call<Message>('POST', '/hub/messages', { ...hub, body: queued[1] })).id, second.id);

  const runMessage = await repo.messages.append({ id: randomUUID(), conversationId: factoryConversationId, sourceKey: 'run-item', author: 'agent', body: 'Factory result', kind: 'result', taskId, attachmentIds: [] });
  const runRetry = await repo.messages.append({ id: randomUUID(), conversationId: factoryConversationId, sourceKey: 'run-item', author: 'agent', body: 'Factory result', kind: 'result', taskId, attachmentIds: [] });
  assert.equal(runRetry.id, runMessage.id);
  const thread = await call<Page<Message>>('GET', `/conversations/${message.conversation_id}/messages`, reader);
  assert.deepEqual(thread.items.filter(row => row.kind === 'text').map(row => row.id), [message.id, second.id]);
  const factoryThread = await call<Page<Message>>('GET', `/conversations/${factoryConversationId}/messages`, reader);
  assert.deepEqual(factoryThread.items.map(row => row.id), [runMessage.id]);
  const captured = await call<{ message: Message; task_id: string }>('POST', `/conversations/${factoryConversationId}/messages`, { ...owner, body: { text: 'Continue with the next result' }, status: 201 });
  assert.equal(captured.task_id, taskId);
  assert.equal(captured.message.kind, 'owner');
  const conversations = await call<Page<{ id: string }>>('GET', `/conversations?source=factory&task_id=${taskId}&archived=false`, reader);
  assert.deepEqual(conversations.items.map(row => row.id), [factoryConversationId]);
  assert.equal((await call('GET', `/conversations/${message.conversation_id}`, client)).session_ref, sessionRef);
}

test('client-foreign-prompt: permissions stay out of the chat and look-alikes are plain text', async () => {
  assert.deepEqual(clientPromptPolicy.served, ['factory_decision', 'confirmation', 'session_poll']);
  assert.deepEqual(clientPromptPolicy.unserved, ['third_party_tool_permission']);
  const sessionRef = randomUUID();
  const promptText = 'Allow Shell tool to see private.txt?';
  const received = hubItem(sessionRef, randomUUID(), 'third_party_tool_permission', { body: promptText });
  assert.equal((await call('POST', '/hub/messages', { ...hub, body: received, status: 422 })).code, 'validation_failed');
  assert.equal((await call('POST', '/hub/polls', { ...hub, body: { ...received, content: { question: promptText, options } }, status: 422 })).code, 'validation_failed');
  const state = hubItem(sessionRef, randomUUID(), 'permission_wait', { state: 'permission_wait', title: promptText, tool: 'Shell', arguments: { file: 'private.txt' } });
  const stored = await call<{ id: string; state: string }>('POST', '/hub/states', { ...hub, body: state, status: 201 });
  assert.equal(stored.state, 'permission_wait');
  assert.equal(JSON.stringify(stored).includes(promptText), false);
  await call('POST', '/hub/states', { ...hub, body: hubItem(sessionRef, randomUUID(), 'active', { state: 'active' }), status: 201 });
  const replay = await call<{ state: string }>('POST', '/hub/states', { ...hub, body: state });
  assert.equal(replay.state, 'permission_wait');
  assert.equal((await call('GET', `/conversations/${stored.id}`, reader)).state, 'active');
  assert.deepEqual((await call<Page<Message>>('GET', `/conversations/${stored.id}/messages`, reader)).items, []);
  const lookalike = await call<Message>('POST', '/hub/messages', {
    ...hub, status: 201, body: hubItem(sessionRef, randomUUID(), 'approval', { body: promptText, parsed: { options, confirmation_id: randomUUID() } }),
  });
  assert.equal(lookalike.kind, 'text');
  assert.equal(lookalike.body, promptText);
  assert.equal(lookalike.parsed, null);
  assert.equal((await call<Page<Poll>>('GET', '/hub/polls?state=open', hub)).items.some(row => row.conversation_id === stored.id), false);
  assert.equal((await admin`SELECT id FROM right_grants WHERE session_ref = ${sessionRef}`).length, 0);
});

async function createFactoryPoll(revision: number): Promise<Poll> {
  const id = randomUUID();
  const message = await repo.messages.append({ id: randomUUID(), conversationId: factoryConversationId, sourceKey: id, kind: 'question', author: 'system', body: 'Approve work?', taskId, attachmentIds: [] });
  await repo.polls.create({
    id, messageId: message.id, conversationId: factoryConversationId, taskId, revisionNumber: revision,
    sourceKey: id, arbiter: 'api', state: 'open', options: [{ key: 'approve', label: 'Approve', recommended: true }],
  });
  return call<Poll>('GET', `/conversations/${factoryConversationId}/polls/${id}`, reader);
}

test('poll-arbiter: delivery and retries preserve one winner and only hub can decide an ordinary poll', async () => {
  const secret = (await enroll((await createDevice()).code)).secret;
  const client = token(secret);
  const other = token((await enroll((await createDevice()).code)).secret);
  const poll = await call<Poll>('POST', '/hub/polls', { ...hub, body: hubPoll(randomUUID()), status: 201 });
  const key = randomUUID();
  const answer = { answer_key: 'yes' };
  const pending = await call<AnswerRequest>('POST', pollPath(poll) + '/answer', { ...client, body: answer, key, status: 202 });
  const conflict = await call('POST', pollPath(poll) + '/answer', { ...client, body: { answer_key: 'no' }, key, status: 409 });
  assert.equal(conflict.code, 'idempotency_conflict');
  assert.deepEqual((await call<Poll>('GET', pollPath(poll), other)).answer_requests, []);
  assert.deepEqual((await call<Poll>('GET', pollPath(poll), reader)).answer_requests, []);
  const delivered = (await call<Page<AnswerRequest>>('GET', '/hub/poll-answers', hub)).items.find(row => row.id === pending.id);
  assert.ok(delivered?.delivered_at);
  assert.deepEqual((await call<Page<AnswerRequest>>('GET', '/hub/poll-answers', hub)).items.find(row => row.id === pending.id), delivered);
  const decision = { state: 'accepted', hub_ref: randomUUID() };
  await call('POST', hubResult(pending), { ...owner, body: decision, status: 403 });
  await call('POST', hubResult(pending), { ...client, body: decision, status: 403 });
  assert.equal((await call<Poll>('GET', pollPath(poll), client)).state, 'open');
  const accepted = await call<AnswerRequest>('POST', hubResult(pending), { ...hub, body: decision });
  assert.deepEqual(await call<AnswerRequest>('POST', hubResult(pending), { ...hub, body: decision }), accepted);
  assert.equal((await call('POST', hubResult(pending), { ...hub, body: { state: 'refused', refusal_reason: 'poll_closed' }, status: 409 })).code, 'request_closed');
  const telegramLate = await call('POST', `/hub/polls/${poll.id}/result`, { ...hub, body: { ...answer, answered_via: 'telegram' }, status: 409 });
  assert.equal(telegramLate.code, 'poll_closed');
  assert.equal(telegramLate.answered_via, 'client');
  assert.equal((await call<Poll>('GET', pollPath(poll), client)).answer_requests[0]?.state, 'accepted');
  const late = await call<AnswerRequest>('POST', pollPath(poll) + '/answer', { ...owner, body: answer, status: 202 });
  assert.equal(late.state, 'pending');
  assert.equal((await call<AnswerRequest>('POST', hubResult(late), { ...hub, body: { state: 'refused', refusal_reason: 'poll_closed' } })).state, 'refused');

  const revision = 1; // The seeded task's first revision.
  const factory = await createFactoryPoll(revision);
  const factoryAnswer = { answer_key: 'approve' };
  const factoryKey = randomUUID();
  const claimed = await call<{ id: string }>('POST', pollPath(factory) + '/answer', { ...client, body: factoryAnswer, key: factoryKey, status: 202 });
  assert.equal((await call<{ id: string }>('POST', pollPath(factory) + '/answer', { ...client, body: factoryAnswer, key: factoryKey, status: 202 })).id, claimed.id);
  assert.equal((await call('POST', pollPath(factory) + '/answer', { ...owner, body: factoryAnswer, status: 409 })).code, 'poll_closed');
  const telegram = { channel: 'telegram' as const, actorId: ownerId, kind: 'approve' as const, taskId, windowSeconds: confirmationWindow };
  await assert.rejects(recordDecision(repo, {
    ...telegram, idempotencyKey: randomUUID(), pressId: randomUUID(), body: { revision_number: revision, comment: '' },
  }), { code: 'poll_closed' });
  assert.equal((await repo.polls.get(factory.id))?.decisionId, claimed.id);
  assert.equal((await repo.decisions.listForTask(taskId)).length, 1);
  await call('POST', `/hub/polls/${factory.id}/result`, { ...hub, body: { ...factoryAnswer, answered_via: 'telegram' }, status: 404 });
  assert.ok((await call<Page<Poll>>('GET', '/hub/polls?state=answered', hub)).items.some(row => row.id === factory.id));
  assert.equal((await call<Page<Poll>>('GET', '/hub/polls?state=answered', hub)).items.some(row => row.id === poll.id), false);

  const nextRevision = revision + 1;
  const fromTelegram = await createFactoryPoll(nextRevision);
  const won = await recordDecision(repo, {
    ...telegram, idempotencyKey: randomUUID(), pressId: randomUUID(), body: { revision_number: nextRevision, comment: '' },
  });
  assert.equal(won.status, 202);
  assert.equal((await call('POST', pollPath(fromTelegram) + '/answer', { ...client, body: factoryAnswer, status: 409 })).answered_via, 'telegram');
});

test('stop-all binds both presses and transactionally suspends runs and rights, revokes credentials and queues stops', async () => {
  const agentId = randomUUID(), runId = randomUUID(), executionId = randomUUID(), runTokenId = randomUUID();
  await admin`INSERT INTO agents (id) VALUES (${agentId})`;
  await admin`INSERT INTO task_runs (id, task_id, agent_id, status, execution_id) VALUES (${runId}, ${taskId}, ${agentId}, 'running', ${executionId})`;
  await repo.tokens.create({ id: runTokenId, prefix: 'run', role: 'registry', runId, tokenHash: hash(randomUUID()) });
  const rightRequestId = randomUUID();
  const rightHash = hash('stop-all right fixture');
  await admin`INSERT INTO right_requests (id, task_id, run_id, handling_task_id, action, target, conditions, request_hash)
    VALUES (${rightRequestId}, ${taskId}, ${runId}, ${taskId}, 'read', 'fixture', '{}'::jsonb, ${rightHash})`;
  await admin`INSERT INTO right_answers (id, request_id, step, step_kind, answer)
    VALUES (${randomUUID()}, ${rightRequestId}, 1, 'code', 'call_owner')`;
  const grantConfirmation = randomUUID();
  await repo.confirmations.create({ id: grantConfirmation, actorId: ownerId, channel: 'api', operation: 'right.grant', targetType: 'right_requests',
    targetId: rightRequestId, requestHash: rightHash, expiresAt: new Date(Date.now() + confirmationWindow * seconds) }); // The migration trigger checks it against the database's real now(), not the injected clock.
  await admin`INSERT INTO right_answers (id, request_id, step, step_kind, answer, owner_act_ref)
    VALUES (${randomUUID()}, ${rightRequestId}, 2, 'owner', 'grant', ${grantConfirmation})`;

  const key = randomUUID();
  const first = await call<Confirmation>('POST', '/system/stop-all', { ...owner, key, status: 409 });
  assert.equal(first.code, 'confirmation_required');
  assert.equal(await repo.rightsSuspensions.openForAgent(agentId), undefined);
  assert.equal((await call('POST', '/system/stop-all', { ...owner, body: { scope: 'everything' }, status: 422 })).code, 'validation_failed');
  const device = token((await enroll((await createDevice()).code)).secret);
  assert.equal((await call('POST', '/system/stop-all', { ...device, confirm: confirmHeader(first), status: 409 })).code, 'confirmation_invalid');
  await call('POST', '/system/stop-all', { ...owner, confirm: confirmHeader(first), key, status: 204 });
  await call('POST', '/system/stop-all', { ...owner, confirm: confirmHeader(first), key, status: 204 });
  const suspension = await repo.rightsSuspensions.openForAgent(agentId);
  assert.equal(suspension?.reason, 'owner_stop');
  const [grant] = await admin<{ ended_by: string; suspension_id: string }[]>`SELECT ended_by, suspension_id FROM right_grants WHERE request_id = ${rightRequestId}`;
  assert.deepEqual(grant, { ended_by: 'critical', suspension_id: suspension?.id });
  assert.ok((await repo.tokens.list()).find(row => row.id === runTokenId)?.revokedAt);
  const stops = (await repo.outbox.listPending()).filter(row => row.kind === 'stop_run');
  assert.deepEqual(stops.filter(row => (row.payload as { run_id: string }).run_id === runId).map(row => row.payload), [{ run_id: runId, execution_id: executionId }]);
  assert.equal((await admin`SELECT id FROM audit_log WHERE id = ${suspension!.auditId} AND actor_id = ${ownerId}`).length, 1);
});

async function openEvents(path: string, lastEventId?: string) {
  const headers = new Headers({ Authorization: `Bearer ${tokens.reader}` });
  if (lastEventId) headers.set('Last-Event-ID', lastEventId);
  const response = await fetch(base + path, { headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type')!, /^text\/event-stream/);
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  return {
    close: () => reader.cancel(),
    async next() {
      while (!buffer.includes('\n\n')) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        buffer += chunk.value;
      }
      const boundary = buffer.indexOf('\n\n');
      const [cursor, stream, data] = buffer.slice(0, boundary).split('\n');
      buffer = buffer.slice(boundary + 2);
      return { id: cursor!.slice('id: '.length), stream: stream!.slice('event: '.length), data: JSON.parse(data!.slice('data: '.length)) as Message };
    },
  };
}

test('SSE resumes with Last-Event-ID and independent stream cursors across a held transaction', async () => {
  // xids are cluster-wide, so a transaction open in any other database (parallel test files) holds the snapshot's xmin below this
  // database's own commits. Model that: a transaction opened first, then a commit that the xmin snapshot does not cover.
  const holder = connectBench(bench.apiUrl);
  const holding = await holder.reserve();
  await holding`BEGIN`;
  await holding`SELECT pg_current_xact_id()`;
  await admin`INSERT INTO audit_log (id, action, outcome) VALUES (${randomUUID()}, 'probe.after_holder', 'ok')`;
  // The baseline must cover every row committed so far in this database, so its horizon is the next xid, not the xmin snapshot.
  const [next] = await admin<{ covering: string }[]>`SELECT (pg_current_xact_id()::text::bigint + 1)::text AS covering`;
  const covering = next!.covering;
  const baseline = new URLSearchParams();
  for (const stream of streams) {
    const cursor = (await readClientEvents(repo, stream, { limit: Number.MAX_SAFE_INTEGER, horizon: async () => covering })).next_cursor;
    if (cursor) baseline.append('cursor', cursor);
  }
  const path = '/events/stream?' + baseline;
  const firstWriter = connectBench(bench.apiUrl);
  const secondWriter = connectBench(bench.apiUrl);
  const firstConnection = await firstWriter.reserve();
  const earlyId = randomUUID(), lateId = randomUUID();
  let first: Awaited<ReturnType<typeof openEvents>> | undefined;
  let resumed: Awaited<ReturnType<typeof openEvents>> | undefined;
  try {
    await firstConnection`BEGIN`;
    const [early] = await firstConnection<{ xid: string }[]>`SELECT pg_current_xact_id()::text AS xid`;
    await secondWriter`INSERT INTO messages (id, conversation_id, source_key, kind, author, body, attachment_ids)
      VALUES (${lateId}, ${factoryConversationId}, ${lateId}, 'text', 'agent', 'Allocated seq first', ARRAY[]::uuid[])`;
    await firstConnection`INSERT INTO messages (id, conversation_id, source_key, kind, author, body, attachment_ids)
      VALUES (${earlyId}, ${factoryConversationId}, ${earlyId}, 'text', 'agent', 'Earlier transaction', ARRAY[]::uuid[])`;
    let below = early!.xid;
    horizon = async () => below;
    let release!: () => void;
    let observed!: () => void;
    const waiting = new Promise<void>(resolve => { observed = resolve; });
    waitForEvents = signal => new Promise<void>(resolve => {
      release = resolve;
      signal.addEventListener('abort', () => resolve(), { once: true });
      observed();
    });
    first = await openEvents(path);
    await waiting;
    await firstConnection`COMMIT`;
    const committed = await database<{ xid: string }[]>`SELECT commit_xid::text AS xid FROM messages WHERE id IN (${earlyId}, ${lateId}) ORDER BY commit_xid DESC`;
    below = String(BigInt(committed[0]!.xid) + 1n);
    release();
    const event = await first.next();
    assert.equal(event.stream, 'messages');
    assert.equal(event.data.id, earlyId);
    assert.equal(Object.hasOwn(event.data, 'commit_xid'), false);
    await first.close();
    resumed = await openEvents(path, event.id);
    assert.equal((await resumed.next()).data.id, lateId);
    const thirdId = randomUUID();
    await secondWriter`INSERT INTO messages (id, conversation_id, source_key, kind, author, body, attachment_ids)
      VALUES (${thirdId}, ${factoryConversationId}, ${thirdId}, 'text', 'agent', 'After reconnect', ARRAY[]::uuid[])`;
    const [third] = await database<{ xid: string }[]>`SELECT commit_xid::text AS xid FROM messages WHERE id = ${thirdId}`;
    below = String(BigInt(third!.xid) + 1n);
    release();
    assert.equal((await resumed.next()).data.id, thirdId);
    const malformed = await fetch(base + path, { headers: { Authorization: `Bearer ${tokens.reader}`, 'Last-Event-ID': 'invalid!' } });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json() as { code: string }).code, 'bad_cursor');
  } finally {
    await Promise.allSettled([first?.close(), resumed?.close()]);
    horizon = undefined;
    waitForEvents = undefined;
    await firstConnection`ROLLBACK`.catch(() => {});
    firstConnection.release();
    await holding`ROLLBACK`.catch(() => {});
    holding.release();
    await Promise.all([firstWriter.end(), secondWriter.end(), holder.end()]);
  }
});

test('the event stream carries task events as frames and resumes after a stream cursor', async () => {
  // Moved from the admin handlers, whose one-shot /events/stream the live stream replaced.
  const marker = randomUUID();
  const insertEvent = async (n: number) => admin`INSERT INTO task_events (id, task_id, event_type, actor_type, dedupe_key)
    VALUES (${randomUUID()}, ${taskId}, 'stream_probe', 'system', ${`${marker}-${n}`})`;
  for (const n of [1, 2, 3]) await insertEvent(n);
  // Same technique as the admin tests: xids are cluster-wide, so a horizon above this database's commits is set directly.
  const above = async () => String((await admin<{ horizon: string }[]>`SELECT (pg_current_xact_id()::text::bigint + 1)::text AS horizon`)[0]!.horizon);
  horizon = above;
  let opened: Awaited<ReturnType<typeof openEvents>> | undefined;
  let resumed: Awaited<ReturnType<typeof openEvents>> | undefined;
  try {
    opened = await openEvents('/events/stream');
    const seen: { id: string; stream: string; data: { event_type?: string } }[] = [];
    while (seen.filter(event => event.data.event_type === 'stream_probe').length < 3) {
      const event = await opened.next() as (typeof seen)[number];
      assert.ok(seen.length < 1000, 'the stream never delivered the three task events');
      assert.equal(event.stream, 'task_events');
      seen.push(event);
    }
    const probes = seen.filter(event => event.data.event_type === 'stream_probe');
    await opened.close();
    await insertEvent(4);
    resumed = await openEvents(`/events/stream?cursor=${encodeURIComponent(probes[2]!.id)}`);
    const next = await resumed.next() as (typeof seen)[number];
    assert.equal(next.stream, 'task_events');
    assert.equal(next.data.event_type, 'stream_probe');
    assert.ok(!probes.some(event => event.id === next.id), 'the resumed stream repeated a delivered event');
    const malformed = await fetch(base + '/events/stream?cursor=garbage', { headers: { Authorization: `Bearer ${tokens.reader}` } });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json() as { code: string }).code, 'bad_cursor');
  } finally {
    await Promise.allSettled([opened?.close(), resumed?.close()]);
    horizon = undefined;
  }
});
