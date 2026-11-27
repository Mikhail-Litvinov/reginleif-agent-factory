import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordDecision } from '../api/decisions.ts';
import type { Repo } from '../db/repo/index.ts';

test('a retry returns the same decision and its current delivery state', async () => {
  let row: any;
  const tx = { decisions: {
    lockKey: async () => {},
    byActorKey: async () => row,
    insertPair: async ({ decision }: any) => { row = { ...decision, refusalReason: null }; return { decision: row }; },
  }, idempotencyKeys: { get: async () => undefined } };
  const repo = { transaction: async (fn: any) => fn(tx) } as unknown as Repo;
  const input = { taskId: 'task', kind: 'pause' as const, actorId: 'owner', channel: 'client' as const, idempotencyKey: 'abcdefgh', body: { reason: 'wait' }, windowSeconds: 60 };
  const first = await recordDecision(repo, input);
  row.deliveryState = 'applied';
  const replay = await recordDecision(repo, input);
  assert.equal(first.status, 202);
  assert.equal(replay.status, 202);
  assert.equal(first.body.id, replay.body.id);
  assert.equal(replay.replayed, true);
  assert.equal(replay.body.delivery_state, 'applied');
});
