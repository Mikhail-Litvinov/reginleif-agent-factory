import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loosenedColumns } from '../api/handlers/policy-loosening.ts';

const base = {
  allowed_commands: ['npm test'], allowed_directories: ['.'], allowed_repositories: ['a'], git_operations: ['commit'],
  confirmation_required: ['push'], allowed_tools: ['bash'], network: { hosts: ['a'] },
  max_concurrent_tasks: 2, max_tasks_per_agent: 2, max_run_seconds: 100, max_tokens: 1000, max_auto_fixes: 1, max_attempts: 3,
  max_rework_rounds: 2, max_child_depth: 2, max_children_per_task: 2, max_cost: '10.50', currency: 'USD', auto_accept_low_risk: false,
};
const with_ = (patch: Record<string, unknown>) => ({ ...base, ...patch });

test('no policy yet: nothing is loosened', () => {
  assert.deepEqual(loosenedColumns(undefined, base), []);
});

test('an identical policy is not a loosening', () => {
  assert.deepEqual(loosenedColumns(base, { ...base }), []);
});

test('allow lists: an added element loosens, a removed one tightens', () => {
  for (const column of ['allowed_commands', 'allowed_directories', 'allowed_repositories', 'allowed_tools', 'git_operations']) {
    assert.deepEqual(loosenedColumns(base, with_({ [column]: [...(base as any)[column], 'new'] })), [column]);
    assert.deepEqual(loosenedColumns(base, with_({ [column]: [] })), []);
    assert.deepEqual(loosenedColumns(base, with_({ [column]: [...(base as any)[column].slice(0, 0), 'other'] })), [column]);
  }
  assert.deepEqual(loosenedColumns(base, with_({ allowed_tools: null })), ['allowed_tools']);
});

test('confirmation_required: a removed element loosens, an added one tightens', () => {
  assert.deepEqual(loosenedColumns(base, with_({ confirmation_required: [] })), ['confirmation_required']);
  assert.deepEqual(loosenedColumns(base, with_({ confirmation_required: ['push', 'merge'] })), []);
  assert.deepEqual(loosenedColumns(base, with_({ confirmation_required: ['merge'] })), ['confirmation_required']);
});

test('auto_accept_low_risk: false to true loosens, true to false does not', () => {
  assert.deepEqual(loosenedColumns(base, with_({ auto_accept_low_risk: true })), ['auto_accept_low_risk']);
  assert.deepEqual(loosenedColumns(with_({ auto_accept_low_risk: true }), base), []);
});

test('network has no documented order: any change loosens, equal does not (key order ignored)', () => {
  assert.deepEqual(loosenedColumns(base, with_({ network: { hosts: ['a'], mode: 'x' } })), ['network']);
  assert.deepEqual(loosenedColumns(with_({ network: { a: 1, b: 2 } }), with_({ network: { b: 2, a: 1 } })), []);
});

test('limits: higher value or null replacing a value loosens, lower or a value replacing null does not', () => {
  for (const column of ['max_concurrent_tasks', 'max_tasks_per_agent', 'max_run_seconds', 'max_tokens', 'max_auto_fixes', 'max_attempts', 'max_rework_rounds', 'max_child_depth', 'max_children_per_task']) {
    const value = (base as any)[column] as number;
    assert.deepEqual(loosenedColumns(base, with_({ [column]: value + 1 })), [column]);
    assert.deepEqual(loosenedColumns(base, with_({ [column]: null })), [column]);
    assert.deepEqual(loosenedColumns(base, with_({ [column]: value - 1 })), []);
    assert.deepEqual(loosenedColumns(with_({ [column]: null }), base), []);
    assert.deepEqual(loosenedColumns(with_({ [column]: null }), with_({ [column]: null })), []);
  }
});

test('max_cost compares numerically as a decimal string', () => {
  assert.deepEqual(loosenedColumns(base, with_({ max_cost: '9.99' })), []);
  assert.deepEqual(loosenedColumns(base, with_({ max_cost: '100.00' })), ['max_cost']);
  assert.deepEqual(loosenedColumns(base, with_({ max_cost: '10.5' })), []);
  assert.deepEqual(loosenedColumns(base, with_({ max_cost: null })), ['max_cost']);
});

test('a changed currency under a cost limit loosens fail-safe', () => {
  assert.deepEqual(loosenedColumns(base, with_({ currency: 'EUR' })), ['currency']);
  assert.deepEqual(loosenedColumns(with_({ max_cost: null, currency: null }), with_({ max_cost: null, currency: 'EUR' })), []);
});

test('several loosened columns are all reported', () => {
  assert.deepEqual(loosenedColumns(base, with_({ allowed_tools: ['bash', 'x'], max_tokens: 5000 })).sort(), ['allowed_tools', 'max_tokens']);
});
