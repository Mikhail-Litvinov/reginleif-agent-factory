import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerState, repeatRefusal, createRightRequest, answerOwnerRequest, isOwnerOnly, recordEngineerAnswer } from '../rights/requests.ts';

test('call_owner remains open until an owner answer closes it', () => {
  assert.equal(answerState([]), 'open');
  assert.equal(answerState([{ answer: 'call_owner' }]), 'call_owner');
  assert.equal(answerState([{ answer: 'call_owner' }, { answer: 'grant' }]), 'granted');
  assert.equal(answerState([{ answer: 'refuse' }]), 'refused');
});

test('repeat refusal is found only in the same task and copies the reason', async () => {
  const tx = { rightRequests: { list: async (filter: unknown) => { assert.deepEqual(filter, { taskId: 'task', requestHash: 'hash' }); return [{ id: 'old' }]; } }, rightAnswers: { listForRequest: async () => [{ answer: 'refuse', reason: 'denied' }] } } as any;
  assert.equal(await repeatRefusal(tx, null, 'hash'), undefined);
  assert.equal(await repeatRefusal(tx, 'task', 'hash'), 'denied');
});

test('a held right creates no request, while a missing right uses the standing task', async () => {
  let created: any;
  const tx = { tasks: { list: async () => [{ id: 'standing' }] }, rightRequests: { create: async (row: unknown) => { created = row; return row; }, list: async () => [] }, rightAnswers: { listForRequest: async () => [], create: async () => assert.fail('unexpected answer') } } as any;
  const input = { subject: { projectId: null, taskId: null, participant: null, agentId: null, sessionRef: 'session' }, runId: null, right: { action: 'read', target: 'file', conditions: {} }, reason: 'need', tried: 'none' };
  const held = await createRightRequest(tx, input, async () => ({ allowed: true, source: 'role' }));
  assert.equal(held.status, 200);
  assert.equal(created, undefined);
  const waiting = await createRightRequest(tx, input, async () => ({ allowed: false, source: 'none' }));
  assert.equal(waiting.status, 202);
  assert.equal((created as any).handlingTaskId, 'standing');
  assert.equal((created as any).sessionRef, 'session');
});

test('code records an owner-list step and repeats a prior refusal', async () => {
  let stored: any[] = [];
  const tx = { rightRequests: { list: async () => [{ id: 'prior' }], create: async (row: unknown) => row }, rightAnswers: { listForRequest: async () => [{ answer: 'refuse', reason: 'same reason' }], create: async (row: any) => { stored.push(row); return row; } } } as any;
  const input = { subject: { projectId: 'project', taskId: 'task', participant: 'worker', agentId: 'agent', sessionRef: null }, runId: 'run', right: { action: 'read', target: 'file', conditions: {} }, reason: 'need', tried: 'none' };
  const missing = async () => ({ allowed: false, source: 'none' as const });
  const refusal = await createRightRequest(tx, input, missing);
  assert.equal(refusal.status === 202 && refusal.body.state, 'refused');
  assert.equal(stored[0].reason, 'same reason');
  stored = [];
  const owner = await createRightRequest(tx, { ...input, right: { ...input.right, action: 'delete', target: 'unknown' } }, missing);
  assert.equal(owner.status === 202 && owner.body.state, 'call_owner');
  assert.equal(stored[0].answer, 'call_owner');
});

test('owner answer follows a call_owner step and cannot replace a waiting or closed answer', async () => {
  let answers: any[] = [];
  const tx = { rightRequests: { get: async () => ({ id: 'request' }) }, rightAnswers: { listForRequest: async () => answers, create: async (row: any) => { answers.push(row); return row; } } } as any;
  assert.deepEqual(await answerOwnerRequest(tx, { requestId: 'request', ownerId: 'owner', answer: 'refuse', reason: 'no' }), { error: 'request_not_owner' });
  answers = [{ answer: 'call_owner', step: 1 }];
  const result = await answerOwnerRequest(tx, { requestId: 'request', ownerId: 'owner', answer: 'refuse', reason: 'no' });
  assert.equal(result.answer?.step, 2);
  assert.equal(answers[0].answer, 'call_owner');
  assert.deepEqual(await answerOwnerRequest(tx, { requestId: 'request', ownerId: 'owner', answer: 'refuse', reason: 'no' }), { error: 'request_closed' });
});

test('a grant requires the owner act to match the request and owner', async () => {
  let writes = 0;
  const tx = { rightRequests: { get: async () => ({ id: 'request', requestHash: 'hash' }) }, rightAnswers: { listForRequest: async () => [{ answer: 'call_owner', step: 1 }], create: async (value: unknown) => { writes++; return value; } }, confirmations: { get: async () => ({ id: 'act', actorId: 'other', targetId: 'request', requestHash: 'hash', usedAt: null, expiresAt: new Date(2000) }) } } as any;
  const input = { requestId: 'request', ownerId: 'owner', answer: 'grant' as const, ownerActRef: 'act', channel: 'api', deviceSessionId: null, now: new Date(1000) };
  assert.deepEqual(await answerOwnerRequest(tx, input), { error: 'confirmation_invalid' });
  assert.equal(writes, 0);
});

test('the owner list uses exact publication and deletion targets', () => {
  const right = (action: string, target: string) => ({ action, target, conditions: {} });
  assert.equal(isOwnerOnly(right('push', 'working_branch')), false);
  assert.equal(isOwnerOnly(right('push', 'rewrite_history')), true);
  assert.equal(isOwnerOnly(right('delete', 'temporary_files')), false);
  assert.equal(isOwnerOnly(right('delete', 'unknown')), true);
  assert.equal(isOwnerOnly(right('read', 'file')), false);
});

test('a matching confirmation yields a distinct owner grant answer', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const act = { id, actorId: 'owner', channel: 'api', deviceSessionId: null, operation: 'right_request', targetType: 'right_request', targetId: 'request', requestHash: 'hash', usedAt: null, expiresAt: new Date(2000) };
  const tx = { rightRequests: { get: async () => ({ id: 'request', requestHash: 'hash', taskId: 'task' }) }, rightAnswers: { listForRequest: async () => [{ answer: 'call_owner', step: 1 }], create: async (row: any) => row }, confirmations: { get: async () => act }, rightGrants: { list: async () => [{ answerId: 'answer' }] } } as any;
  tx.rightAnswers.create = async (row: any) => ({ ...row, id: 'answer' });
  const result = await answerOwnerRequest(tx, { requestId: 'request', ownerId: 'owner', answer: 'grant', ownerActRef: id, channel: 'api', deviceSessionId: null, now: new Date(1000) });
  assert.equal(result.answer?.ownerActRef, id);
  assert.equal(result.answer?.step, 2);
  assert.equal(result.grant?.answerId, 'answer');
});

test('an independent engineer can record call_owner without closing the request', async () => {
  let written: any;
  const tx = { rightRequests: { get: async () => ({ id: 'request', handlingTaskId: 'task', runId: 'requester' }) }, rightAnswers: { listForRequest: async () => [], create: async (row: unknown) => { written = row; return row; } }, taskReads: { getRun: async () => ({ id: 'engineer', taskId: 'task', role: 'chief_engineer', agentId: 'agent' }) }, agents: { lock: async () => {} }, rightsSuspensions: { openForAgent: async () => undefined } } as any;
  const answer = await recordEngineerAnswer(tx, { requestId: 'request', engineerRunId: 'engineer', answer: 'call_owner', reason: 'owner needed' });
  assert.equal(answer.answer, 'call_owner');
  assert.equal(written.step, 1);
  assert.equal(written.stepKind, 'chief_engineer');
  tx.taskReads.getRun = async () => ({ id: 'requester', taskId: 'task', role: 'chief_engineer', agentId: 'agent' });
  await assert.rejects(recordEngineerAnswer(tx, { requestId: 'request', engineerRunId: 'requester', answer: 'refuse', reason: 'no' }));
});
