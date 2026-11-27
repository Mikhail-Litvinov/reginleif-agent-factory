import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRights, checkForSubject } from '../rights/check.ts';

const right = { action: 'POST /devices', target: 'file', conditions: { variant: ['one'] } };
const base = () => ({ call: right, suspended: false, guard: false, deny: [], roles: [], records: [], grants: [], consume: async () => true });

test('refusal precedes every source and does not consume', async () => {
  let consumed = false;
  const result = await checkRights({ ...base(), suspended: true, roles: [right], records: [{ id: 'r', number: '1', right, once: true }], consume: async () => { consumed = true; return true; } });
  assert.deepEqual(result, { allowed: false, source: 'refused', reason: 'suspended' });
  assert.equal(consumed, false);
});

test('matches complete structured calls exactly and consumes once only on successful claim', async () => {
  const record = { id: 'r', number: '1', right, once: true };
  assert.deepEqual(await checkRights({ ...base(), records: [record] }), { allowed: true, source: 'record', ref: '1' });
  assert.deepEqual(await checkRights({ ...base(), records: [record], consume: async () => false }), { allowed: false, source: 'none' });
  assert.deepEqual(await checkRights({ ...base(), records: [record], call: { ...right, conditions: { variant: ['two'] } } }), { allowed: false, source: 'none' });
});

test('checks project scope and suspensions before reading any permission', async () => {
  let consumed = 0;
  const record = { id: 'r', number: 2n, right, kind: 'permission', status: 'active', reuse: 'once', consumedAt: null, scopeType: 'project', projectId: 'other', repository: null, machineId: null, action: null, target: null };
  const tx = {
    agents: { lock: async () => {}, get: async () => ({ configuration: {} }) }, policies: { effective: async () => undefined },
    registry: { lock: async () => {}, records: { list: async () => [record], consumePermission: async () => { consumed++; return record; } } },
    rightsSuspensions: { openForAgent: async () => undefined },
    roleAssignments: { listForTask: async () => [] }, roles: { get: async () => undefined },
    rightGrants: { list: async () => [] },
  };
  const subject = { projectId: 'project', taskId: 'task', participant: 'p', agentId: 'agent', sessionRef: null };
  assert.deepEqual(await checkForSubject(tx as never, subject, right, new Date(0)), { allowed: false, source: 'none' });
  assert.equal(consumed, 0);
  tx.rightsSuspensions.openForAgent = async () => ({ id: 's' }) as never;
  assert.deepEqual(await checkForSubject(tx as never, subject, right, new Date(0)), { allowed: false, source: 'refused', reason: 'suspended' });
  assert.equal(consumed, 0);
});

test('denials and role precede records and grants; unreadable and near matches do not pass', async () => {
  const record = { id: 'r', number: '1', right, once: true };
  const grant = { id: 'g', right };
  assert.deepEqual(await checkRights({ ...base(), deny: [right], roles: [right], records: [record], grants: [grant] }), { allowed: false, source: 'refused', reason: 'denied' });
  assert.deepEqual(await checkRights({ ...base(), guard: true, roles: [right] }), { allowed: false, source: 'refused', reason: 'denied' });
  assert.deepEqual(await checkRights({ ...base(), roles: [right], records: [record], grants: [grant] }), { allowed: true, source: 'role' });
  assert.deepEqual(await checkRights({ ...base(), grants: [grant] }), { allowed: true, source: 'grant', ref: 'g' });
  for (const call of [null, { action: 'read', target: 'file' }, { ...right, target: 'other' }, { ...right, action: 'write' }]) {
    assert.deepEqual(await checkRights({ ...base(), call, records: [record], grants: [grant] }), { allowed: false, source: 'none' });
  }
});

test('subject check filters record scope, status, kind and reuse before choosing a grant', async () => {
  const template = { id: 'r', number: 4n, right, kind: 'permission', status: 'active', reuse: 'standing', consumedAt: null, scopeType: 'project', projectId: 'project', repository: null, machineId: null, action: null, target: null };
  let rows: Array<Omit<typeof template, 'repository' | 'machineId' | 'action' | 'target' | 'consumedAt'> & { repository: string | null; machineId: string | null; action: string | null; target: string | null; consumedAt: Date | null }> = [template];
  const tx = {
    agents: { lock: async () => {}, get: async () => ({ configuration: {} }) }, policies: { effective: async () => undefined }, rightsSuspensions: { openForAgent: async () => undefined },
    registry: { lock: async () => {}, records: { list: async () => rows, consumePermission: async () => null } },
    roleAssignments: { listForTask: async () => [] }, roles: { get: async () => undefined },
    rightGrants: { list: async () => [{ id: 'g', right, taskId: 'task', participant: 'p', endedAt: null }] },
  };
  const subject = { projectId: 'project', taskId: 'task', participant: 'p', agentId: 'agent', sessionRef: null };
  assert.equal((await checkForSubject(tx as never, subject, right, new Date(0))).source, 'record');
  for (const changed of [{ kind: 'decision' }, { status: 'draft' }, { projectId: 'other' }, { repository: 'other' }, { machineId: 'other' }, { action: 'write' }, { target: 'other' }, { reuse: 'once', consumedAt: new Date(0) }]) {
    rows = [{ ...template, ...changed }];
    assert.equal((await checkForSubject(tx as never, subject, right, new Date(0))).source, 'grant');
  }
});

test('a role decision does not consult later sources', async () => {
  const tx = {
    agents: { lock: async () => {}, get: async () => ({ configuration: {} }) }, policies: { effective: async () => undefined }, rightsSuspensions: { openForAgent: async () => undefined },
    registry: { lock: async () => {}, records: { list: async () => { throw new Error('unexpected record lookup'); } } },
    roleAssignments: { listForTask: async () => [{ participant: 'p', roleId: 'role' }] },
    roles: { get: async () => ({ status: 'active', rights: [right], deny: [] }) },
    rightGrants: { list: async () => { throw new Error('unexpected grant lookup'); } },
  };
  assert.equal((await checkForSubject(tx as never, { projectId: 'project', taskId: 'task', participant: 'p', agentId: 'agent', sessionRef: null }, right, new Date(0))).source, 'role');
});

test('server policy and agent configuration refuse a denied tool before a role can allow it', async () => {
  const call = { action: 'tool', target: 'shell', conditions: {} };
  const subject = { projectId: 'project', taskId: 'task', participant: 'p', agentId: 'agent', sessionRef: null };
  const tx = {
    agents: { lock: async () => {}, get: async () => ({ configuration: { denied_tools: ['shell'] } }) },
    policies: { effective: async () => ({ allowedTools: ['shell'] }) },
    rightsSuspensions: { openForAgent: async () => undefined },
    registry: { lock: async () => {} },
    roleAssignments: { listForTask: async () => [{ participant: 'p', roleId: 'role' }] },
    roles: { get: async () => ({ status: 'active', rights: [call], deny: [] as (typeof call)[] }) },
  };
  assert.equal((await checkForSubject(tx as never, subject, call, new Date(0))).source, 'refused');
  tx.agents.get = async () => ({ configuration: { denied_tools: [] } });
  tx.policies.effective = async () => ({ allowedTools: ['other'] });
  assert.equal((await checkForSubject(tx as never, subject, call, new Date(0))).source, 'refused');
  tx.policies.effective = async () => ({ allowedTools: ['shell'] });
  tx.agents.get = async () => ({ configuration: { denied_tools: ['shell'] } });
  assert.equal((await checkForSubject(tx as never, subject, { action: 'inspect', target: 'item', conditions: { tool: 'shell' } }, new Date(0))).source, 'refused');
});

test('a worker-guarded call without a server guard result asks before spending a permission', async () => {
  const call = { action: 'tool', target: 'shell', conditions: { path: '/workspace/file' } };
  const subject = { projectId: 'project', taskId: 'task', participant: 'p', agentId: 'agent', sessionRef: null };
  const tx = {
    agents: { lock: async () => {}, get: async () => ({ configuration: {} }) },
    policies: { effective: async () => ({ allowedTools: ['shell'] }) },
    rightsSuspensions: { openForAgent: async () => undefined }, registry: { lock: async () => {} },
    roleAssignments: { listForTask: async () => [{ participant: 'p', roleId: 'role' }] },
    roles: { get: async () => ({ status: 'active', rights: [call], deny: [] as (typeof call)[] }) },
  };
  assert.deepEqual(await checkForSubject(tx as never, subject, call, new Date(0)), { allowed: false, source: 'none' });
  for (const guarded of [
    { action: 'inspect', target: '/workspace/file', conditions: {} },
    { action: 'inspect', target: 'C:relative', conditions: {} },
    { action: 'read', target: 'file', conditions: {} },
    { action: 'inspect', target: 'file', conditions: { tool: null } },
  ]) {
    assert.deepEqual(await checkForSubject(tx as never, subject, guarded, new Date(0)), { allowed: false, source: 'none' });
  }
  tx.roles.get = async () => ({ status: 'active', rights: [call], deny: [call] });
  assert.equal((await checkForSubject(tx as never, subject, call, new Date(0))).source, 'refused');
});

