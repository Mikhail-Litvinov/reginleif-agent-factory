import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readChiefEngineerSettings } from '../control/activities/chief-engineer.ts';

test('chief engineer settings come from a single named snapshot', async () => {
  const seen: string[][] = [];
  const result = await readChiefEngineerSettings({ snapshot: async keys => { seen.push([...keys]); return { 'sample.setting': 7 }; } }, ['sample.setting']);
  assert.deepEqual(seen, [['sample.setting']]);
  assert.deepEqual(result, { 'sample.setting': 7 });
});
