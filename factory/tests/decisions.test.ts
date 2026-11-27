import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { decisionKinds, DecisionProblem, recordDecision } from '../api/decisions.ts';
import { decisionRequestSchemas } from '../contracts/schemas/index.ts';
import { migrate } from '../db/migrate.ts';
import { createRepo } from '../db/repo/index.ts';
import { connectBench, databaseBench } from './database-bench.ts';

const benchPromise = databaseBench(import.meta.url);
let client: ReturnType<typeof postgres>;
let repo: ReturnType<typeof createRepo>;
const owner = '10000000-0000-7000-8000-000000000001';
const task = '10000000-0000-7000-8000-000000000002';
const now = new Date('2030-01-01T00:00:00Z');
const base = { taskId: task, actorId: owner, channel: 'client' as const, windowSeconds: 60, now };
before(async () => {
  const bench = await benchPromise;
  await migrate({ url: bench.migratorUrl });
  client = connectBench(bench.migratorUrl);
  repo = createRepo(drizzle(client));
  await client`INSERT INTO owners (id, name) VALUES (${owner}, 'decision owner')`;
  await client`INSERT INTO tasks (id, depth) VALUES (${task}, 0)`;
});
after(async () => { await client?.end(); });

test('decision-recorded: a stale revision is recorded for workflow delivery', async () => {
  const result = await recordDecision(repo, { ...base, kind: 'approve', body: { revision_number: 999, comment: '' }, idempotencyKey: 'stale-key' });
  assert.equal(result.status, 202);
  if (result.status !== 202) return;
  const row = await repo.decisions.get(result.body.id);
  assert.equal(row?.deliveryState, 'recorded');
  assert.equal((await repo.outbox.get(row!.outboxId!))?.decisionId, row!.id);
});

test('decision-kinds: the service exposes all twelve workflow decision kinds', () => {
  assert.deepEqual([...decisionKinds].sort(), ['approve', 'reject', 'request_changes', 'cancel', 'pause', 'resume', 'revise_requirements', 'add_feedback', 'change_priority', 'resolve_block', 'force_close', 'allow_agent'].sort());
  assert.equal(Object.keys(decisionRequestSchemas).length, 12);
});

test('second-press: same actor, channel, body and unexpired unused confirmation', async () => {
  for (const kind of ['cancel', 'reject', 'force_close'] as const) {
    const body = kind === 'reject' ? { revision_number: 1, reason: 'test' } : { reason: 'test' };
    const first = await recordDecision(repo, { ...base, kind, body, idempotencyKey: `${kind}-first` });
    assert.equal(first.status, 409);
    if (first.status !== 409) continue;
    const confirm = `${first.body.confirmation_id}.${first.body.nonce}`;
    const second = { ...base, kind, body, confirm, idempotencyKey: `${kind}-second` };
    await assert.rejects(recordDecision(repo, { ...second, channel: 'api' }), (e: unknown) => e instanceof DecisionProblem && e.code === 'confirmation_invalid');
    await assert.rejects(recordDecision(repo, { ...second, now: new Date(now.getTime() + 60000) }), (e: unknown) => e instanceof DecisionProblem && e.code === 'confirmation_invalid');
    const accepted = await recordDecision(repo, second);
    assert.equal(accepted.status, 202);
    await assert.rejects(recordDecision(repo, { ...second, idempotencyKey: `${kind}-again` }), (e: unknown) => e instanceof DecisionProblem && e.code === 'confirmation_invalid');
  }
});

test('client-retry: identical requests replay, changed bodies conflict', async () => {
  const input = { ...base, kind: 'pause' as const, body: { reason: 'wait' }, idempotencyKey: 'retry-key' };
  const first = await recordDecision(repo, input);
  const retry = await recordDecision(repo, input);
  assert.equal(first.status, 202);
  assert.deepEqual(retry.body, first.body);
  assert.equal(retry.replayed, true);
  await assert.rejects(recordDecision(repo, { ...input, body: { reason: 'changed' } }), (e: unknown) => e instanceof DecisionProblem && e.code === 'idempotency_conflict');
});

test('a failure after inserting a decision rolls back the decision and outbox', async () => {
  const decisionId = '10000000-0000-7000-8000-000000000003';
  const outboxId = '10000000-0000-7000-8000-000000000004';
  await assert.rejects(repo.transaction(async tx => {
    await tx.decisions.insertPair({ decision: { id: decisionId, taskId: task, kind: 'pause', actorId: owner, channel: 'client', idempotencyKey: 'rollback-key', requestHash: 'test', deliveryState: 'recorded', outboxId }, outbox: { id: outboxId, kind: 'deliver_decision', taskId: task, decisionId, payload: { decision_id: decisionId }, state: 'pending', attempts: 0 } });
    throw new Error('forced failure after decision');
  }), /forced failure/);
  assert.equal(await repo.decisions.get(decisionId), undefined);
  assert.equal(await repo.outbox.get(outboxId), undefined);
});
