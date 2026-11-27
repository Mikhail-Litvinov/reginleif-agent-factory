import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standingTaskFor } from '../rights/standing-task.ts';

test('resolves the project standing task and the seeded system project', async () => {
  const seen: string[] = [];
  const tasks = { list: async ({ projectId }: { projectId: string }) => { seen.push(projectId); return [{ id: 'standing', originType: 'standing' }]; } };
  assert.equal(await standingTaskFor(tasks, 'project'), 'standing');
  assert.equal(await standingTaskFor(tasks, null), 'standing');
  assert.deepEqual(seen, ['project', '00000000-0000-4000-8000-000000000007']);
  await assert.rejects(standingTaskFor({ list: async () => [] }, 'project'));
});
