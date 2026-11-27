import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTelegramClient } from '../telegram/client.ts';
import { createRelayClient, registerRelayHandlers } from '../telegram/relay-role.ts';
import { createApiServer } from '../api/server.ts';
import type { Repo } from '../db/repo/index.ts';
import { createHash, randomUUID } from 'node:crypto';

test('a repeated send key delivers one draft list with stable buttons', async () => {
  const sent: unknown[] = [];
  const client = createTelegramClient({ send: async message => { sent.push(message); return 'message'; } });
  const drafts = [{ id: 'draft-one', pressId: 'press-one', text: 'First draft' }, { id: 'draft-two', pressId: 'press-two', text: 'Second draft' }];
  assert.equal(await client.sendDrafts('chat', 'list-key', drafts), 'message');
  assert.equal(await client.sendDrafts('chat', 'list-key', drafts), 'message');
  assert.equal(sent.length, 1);
  assert.deepEqual((sent[0] as any).buttons.map((button: any) => button.id), ['press-one', 'press-two']);
});

test('a send key cannot silently hide a different draft list', async () => {
  const client = createTelegramClient({ send: async () => 'message' });
  await client.sendDrafts('chat', 'same-key', [{ id: 'a', pressId: 'press-a', text: 'First' }]);
  await assert.rejects(client.sendDrafts('chat', 'same-key', [{ id: 'b', pressId: 'press-b', text: 'Second' }]), /key/i);
});

test('relay client passes the relay token and press unchanged through its injected transport', async () => {
  let request: any;
  const relay = createRelayClient('afk_relay_secret', async value => { request = value; return { status: 200, body: {} }; });
  const body = { press_id: 'press', telegram_user_id: 42, poll_id: randomUUID(), option_index: 0 };
  await relay.capture(body, 'capture-key');
  assert.deepEqual(request, { method: 'POST', path: '/registry/captures', token: 'afk_relay_secret', key: 'capture-key', body });
});

test('relay registers the exact poll under the authenticated relay role', async () => {
  const tokenHash = createHash('sha256').update('secret').digest('hex');
  const inquiry = randomUUID();
  let registered: unknown;
  const repo = { transaction: async (fn: any) => fn({ idempotencyKeys: { claim: async () => ({ replayed: false }), complete: async () => {} }, registry: { inquiries: {
    get: async () => ({ id: inquiry }),
    registerPoll: async (_id: string, value: unknown) => { registered = value; return { id: inquiry, category: 'other', projectId: null, reuseIntent: 'once' }; },
  } } }) } as unknown as Repo;
  const api = createApiServer({ tokens: { byHash: async () => ({ id: randomUUID(), role: 'relay', prefix: 'relay', tokenHash, workerId: null, revokedAt: null, expiresAt: null, validUntil: null }) } });
  registerRelayHandlers(api, repo);
  const { port } = await api.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/registry/polls`, { method: 'POST', headers: { authorization: 'Bearer afk_relay_secret', 'content-type': 'application/json', 'idempotency-key': 'test-key-001' }, body: JSON.stringify({ inquiry_id: inquiry, question: 'Question?', options: [{ key: 'a', label: 'Answer' }] }) });
    assert.equal(response.status, 201);
    assert.equal((await response.json() as any).poll_id, inquiry);
    assert.equal((registered as any).pollQuestion, 'Question?');
  } finally { await api.close(); }
});

test('drafts route returns an empty page for an empty registry', async () => {
  const tokenHash = createHash('sha256').update('secret').digest('hex');
  const api = createApiServer({ tokens: { byHash: async () => ({ id: randomUUID(), role: 'relay', prefix: 'relay', tokenHash, workerId: null, revokedAt: null, expiresAt: null, validUntil: null }) } });
  registerRelayHandlers(api, { settings: { snapshot: async () => ({}) }, registry: { records: { list: async () => [] } } } as unknown as Repo);
  const { port } = await api.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/registry/drafts`, { headers: { authorization: 'Bearer afk_relay_secret' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { items: [], next_cursor: null });
  } finally { await api.close(); }
});

test('draft pages respect configured bounds and continue after a removed row', async () => {
  const tokenHash = createHash('sha256').update('secret').digest('hex');
  const now = new Date('2030-01-01T00:00:00Z');
  const rows = [2n, 1n].map(number => ({ id: randomUUID(), number, kind: 'decision', authority: 'owner', status: 'draft', scopeType: 'global', category: 'test', problem: 'Question', decision: 'Answer', version: 1, source: 'import', createdBy: { id: randomUUID() }, createdAt: now, statusChangedAt: null, tags: null }));
  const repo = { settings: { snapshot: async () => ({ 'page.default': 1, 'page.max': 2 }) }, registry: { records: { list: async () => rows, history: async () => [] }, links: { forRecord: async () => [] } } } as unknown as Repo;
  const api = createApiServer({ tokens: { byHash: async () => ({ id: randomUUID(), role: 'relay', prefix: 'relay', tokenHash, workerId: null, revokedAt: null, expiresAt: null, validUntil: null }) } });
  registerRelayHandlers(api, repo);
  const { port } = await api.listen(0);
  try {
    const get = (query = '') => fetch(`http://127.0.0.1:${port}/registry/drafts${query}`, { headers: { authorization: 'Bearer afk_relay_secret' } });
    const first = await (await get()).json() as any;
    assert.equal(first.items[0].id, rows[0]!.id);
    assert.equal(first.items[0].status_changed_at, null);
    rows.shift();
    const second = await (await get(`?cursor=${encodeURIComponent(first.next_cursor)}`)).json() as any;
    assert.equal(second.items[0].id, rows[0]!.id);
    assert.equal(second.next_cursor, null);
    assert.equal((await get('?limit=3')).status, 422);
  } finally { await api.close(); }
});

test('capture refuses an unmapped Telegram user before recording', async () => {
  const tokenHash = createHash('sha256').update('secret').digest('hex');
  const tx = { idempotencyKeys: { claim: async () => ({ replayed: false }) }, owners: { byTelegramUserId: async () => undefined }, registry: { records: { captureByPress: async () => ({ id: 'existing' }) } } };
  const repo = { transaction: async (fn: any) => fn(tx) } as unknown as Repo;
  const api = createApiServer({ tokens: { byHash: async () => ({ id: randomUUID(), role: 'relay', prefix: 'relay', tokenHash, workerId: null, revokedAt: null, expiresAt: null, validUntil: null }) } });
  registerRelayHandlers(api, repo);
  const { port } = await api.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/registry/captures`, { method: 'POST', headers: { authorization: 'Bearer afk_relay_secret', 'content-type': 'application/json', 'idempotency-key': 'test-key-002' }, body: JSON.stringify({ poll_id: randomUUID(), press_id: 'press', telegram_user_id: 42, option_index: 0 }) });
    assert.equal(response.status, 403);
    assert.equal((await response.json() as any).code, 'forbidden');
  } finally { await api.close(); }
});

test('a missing inquiry returns not_found from poll registration', async () => {
  const tokenHash = createHash('sha256').update('secret').digest('hex');
  const tx = { idempotencyKeys: { claim: async () => ({ replayed: false }) }, registry: { inquiries: { get: async () => undefined } } };
  const repo = { transaction: async (fn: any) => fn(tx) } as unknown as Repo;
  const api = createApiServer({ tokens: { byHash: async () => ({ id: randomUUID(), role: 'relay', prefix: 'relay', tokenHash, workerId: null, revokedAt: null, expiresAt: null, validUntil: null }) } });
  registerRelayHandlers(api, repo);
  const { port } = await api.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/registry/polls`, { method: 'POST', headers: { authorization: 'Bearer afk_relay_secret', 'content-type': 'application/json', 'idempotency-key': 'test-key-003' }, body: JSON.stringify({ inquiry_id: randomUUID(), question: 'Question?', options: [{ key: 'a', label: 'Answer' }] }) });
    assert.equal(response.status, 404);
    assert.equal((await response.json() as any).code, 'not_found');
  } finally { await api.close(); }
});

test('a registered poll press is recorded once for its mapped owner', async () => {
  const tokenHash = createHash('sha256').update('secret').digest('hex');
  const poll = randomUUID(), owner = randomUUID(), now = new Date('2030-01-01T00:00:00Z');
  let saved: any;
  const tx = { idempotencyKeys: { claim: async () => ({ replayed: false }), complete: async () => {} }, owners: { byTelegramUserId: async (id: bigint) => id === 42n ? { id: owner } : undefined }, registry: {
    lock: async () => {}, inquiries: { get: async () => ({ id: poll, pollRegisteredAt: now, pollQuestion: 'Pick one', pollOptions: [{ key: 'a', label: 'Exact answer' }], category: 'other', projectId: null, reuseIntent: 'once' }) },
    results: { forInquiry: async () => [] }, links: { forRecord: async () => [] }, records: {
      captureByPress: async (id: string) => saved?.pressId === id ? saved : undefined,
      captureByInquiry: async () => saved, history: async () => [],
      create: async (input: any) => saved = { ...input, number: 1n, version: 1, createdAt: now },
    },
  } };
  const repo = { transaction: async (fn: any) => fn(tx) } as unknown as Repo;
  const api = createApiServer({ tokens: { byHash: async () => ({ id: randomUUID(), role: 'relay', prefix: 'relay', tokenHash, workerId: null, revokedAt: null, expiresAt: null, validUntil: null }) }, clock: () => now });
  registerRelayHandlers(api, repo);
  const { port } = await api.listen(0);
  try {
    const send = (key: string) => fetch(`http://127.0.0.1:${port}/registry/captures`, { method: 'POST', headers: { authorization: 'Bearer afk_relay_secret', 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ poll_id: poll, press_id: 'press-1', telegram_user_id: 42, option_index: 0 }) });
    const first = await send('capture-key-1');
    assert.equal(first.status, 200);
    assert.equal((await first.json() as any).pressed_option, 'Exact answer');
    assert.equal(saved.createdBy.id, owner);
    assert.equal((await send('capture-key-2')).status, 409);
  } finally { await api.close(); }
});

test('a press that completes while its idempotency claim waits is still refused as replay', async () => {
  const tokenHash = createHash('sha256').update('secret').digest('hex');
  let checks = 0;
  const tx = { owners: { byTelegramUserId: async () => ({ id: randomUUID() }) }, registry: { records: { captureByPress: async () => ++checks === 1 ? undefined : { id: randomUUID() } } }, idempotencyKeys: { claim: async (input: any) => ({ replayed: true, row: { requestHash: input.requestHash, state: 'done', responseStatus: 200, responseBody: {} } }) } };
  const api = createApiServer({ tokens: { byHash: async () => ({ id: randomUUID(), role: 'relay', prefix: 'relay', tokenHash, workerId: null, revokedAt: null, expiresAt: null, validUntil: null }) } });
  registerRelayHandlers(api, { transaction: async (fn: any) => fn(tx) } as unknown as Repo);
  const { port } = await api.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/registry/captures`, { method: 'POST', headers: { authorization: 'Bearer afk_relay_secret', 'content-type': 'application/json', 'idempotency-key': 'capture-key' }, body: JSON.stringify({ poll_id: randomUUID(), press_id: 'press', telegram_user_id: 42, option_index: 0 }) });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as any).code, 'press_replayed');
  } finally { await api.close(); }
});

test('draft confirmation refuses unmapped users, foreign registrations and replayed presses', async () => {
  const tokenHash = createHash('sha256').update('secret').digest('hex');
  const owner = randomUUID(), draft = randomUUID(), token = randomUUID();
  let state: 'foreign' | 'used' | 'expired' = 'foreign';
  const tx = { owners: { byTelegramUserId: async (id: bigint) => id === 42n ? { id: owner } : undefined }, registry: {
    draftPresses: { consume: async () => state }, records: { get: async () => ({ id: draft, status: 'draft', category: 'security' }) },
  } };
  const api = createApiServer({ tokens: { byHash: async () => ({ id: token, role: 'relay', prefix: 'relay', tokenHash, workerId: null, revokedAt: null, expiresAt: null, validUntil: null }) } });
  registerRelayHandlers(api, { transaction: async (fn: any) => fn(tx) } as unknown as Repo);
  const { port } = await api.listen(0);
  try {
    const press = (user: number) => fetch(`http://127.0.0.1:${port}/registry/drafts/${draft}/confirm`, { method: 'POST', headers: { authorization: 'Bearer afk_relay_secret', 'content-type': 'application/json', 'idempotency-key': randomUUID() }, body: JSON.stringify({ press_id: randomUUID(), telegram_user_id: user }) });
    assert.equal((await press(999)).status, 403);
    assert.equal((await press(42)).status, 403);
    state = 'used';
    const replay = await press(42);
    assert.equal(replay.status, 409);
    assert.equal((await replay.json() as any).code, 'press_replayed');
    state = 'expired';
    const expired = await press(42);
    assert.equal(expired.status, 409);
    assert.equal((await expired.json() as any).code, 'press_expired');
  } finally { await api.close(); }
});

test('registration binds a draft and relay token and repeats the same idempotent result', async () => {
  const tokenHash = createHash('sha256').update('secret').digest('hex');
  const draft = randomUUID(), token = randomUUID(), now = new Date('2030-01-01T00:00:00Z');
  let claim: any, registration: any;
  const tx = { settings: { snapshot: async () => ({ 'confirm.windowSeconds': 300 }) }, // Migration 0008 seeds the confirmation window in seconds.
    registry: { records: { get: async () => ({ id: draft, status: 'draft' }) }, draftPresses: { register: async (...args: unknown[]) => { registration = args; } } },
    idempotencyKeys: { claim: async (input: any) => claim ? { replayed: true, row: claim } : (claim = { requestHash: input.requestHash, state: 'in_progress' }, { replayed: false }), complete: async (_actor: string, _key: string, status: number, body: unknown) => Object.assign(claim, { state: 'done', responseStatus: status, responseBody: body }) } };
  const api = createApiServer({ tokens: { byHash: async () => ({ id: token, role: 'relay', prefix: 'relay', tokenHash, workerId: null, revokedAt: null, expiresAt: null, validUntil: null }) }, clock: () => now });
  registerRelayHandlers(api, { transaction: async (fn: any) => fn(tx) } as unknown as Repo);
  const { port } = await api.listen(0);
  try {
    const send = () => fetch(`http://127.0.0.1:${port}/registry/drafts/${draft}/presses`, { method: 'POST', headers: { authorization: 'Bearer afk_relay_secret', 'idempotency-key': 'register-key' } });
    const first = await send();
    assert.equal(first.status, 201);
    const body = await first.json() as any;
    assert.deepEqual(registration, [body.press_id, draft, token, new Date('2030-01-01T00:05:00Z')]);
    assert.deepEqual(await (await send()).json(), body);
  } finally { await api.close(); }
});

test('sensitive draft activates only after a distinct second press with the confirmation', async () => {
  const tokenHash = createHash('sha256').update('secret').digest('hex');
  const owner = randomUUID(), otherOwner = randomUUID(), draftId = randomUUID(), token = randomUUID(), now = new Date('2030-01-01T00:00:00Z');
  let confirmation: any, storedResponse: unknown, changes = 0;
  const used = new Set<string>();
  const draft: any = { id: draftId, number: 1n, kind: 'decision', authority: 'owner', status: 'draft', scopeType: 'global', category: 'security', problem: 'Fixture', decision: 'Proceed', version: 1, source: 'owner_message', createdBy: { id: owner }, createdAt: now };
  const tx = { settings: { snapshot: async () => ({ 'confirm.windowSeconds': 300 }) },
    confirmations: { create: async (row: any) => { confirmation = row; }, get: async () => confirmation, consume: async (input: any) => input.actorId === owner && input.channel === 'telegram' && input.requestHash === confirmation.requestHash && !confirmation.used ? (confirmation.used = true, confirmation) : null },
    idempotencyKeys: { claim: async () => ({ replayed: false }), complete: async (_actor: string, _key: string, _status: number, body: unknown) => { storedResponse = body; } }, owners: { byTelegramUserId: async (id: bigint) => ({ id: id === 42n ? owner : otherOwner }) },
    registry: { lock: async () => {}, draftPresses: { consume: async (id: string) => used.has(id) ? 'used' : (used.add(id), 'consumed') },
      links: { forRecord: async () => [] }, records: { get: async () => draft, list: async () => [], history: async () => [], changeStatus: async (_id: string, status: string, _at: Date, actor: any) => { changes++; draft.status = status; draft.statusChangedBy = actor; return draft; } } } };
  const api = createApiServer({ tokens: { byHash: async () => ({ id: token, role: 'relay', prefix: 'relay', tokenHash, workerId: null, revokedAt: null, expiresAt: null, validUntil: null }) }, clock: () => now });
  registerRelayHandlers(api, { transaction: async (fn: any) => fn(tx) } as unknown as Repo);
  const { port } = await api.listen(0);
  try {
    const send = (press: string, confirm?: string, user = 42) => fetch(`http://127.0.0.1:${port}/registry/drafts/${draftId}/confirm`, { method: 'POST', headers: { authorization: 'Bearer afk_relay_secret', 'content-type': 'application/json', 'idempotency-key': randomUUID(), ...(confirm ? { 'x-confirm': confirm } : {}) }, body: JSON.stringify({ press_id: press, telegram_user_id: user }) });
    const first = await send(randomUUID());
    assert.equal(first.status, 409);
    const challenge = await first.json() as any;
    assert.equal(challenge.code, 'confirmation_required');
    assert.deepEqual(storedResponse, { code: 'confirmation_required' });
    assert.equal(changes, 0);
    const foreign = await send(randomUUID(), `${challenge.confirmation_id}.${challenge.nonce}`, 43);
    assert.equal(foreign.status, 409);
    assert.equal((await foreign.json() as any).code, 'confirmation_invalid');
    assert.equal(changes, 0);
    const press = randomUUID();
    assert.equal((await send(press, `${challenge.confirmation_id}.${challenge.nonce}`)).status, 200);
    assert.equal(changes, 1);
    assert.deepEqual(draft.statusChangedBy, { type: 'owner', id: owner, channel: 'telegram', pressId: press });
  } finally { await api.close(); }
});
