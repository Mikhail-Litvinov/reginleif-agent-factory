import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApiServer } from '../api/server.ts';
import { registerTasks } from '../api/handlers/tasks.ts';
import type { Repo } from '../db/repo/index.ts';

test('handler refusals preserve their documented code and request id', async () => {
  const secret = 'test-secret';
  const tokenHash = createHash('sha256').update(secret).digest('hex');
  const api = createApiServer({ tokens: { byHash: async () => ({ id: randomUUID(), role: 'owner', prefix: 'test', tokenHash, workerId: null, revokedAt: null, expiresAt: null, validUntil: null }) } });
  api.register('PATCH', '/projects/{id}', async () => ({ status: 409, body: { code: 'version_conflict' } }));
  api.register('POST', '/projects/{id}/archive', async () => ({ status: 200 }));
  api.register('POST', '/tasks/{id}/cancel', async () => ({ status: 409, headers: { 'Idempotent-Replay': 'true' }, body: {
    code: 'confirmation_required', confirmation_id: randomUUID(), nonce: 'nonce', expires_at: new Date().toISOString(), secret: 'private',
  } }));
  const address = await api.listen(0);
  try {
    const requestId = randomUUID();
    const response = await fetch(`http://127.0.0.1:${address.port}/projects/${randomUUID()}`, { method: 'PATCH', headers: { authorization: `Bearer afk_test_${secret}`, 'content-type': 'application/json', 'x-request-id': requestId }, body: '{}' });
    assert.equal(response.status, 409);
    const body = await response.json() as { code: string; request_id: string };
    assert.equal(body.code, 'version_conflict');
    assert.equal(body.request_id, requestId);
    const archive = await fetch(`http://127.0.0.1:${address.port}/projects/${randomUUID()}/archive`, { method: 'POST', headers: { authorization: `Bearer afk_test_${secret}` }, body: '{}' });
    assert.equal(archive.status, 422);
    const confirmation = await fetch(`http://127.0.0.1:${address.port}/tasks/${randomUUID()}/cancel`, { method: 'POST', headers: { authorization: `Bearer afk_test_${secret}` }, body: JSON.stringify({ reason: 'test' }) });
    assert.equal(confirmation.status, 409);
    assert.equal(confirmation.headers.get('idempotent-replay'), 'true');
    const problem = await confirmation.json() as Record<string, unknown>;
    assert.equal(problem.code, 'confirmation_required');
    assert.equal(problem.nonce, 'nonce');
    assert.equal(Object.hasOwn(problem, 'secret'), false);
  } finally { await api.close(); }
});

test('the server observes pre-dispatch refusals and reports an unavailable token database', async () => {
  const observed: { status: number; code: string }[] = [];
  const api = createApiServer({ tokens: { byHash: async () => { throw new Error('lookup failed', { cause: { code: 'ECONNREFUSED' } }); } } });
  api.register('PATCH', '/projects/{id}', async () => { throw new Error('handler should not run'); }, {
    onProblem: async (_, status, code) => { observed.push({ status, code }); },
  });
  const address = await api.listen(0);
  try {
    const projects = `http://127.0.0.1:${address.port}/projects`;
    const malformed = await fetch(`${projects}/%ZZ`, { method: 'PATCH' });
    assert.equal(malformed.status, 422);
    const missing = await fetch(`${projects}/${randomUUID()}`, { method: 'PATCH' });
    assert.equal(missing.status, 401);
    assert.deepEqual(observed, [{ status: 422, code: 'validation_failed' }, { status: 401, code: 'unauthenticated' }]);
    const unavailable = await fetch(`${projects}/${randomUUID()}`, { method: 'PATCH', headers: { authorization: 'Bearer afk_test_secret' } });
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get('retry-after'), '1');
    assert.equal((await unavailable.json() as { code: string }).code, 'unavailable');
  } finally { await api.close(); }
});

test('task registration serves the installed standing task without an owner or revision row', async () => {
  const id = randomUUID(), projectId = randomUUID();
  const dbTask = { id, projectId, status: 'RUNNING', title: 'Factory standing task', originType: 'standing', workflowId: `task-${id}`, depth: 0,
    parentTaskId: null, createdBy: null, assignedAgentId: null, workflowRunId: null, blockKind: null, blockReason: null, blockHandler: null,
    resumeTo: null, originTaskId: null, originRunId: null, createdAt: new Date(), updatedAt: new Date(), completedAt: null, deletedAt: null, rowVersion: 1n };
  const repo = { projects: { get: async () => ({ id: projectId }) }, tasks: { get: async () => dbTask, getRevision: async () => undefined,
    dependencies: async () => [] }, decisions: { listForTask: async () => [] } } as unknown as Repo;
  const secret = 'standing-test-secret';
  const tokenHash = createHash('sha256').update(secret).digest('hex');
  const api = createApiServer({ tokens: { byHash: async () => ({ id: randomUUID(), role: 'reader', prefix: 'test', tokenHash,
    workerId: null, revokedAt: null, expiresAt: null, validUntil: null }) } });
  registerTasks(api, repo);
  const address = await api.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/tasks/${id}`, { headers: { authorization: `Bearer afk_test_${secret}` } });
    assert.equal(response.status, 200);
    const row = await response.json() as { id: string; status: string; revision: unknown; created_by: unknown; row_version: unknown };
    assert.equal(row.id, id);
    assert.equal(row.status, 'RUNNING');
    assert.equal(row.revision, null);
    assert.equal(row.created_by, null);
    assert.equal(row.row_version, 1);
  } finally { await api.close(); }
});
