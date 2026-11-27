import assert from 'node:assert/strict';
import { it } from 'node:test';
import { clientPromptPolicy, readClientEvents, registerClientHandlers } from '../api/handlers/client.ts';
import { encodeCursor } from '../api/cursor.ts';
import type { Repo } from '../db/repo/index.ts';
import { createApiServer } from '../api/server.ts';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

it('reports a revoked device session with the client problem code', async () => {
  const tokenHash = createHash('sha256').update('secret').digest('hex');
  const api = createApiServer({
    tokens: { byHash: async () => undefined },
    workers: { get: async () => undefined },
    deviceSessions: {
      byTokenHash: async () => ({ id: 'session', deviceId: 'device', prefix: 'install', tokenHash, revokedAt: new Date(), expiresAt: null }),
      touch: async () => assert.fail('A revoked session must not be touched'),
    },
    devices: { get: async () => ({ revokedAt: null }) },
  });
  const { port } = await api.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/conversations`, { headers: { authorization: 'Bearer afk_install_secret' } });
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { code: string }).code, 'device_revoked');
  } finally { await api.close(); }
});

it('keeps third-party permission prompts out of the served prompt list', () => {
  assert.deepEqual(clientPromptPolicy.served, ['factory_decision', 'confirmation', 'session_poll']);
  assert.deepEqual(clientPromptPolicy.unserved, ['third_party_tool_permission']);
});

it('uses the message stream cursor and supplied horizon', async () => {
  const rows = [{ id: 'a', commitXid: '10', seq: 1n }, { id: 'b', commitXid: '11', seq: 2n }];
  const repo = { messages: { stream: async ({ below, after, limit }: { below: string; after?: { commitXid: string; seq: bigint }; limit: number }) => rows.filter(row => BigInt(row.commitXid) < BigInt(below) && (!after || BigInt(row.commitXid) > BigInt(after.commitXid) || (row.commitXid === after.commitXid && row.seq > after.seq))).slice(0, limit) }, audit: { snapshotXmin: async () => { throw new Error('unexpected horizon'); } } } as unknown as Repo;
  const first = await readClientEvents(repo, 'messages', { limit: 1, horizon: async () => '12' });
  const second = await readClientEvents(repo, 'messages', { limit: 1, cursor: first.next_cursor!, horizon: async () => '12' });
  assert.deepEqual([...first.items, ...second.items].map(row => row.id), ['a', 'b']);
  await assert.rejects(readClientEvents(repo, 'messages', { limit: 1, cursor: encodeCursor('audit_log', rows[0]!), horizon: async () => '12' }), { code: 'bad_cursor' });
});

it('preserves a documented handler problem code over HTTP', async () => {
  const api = createApiServer({ tokens: { byHash: async () => undefined }, workers: { get: async () => undefined } });
  api.register('POST', '/devices/enroll', async () => ({ status: 401, body: { code: 'unauthenticated' } }));
  const { port } = await api.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/devices/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'invalid', name: 'install' }) });
    assert.equal(response.status, 401);
    assert.equal((await response.json() as { code: string }).code, 'unauthenticated');
  } finally { await api.close(); }
});

it('authenticates an unrevoked device session and rejects it after device revocation', async () => {
  let revokedAt: Date | null = null;
  const tokenHash = createHash('sha256').update('secret').digest('hex');
  const api = createApiServer({ tokens: { byHash: async () => undefined }, workers: { get: async () => undefined }, deviceSessions: { byTokenHash: async hash => hash === tokenHash ? { id: 'session', deviceId: 'device', prefix: 'install', tokenHash, revokedAt: null, expiresAt: null } : undefined, touch: async () => ({}) }, devices: { get: async () => ({ revokedAt }) } });
  api.register('GET', '/conversations', async () => ({ status: 200, body: {} }));
  const { port } = await api.listen(0);
  try {
    const request = () => fetch(`http://127.0.0.1:${port}/conversations`, { headers: { authorization: 'Bearer afk_install_secret' } });
    assert.equal((await request()).status, 200);
    revokedAt = new Date();
    assert.equal((await request()).status, 401);
  } finally { await api.close(); }
});

it('writes event-stream frames without JSON encoding', async () => {
  const tokenHash = createHash('sha256').update('reader').digest('hex');
  const api = createApiServer({ tokens: { byHash: async () => ({ id: 'reader', role: 'reader', prefix: 'reader', tokenHash, workerId: null, revokedAt: null, expiresAt: null, validUntil: null }) }, workers: { get: async () => undefined } });
  api.register('GET', '/events/stream', async () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, stream: async function* () { yield 'id: cursor\ndata: {}\n\n'; } }));
  const { port } = await api.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/events/stream`, { headers: { authorization: 'Bearer afk_reader_reader' } });
    assert.equal(await response.text(), 'id: cursor\ndata: {}\n\n');
  } finally { await api.close(); }
});

it('returns a conversation and refuses a missing one over HTTP', async () => {
  const tokenHash = createHash('sha256').update('reader').digest('hex');
  const api = createApiServer({ tokens: { byHash: async () => ({ id: 'reader', role: 'reader', prefix: 'reader', tokenHash, workerId: null, revokedAt: null, expiresAt: null, validUntil: null }) }, workers: { get: async () => undefined } });
  const foundId = randomUUID();
  const createdAt = new Date();
  registerClientHandlers(api, { conversations: { get: async (id: string) => id === foundId ? { id, sessionRef: 'session', source: 'rig_session', state: 'active', title: 'Chat', createdAt } : undefined } } as unknown as Repo);
  const { port } = await api.listen(0);
  try {
    const request = (id: string) => fetch(`http://127.0.0.1:${port}/conversations/${id}`, { headers: { authorization: 'Bearer afk_reader_reader' } });
    const found = await request(foundId);
    assert.equal(found.status, 200);
    assert.deepEqual(await found.json(), {
      id: foundId, session_ref: 'session', source: 'rig_session', state: 'active', title: 'Chat', created_at: createdAt.toISOString(),
      project_id: null, task_id: null, last_message_at: null, archived_at: null,
    });
    assert.equal((await request(randomUUID())).status, 404);
  } finally { await api.close(); }
});
