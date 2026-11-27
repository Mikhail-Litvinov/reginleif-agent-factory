import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerRightsHandlers } from '../api/handlers/rights.ts';
import type { Repo } from '../db/repo/index.ts';

type Handler = (context: any) => Promise<{ status: number; body: any }>;

function setup(tx: Record<string, unknown>) {
  const handlers = new Map<string, Handler>();
  const scopes = new Map<string, any>();
  const api = { register: (method: string, path: string, handler: Handler, options?: { authorizeScope?: unknown }) => { handlers.set(`${method} ${path}`, handler); scopes.set(`${method} ${path}`, options?.authorizeScope); } };
  const repo = { ...tx, transaction: async (fn: (tx: unknown) => unknown) => fn(tx) } as unknown as Repo;
  registerRightsHandlers(api as never, { repo, now: () => new Date(0) });
  return { call: (key: string, context: Record<string, unknown>) => handlers.get(key)!({ request: { method: 'POST', url: '/x' }, route: { path: key }, requestId: 'req', params: {}, body: {}, ...context }), scopes, handlers };
}

test('every rights route of the contract is registered', () => {
  const { handlers } = setup({});
  assert.deepEqual([...handlers.keys()].sort(), [
    'GET /rights/grants', 'GET /rights/requests', 'GET /rights/requests/{id}', 'GET /rights/suspensions', 'GET /rights/suspensions/{id}', 'GET /roles', 'GET /roles/{id}', 'GET /tasks/{id}/participants',
    'POST /rights/check', 'POST /rights/grants/{id}/revoke', 'POST /rights/requests', 'POST /rights/requests/{id}/answer', 'POST /rights/suspensions/{id}/restore',
  ]);
});

test('missing roles and tasks answer not_found', async () => {
  const { call } = setup({ roles: { get: async () => undefined }, tasks: { get: async () => undefined } });
  assert.equal((await call('GET /roles/{id}', { params: { id: 'r' } })).status, 404);
  assert.equal((await call('GET /tasks/{id}/participants', { params: { id: 't' } })).status, 404);
});

test('a registry token does not learn whether another run has a request', async () => {
  const tx = {
    tokens: { get: async () => ({ runId: 'mine', sessionRef: null }) },
    rightRequests: { get: async () => ({ id: 'q', runId: 'other', sessionRef: null }) },
    rightAnswers: { listForRequest: async () => [] },
  };
  const { call } = setup(tx);
  const other = await call('GET /rights/requests/{id}', { params: { id: 'q' }, identity: { id: 't', role: 'registry' } });
  assert.equal(other.status, 404);
  const own = await call('GET /rights/requests/{id}', { params: { id: 'q' }, identity: { id: 't', role: 'owner' } });
  assert.equal(own.status, 200);
  assert.equal(own.body.state, 'open');
});

test('owner-only answers need an owner identity and an existing request', async () => {
  const { call } = setup({ rightRequests: { get: async () => undefined }, rightGrants: { get: async () => undefined } });
  const body = { answer: 'refuse' };
  assert.equal((await call('POST /rights/requests/{id}/answer', { params: { id: 'q' }, body, identity: { id: 't', role: 'worker' } })).status, 403);
  assert.equal((await call('POST /rights/requests/{id}/answer', { params: { id: 'q' }, body, identity: { id: 't', role: 'owner', ownerId: 'o' } })).status, 404);
  assert.equal((await call('POST /rights/grants/{id}/revoke', { params: { id: 'g' }, identity: { id: 't', role: 'worker' } })).status, 403);
  assert.equal((await call('POST /rights/grants/{id}/revoke', { params: { id: 'g' }, identity: { id: 't', role: 'owner', ownerId: 'o' } })).status, 404);
});

function revokeTx(ended: boolean) {
  const orders: any[] = [];
  const grant = { id: 'g', taskId: 'task', sessionRef: null, participant: 'builder', right: { action: 'write', target: 'file' }, endedAt: null };
  const runs = [
    { id: 'hit', taskId: 'task', participant: 'builder', finishedAt: null, profileRights: [{ action: 'write', target: 'file' }] },
    { id: 'other-right', taskId: 'task', participant: 'builder', finishedAt: null, profileRights: [{ action: 'read', target: 'file' }] },
    { id: 'other-participant', taskId: 'task', participant: 'tester', finishedAt: null, profileRights: [{ action: 'write', target: 'file' }] },
    { id: 'finished', taskId: 'task', participant: 'builder', finishedAt: new Date(0), profileRights: [{ action: 'write', target: 'file' }] },
  ];
  const audits: any[] = [];
  return { orders, audits, tx: {
    rightGrants: { get: async () => grant, end: async () => (ended ? { ...grant, endedAt: new Date(0), endedBy: 'revocation' } : null) },
    taskReads: { runs: async () => runs, runsForSession: async () => [] },
    outbox: { create: async (row: unknown) => { orders.push(row); } },
    audit: { append: async (row: unknown) => { audits.push(row); } },
  } };
}

test('revoking a grant orders a stop for the live run that holds the right, and only for it', async () => {
  const { tx, orders, audits } = revokeTx(true);
  const { call } = setup(tx);
  const result = await call('POST /rights/grants/{id}/revoke', { params: { id: 'g' }, identity: { id: 't', role: 'owner', ownerId: 'o' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.ended_by, 'revocation');
  assert.deepEqual(orders.map(order => [order.kind, order.payload.run_id, order.payload.reason]), [['stop_run', 'hit', 'right_revoked']]);
  assert.equal(audits[0].action, 'rights.revoke');
});

test('revoking an ended grant is a no-op that answers the current row', async () => {
  const { tx, orders } = revokeTx(false);
  const { call } = setup(tx);
  const result = await call('POST /rights/grants/{id}/revoke', { params: { id: 'g' }, identity: { id: 't', role: 'owner', ownerId: 'o' } });
  assert.equal(result.status, 200);
  assert.deepEqual(orders, []);
});

function restoreTx(options: { runAgent?: string; runRole?: string; open?: boolean; suspensionRunRole?: string }) {
  const restores: any[] = [];
  const audits: any[] = [];
  const suspension = { id: 's', agentId: 'suspended', runId: 'suspended-run', endedAt: null };
  const runs: Record<string, any> = {
    'suspended-run': { id: 'suspended-run', role: options.suspensionRunRole ?? 'implementer', workerId: 'w', agentId: 'suspended' },
    'caller-run': { id: 'caller-run', role: options.runRole ?? 'chief_engineer', workerId: 'w', agentId: options.runAgent ?? 'chief' },
  };
  return { restores, audits, tx: {
    rightsSuspensions: {
      get: async () => suspension,
      openForAgent: async () => (options.open ? { id: 'own' } : undefined),
      restore: async (_id: string, input: any) => { restores.push(input); return { ...suspension, endedAt: new Date(0), restoredBy: { type: input.restoredBy.type, id: input.restoredBy.id }, restoreReason: input.restoreReason, restoreAuditId: input.restoreAuditId }; },
    },
    tokens: { get: async () => ({ runId: 'caller-run' }) },
    taskReads: { getRun: async (id: string) => runs[id] },
    audit: { append: async (row: unknown) => { audits.push(row); } },
  } };
}
const worker = { id: 't', role: 'worker', workerId: 'w' };

test('a suspension is restored by a free chief engineer run, with the audit row recorded first', async () => {
  const { tx, restores, audits } = restoreTx({});
  const { call } = setup(tx);
  const result = await call('POST /rights/suspensions/{id}/restore', { params: { id: 's' }, body: { restore_reason: 'cause fixed' }, identity: worker });
  assert.equal(result.status, 200);
  assert.deepEqual([result.body.state, result.body.restored_by], ['restored', 'caller-run']);
  assert.equal(restores[0].restoreAuditId, audits[0].id);
  assert.equal(audits[0].action, 'rights.restore');
});

test('the suspended agent, a non chief engineer and a suspended chief engineer cannot restore', async () => {
  for (const options of [{ runAgent: 'suspended' }, { runRole: 'implementer' }, { open: true }]) {
    const { tx, restores } = restoreTx(options);
    const { call } = setup(tx);
    const result = await call('POST /rights/suspensions/{id}/restore', { params: { id: 's' }, body: { restore_reason: 'x' }, identity: worker });
    assert.equal(result.status, 403, JSON.stringify(options));
    assert.deepEqual(restores, []);
  }
});

test('the owner restores only the suspension of a chief engineer run', async () => {
  const owner = { id: 't', role: 'owner', ownerId: 'o' };
  const refused = setup(restoreTx({}).tx);
  assert.equal((await refused.call('POST /rights/suspensions/{id}/restore', { params: { id: 's' }, body: { restore_reason: 'x' }, identity: owner })).status, 403);
  const accepted = restoreTx({ suspensionRunRole: 'chief_engineer' });
  const { call } = setup(accepted.tx);
  const result = await call('POST /rights/suspensions/{id}/restore', { params: { id: 's' }, body: { restore_reason: 'x' }, identity: owner });
  assert.equal(result.status, 200);
  assert.deepEqual(accepted.restores[0].restoredBy, { type: 'owner', id: 'o' });
});

test('a restore of an ended suspension answers request_closed', async () => {
  const { tx } = restoreTx({});
  (tx.rightsSuspensions as any).get = async () => ({ id: 's', agentId: 'suspended', runId: 'suspended-run', endedAt: new Date(0) });
  const { call } = setup(tx);
  const result = await call('POST /rights/suspensions/{id}/restore', { params: { id: 's' }, body: { restore_reason: 'x' }, identity: worker });
  assert.deepEqual([result.status, result.body.code], [409, 'request_closed']);
});

test('the scope check of the restore route separates the owner scope from the worker scope', async () => {
  const { scopes } = setup({});
  const check = scopes.get('POST /rights/suspensions/{id}/restore');
  assert.equal(await check({ identity: { role: 'owner' }, scope: 'chief_engineer_suspension' }), true);
  assert.equal(await check({ identity: { role: 'worker' }, scope: 'chief_engineer_suspension' }), false);
  assert.equal(await check({ identity: { role: 'worker' }, scope: 'chief_engineer_run' }), true);
});
