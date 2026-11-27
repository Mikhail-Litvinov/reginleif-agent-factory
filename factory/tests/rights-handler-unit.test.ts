import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerRightsHandlers } from '../api/handlers/rights.ts';
import type { Repo } from '../db/repo/index.ts';

test('registry token cannot check another session', async () => {
  const handlers = new Map<string, any>();
  const api = { register: (method: string, path: string, callback: unknown) => { handlers.set(`${method} ${path}`, callback); } };
  const tx = { tokens: { get: async () => ({ sessionRef: 'own', runId: null }) } };
  const repo = { transaction: async (fn: (tx: unknown) => unknown) => fn(tx) } as unknown as Repo;
  registerRightsHandlers(api as never, { repo });
  const response = await handlers.get('POST /rights/check')({ identity: { id: 'token', role: 'registry' }, body: { session_id: 'other', action: 'read', target: 'file' }, now: new Date(0) });
  assert.equal(response.status, 403);
});

test('a suspended run is refused even when its call is unreadable', async () => {
  const handlers = new Map<string, any>();
  const api = { register: (method: string, path: string, callback: unknown) => { handlers.set(`${method} ${path}`, callback); } };
  const tx = {
    tokens: { get: async () => ({ runId: 'run' }) },
    taskReads: { getRun: async () => ({ taskId: 'task', workerId: 'worker', agentId: 'agent', participant: 'builder' }) },
    tasks: { get: async () => ({ projectId: 'project' }) },
    agents: { lock: async () => {} },
    rightsSuspensions: { openForAgent: async () => ({ id: 'suspension' }) },
  };
  const repo = { transaction: async (fn: (tx: unknown) => unknown) => fn(tx) } as unknown as Repo;
  registerRightsHandlers(api as never, { repo });
  const result = await handlers.get('POST /rights/check')({ identity: { id: 'token', role: 'registry' }, body: { run_id: 'run', action: 'read', target: null } });
  assert.deepEqual(result.body, { allowed: false, source: 'refused', reason: 'suspended' });
});
