import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignRole, profileRights, roleForParticipant } from '../rights/roles.ts';

test('role assignment requires an independent chief engineer and an active role in the active regulation', async () => {
  let writes = 0;
  let locked = false;
  const tx = { registry: { lock: async () => {}, regulations: { active: async () => ({ id: 'reg' }) } }, agents: { lock: async () => { locked = true; } }, roles: { get: async () => ({ id: 'role', status: 'active', regulationVersionId: 'reg' }) }, roleAssignments: { listForTask: async () => [], create: async (row: unknown) => { writes++; return row; }, supersede: async () => null }, taskReads: { getRun: async () => ({ id: 'chief', role: 'chief_engineer', taskId: 'task', agentId: 'chief-agent' }) }, rightsSuspensions: { openForAgent: async () => { assert.equal(locked, true); return undefined; } } } as any;
  await assert.rejects(assignRole(tx, { taskId: 'task', participant: 'builder', roleId: 'role', engineerRunId: 'chief', participantRunId: 'chief' }));
  assert.equal(writes, 0);
  tx.taskReads.getRun = async () => ({ id: 'chief', role: 'chief_engineer', taskId: 'task', participant: 'builder', agentId: 'chief-agent' });
  await assert.rejects(assignRole(tx, { taskId: 'task', participant: 'builder', roleId: 'role', engineerRunId: 'chief', participantRunId: 'other' }));
  tx.taskReads.getRun = async () => ({ id: 'chief', role: 'chief_engineer', taskId: 'task', participant: 'chief', agentId: 'chief-agent' });
  tx.roles.get = async () => ({ id: 'role', status: 'draft', regulationVersionId: 'reg' });
  await assert.rejects(assignRole(tx, { taskId: 'task', participant: 'builder', roleId: 'role', engineerRunId: 'chief', participantRunId: 'other' }));
  tx.roles.get = async () => ({ id: 'role', status: 'active', regulationVersionId: 'reg' });
  await assignRole(tx, { taskId: 'task', participant: 'builder', roleId: 'role', engineerRunId: 'chief', participantRunId: 'other' });
  assert.equal(writes, 1);
});

test('profile excludes records and rights narrower than the sandbox', () => {
  const broad = { action: 'read', target: 'workspace', conditions: {} };
  const narrow = { action: 'read', target: 'one-file', conditions: {} };
  const result = profileRights([broad, narrow], [{ id: 'grant', right: broad }, { id: 'narrow', right: narrow }], right => right.target === 'workspace');
  assert.deepEqual(result, [{ ...broad, source: 'role' }, { ...broad, source: 'grant' }]);
});

test('a single-use grant never enters a snapshot even when expressible', () => {
  const right = { action: 'read', target: 'workspace', conditions: { once: true } };
  assert.deepEqual(profileRights([], [{ id: 'grant', right }], () => true), []);
});

test('participant roles are usable only from the active regulation', async () => {
  const tx = { registry: { lock: async () => {}, regulations: { active: async () => ({ id: 'current' }) } }, roleAssignments: { listForTask: async () => [{ participant: 'a', roleId: 'old' }, { participant: 'b', roleId: 'new' }] }, roles: { get: async (id: string) => ({ id, status: 'active', regulationVersionId: id === 'old' ? 'previous' : 'current', rights: [], deny: [] }) } } as any;
  assert.equal(await roleForParticipant(tx, 'task', 'a'), undefined);
  assert.equal((await roleForParticipant(tx, 'task', 'b'))?.id, 'new');
});
