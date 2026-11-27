import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockKinds } from '../contracts/states.ts';
import { blockHandler } from '../rights/blocks.ts';

test('block handler assigns each kind and owner causes', () => {
  for (const kind of blockKinds) {
    assert.equal(blockHandler(kind), ['scope', 'agent_question', 'quarantine'].includes(kind) ? 'owner' : 'chief_engineer');
    assert.equal(blockHandler(kind, { needsOwner: true, noEnabledAgentCanRun: true }), 'owner');
  }
  assert.equal(blockHandler('usage_limit', { noEnabledAgentCanRun: true }), 'owner');
  assert.equal(blockHandler('usage_limit', { noEnabledAgentCanRun: false }), 'chief_engineer');
  assert.equal(blockHandler('usage_limit', { needsOwner: true, noEnabledAgentCanRun: false }), 'chief_engineer');
});

