import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import { recordDecision, DecisionProblem } from '../../api/decisions.ts';
import { phaseTwoBlockKinds } from '../../contracts/states.ts';
import { migrate } from '../../db/migrate.ts';
import { createRepo } from '../../db/repo/index.ts';
import { StaleVersionError } from '../../db/repo/errors.ts';
import { blockHandler } from '../../rights/blocks.ts';
import { connectBench, databaseBench } from '../database-bench.ts';

const bench = databaseBench(import.meta.url);
let sql: ReturnType<typeof connectBench>;
let repo: ReturnType<typeof createRepo>;
const owner = randomUUID();
const now = new Date('2030-01-01T00:00:00Z');

before(async () => {
  const db = await bench;
  await migrate({ url: db.migratorUrl });
  sql = connectBench(db.migratorUrl);
  repo = createRepo(drizzle(sql));
  await sql`INSERT INTO owners (id, name) VALUES (${owner}, 'Bench owner')`;
});
after(async () => { await sql?.end(); });

test('block-owner-load: kinds and owner causes are stored with the rule handler', async () => {
  for (const kind of phaseTwoBlockKinds) {
    for (const needsOwner of [false, true]) {
      const id = randomUUID();
      const handler = blockHandler(kind, { needsOwner, noEnabledAgentCanRun: needsOwner });
      await sql`INSERT INTO tasks (id, depth, status, block_kind, block_handler) VALUES (${id}, 0, 'BLOCKED', ${kind}, ${handler})`;
      assert.equal((await repo.tasks.get(id))?.blockHandler, handler);
    }
  }
});

test('block-owner-load: handoff keeps the block and rejects stale writes and later engineer decisions', async () => {
  const taskId = randomUUID(), run = randomUUID();
  await sql`INSERT INTO tasks (id, depth, status, block_kind, block_handler, current_revision) VALUES (${taskId}, 0, 'BLOCKED', 'execution', 'chief_engineer', 1)`;
  await sql`INSERT INTO task_runs (id, task_id, role) VALUES (${run}, ${taskId}, 'chief_engineer')`;
  const body = { block_kind: 'execution', choice: 'call_owner', reason: 'Owner decision needed' };
  const recorded = await recordDecision(repo, { taskId, kind: 'resolve_block', channel: 'api', engineerRunId: run, body, idempotencyKey: randomUUID(), now });
  assert.equal(recorded.status, 202);
  if (recorded.status !== 202) return;
  const row = await repo.decisions.get(recorded.body.id);
  assert.equal(row?.engineerRunId, run);
  assert.equal(row?.channel, 'api');
  const task = (await repo.tasks.get(taskId))!;
  const handed = await repo.tasks.transition(taskId, task.rowVersion, 'BLOCKED', { blockHandler: 'owner' });
  assert.equal(handed?.status, 'BLOCKED');
  assert.equal(handed?.blockHandler, 'owner');
  await assert.rejects(repo.tasks.transition(taskId, task.rowVersion, 'ASSIGNED'), StaleVersionError);
  await assert.rejects(recordDecision(repo, { taskId, kind: 'resolve_block', channel: 'api', engineerRunId: run, body, idempotencyKey: randomUUID(), now }),
    (error: unknown) => error instanceof DecisionProblem && error.code === 'block_handled');
  const ownerDecision = await recordDecision(repo, { taskId, kind: 'resolve_block', channel: 'api', actorId: owner,
    body: { block_kind: 'execution', answer: 'retry', revision_number: 1 }, idempotencyKey: randomUUID(), now });
  assert.equal(ownerDecision.status, 202);
});
