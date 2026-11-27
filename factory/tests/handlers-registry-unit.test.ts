import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Repo } from '../db/repo/index.ts';
import { routes } from '../contracts/routes.ts';
import { registerRegistryHandlers } from '../api/handlers/registry.ts';
import type { HandlerContext, Handler } from '../api/server.ts';
import { RegistryRefusedError } from '../db/repo/registry.ts';

const registryPaths = [
  'POST /registry/inquiries', 'GET /registry/inquiries/{id}', 'POST /registry/inquiries/{id}/verdicts', 'POST /registry/gate',
  'GET /registry/search', 'GET /registry/records', 'GET /registry/records/{id}', 'POST /registry/records', 'GET /registry/drafts',
  'POST /registry/records/{id}/activate', 'POST /registry/records/{id}/revoke', 'POST /registry/records/{id}/supersede',
  'POST /registry/polls', 'POST /registry/captures', 'GET /regulation/versions', 'GET /regulation/versions/{id}',
  'POST /regulation/versions', 'GET /regulation/versions/{id}/diff', 'POST /regulation/versions/{id}/activate', 'POST /regulation/versions/{id}/revoke',
];
const pollId = '01900000-0000-7000-8000-000000000001';
const firstId = '01900000-0000-7000-8000-000000000002';
const secondId = '01900000-0000-7000-8000-000000000003';
const versionId = '01900000-0000-7000-8000-000000000004';

function setup(repo: Partial<Repo>, options: Omit<NonNullable<Parameters<typeof registerRegistryHandlers>[2]>, 'repo'> = {}) {
  const handlers = new Map<string, Handler>();
  const complete = { settings: { snapshot: async () => ({ 'registry.enabled': true, 'page.defaultLimit': 50, 'page.maxLimit': 100 }) }, audit: { append: async () => ({}) }, ...repo } as Repo;
  registerRegistryHandlers({ register: (method, path, handler) => handlers.set(`${method} ${path}`, handler) }, complete, options);
  const call = (key: string, values: Partial<HandlerContext> = {}) => handlers.get(key)!({
    request: { url: '/', headers: {} } as HandlerContext['request'],
    route: routes.find(route => `${route.method} ${route.path}` === key)!,
    params: { id: 'record-id' }, body: undefined, identity: null, requestId: 'request',
    logger: { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } } as unknown as HandlerContext['logger'],
    now: new Date('2030-01-01T00:00:00.000Z'), ...values,
  });
  return { handlers, call };
}

test('registry handler registers every documented route and no other route', () => {
  const { handlers } = setup({});
  assert.deepEqual([...handlers.keys()].sort(), [...registryPaths].sort());
});

test('record detail resolves a DEC number and includes links and status history', async () => {
  const record = { id: 'record-id', number: 42n, kind: 'decision', status: 'active', createdAt: new Date('2030-01-01T00:00:00Z') };
  const { call } = setup({ registry: {
    records: { get: async () => undefined, byNumber: async (number: bigint) => number === 42n ? record : undefined, history: async () => [] },
    links: { forRecord: async () => [] },
  } as never } as never);
  const result = await call('GET /registry/records/{id}', { params: { id: 'DEC-00042' } });
  assert.equal(result.status, 200);
  assert.equal((result.body as Record<string, unknown>).number, 42);
  assert.deepEqual((result.body as Record<string, unknown>).links, []);
  assert.deepEqual((result.body as Record<string, unknown>).history, []);
});

test('registry list rejects unbound offset cursors', async () => {
  const { call } = setup({ registry: { regulations: { list: async () => [] } } as never } as never);
  const result = await call('GET /regulation/versions', { request: { url: '/regulation/versions?cursor=MQ', headers: {} } as unknown as HandlerContext['request'] });
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { code: 'bad_cursor' });
});

test('relay capture delegates the registered press and maps a replay refusal', async () => {
  const calls: unknown[] = [];
  const service = {
    capturePoll: async (actor: unknown, input: unknown) => { calls.push([actor, input]); throw new RegistryRefusedError('press_replayed'); },
  };
  // The capture route is idempotent: it claims its key and checks the owner mapping inside one transaction before the service runs.
  const tx = { idempotencyKeys: { claim: async () => ({ replayed: false }), complete: async () => {} }, owners: { byTelegramUserId: async () => ({ id: 'owner' }) }, registry: { records: { captureByPress: async () => undefined } } };
  const { call } = setup({ settings: { snapshot: async () => ({ 'registry.enabled': true }) } as never, transaction: async (fn: any) => fn(tx) } as never, { service: service as never, now: () => new Date('2030-01-01T00:00:00.000Z') });
  const result = await call('POST /registry/captures', {
    request: { url: '/', headers: { 'idempotency-key': 'capture-key-1' } } as unknown as HandlerContext['request'],
    body: { press_id: 'press', telegram_user_id: 123, poll_id: pollId, option_index: 1 },
    identity: { id: 'relay', role: 'relay', ownerId: null, runId: null } as never,
  });
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { code: 'press_replayed' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [{ type: 'relay' }, { pressId: 'press', telegramUserId: 123, pollId, optionIndex: 1, now: new Date('2030-01-01T00:00:00.000Z') }]);
});

test('bulk activation delegates the complete list as one service operation', async () => {
  const calls: unknown[] = [];
  const service = {
    changeStatuses: async (actor: unknown, ids: string[], status: string, now?: Date) => {
      calls.push([actor, ids, status, now]);
      return ids.map(id => ({ id, status: 'active' }));
    },
  };
  const { call } = setup({ registry: {
    records: { get: async (id: string) => ({ id, number: 1n, createdAt: new Date(0) }), history: async () => [] },
    links: { forRecord: async () => [] },
  } as never } as never, { service: service as never, now: () => new Date('2030-01-01T00:00:00.000Z') });
  const result = await call('POST /registry/records/{id}/activate', {
    body: { ids: [firstId, secondId] },
    identity: { id: 'owner', ownerId: 'owner', role: 'owner' } as never,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(calls, [[{ type: 'owner', id: 'owner' }, [firstId, secondId], 'active', new Date('2030-01-01T00:00:00.000Z')]]);
});

test('regulation activation uses the route second-press mark and injected time', async () => {
  const observed: unknown[] = [];
  const service = {
    activateRegulation: async (actor: unknown, id: string, confirmation: unknown) => { observed.push([actor, id, confirmation]); return { id, status: 'active' }; },
  };
  const now = new Date('2030-02-03T04:05:06.000Z');
  const { call } = setup({ settings: { snapshot: async () => ({ 'registry.enabled': true }) } as never } as never, { service: service as never, now: () => now });
  const route = routes.find(route => route.method === 'POST' && route.path === '/regulation/versions/{id}/activate');
  assert.equal(route?.secondPress, 'always');
  const result = await call('POST /regulation/versions/{id}/activate', {
    params: { id: versionId }, request: { url: '/', headers: { 'x-confirm': 'confirmation.nonce' } } as unknown as HandlerContext['request'],
    identity: { id: 'owner', ownerId: 'owner', role: 'owner', runId: null } as never,
  });
  assert.equal(result.status, 200);
  assert.deepEqual((observed[0] as unknown[])[1], versionId);
  assert.deepEqual((observed[0] as unknown[])[2], { confirm: 'confirmation.nonce', channel: 'api', deviceSessionId: null, now });
});
