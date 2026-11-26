import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger } from '../lib/log.ts';

const context = {
  project_id: 'project-1',
  task_id: 'task-2',
  run_id: 'run-3',
  workflow_id: 'workflow-4',
  worker_id: 'worker-5',
  correlation_id: 'correlation-6',
};

test('writes a structured record with the six named context fields and injected timestamp', () => {
  const lines: string[] = [];
  const logger = createLogger({
    clock: () => new Date('2026-11-26T12:34:56.000Z'),
    sink: (line) => lines.push(line),
  });

  logger.info('started', context);

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), {
    timestamp: '2026-11-26T12:34:56.000Z',
    level: 'info',
    message: 'started',
    project_id: 'project-1',
    task_id: 'task-2',
    run_id: 'run-3',
    workflow_id: 'workflow-4',
    worker_id: 'worker-5',
    correlation_id: 'correlation-6',
  });
});

test('child logger bindings merge with per-record context, with record context taking precedence', () => {
  const lines: string[] = [];
  const logger = createLogger({ sink: (line) => lines.push(line) })
    .child({ project_id: 'project-parent', task_id: 'task-parent' });

  logger.info('child record', { ...context, project_id: 'project-record' });

  const record = JSON.parse(lines[0]!);
  assert.equal(record.project_id, 'project-record');
  assert.equal(record.task_id, 'task-2');
  assert.equal(record.correlation_id, 'correlation-6');
});

test('redacts every occurrence of registered secret values in messages and context', () => {
  const lines: string[] = [];
  const logger = createLogger({
    sink: (line) => lines.push(line),
    secretValues: ['canary-secret'],
  });

  logger.error('credential=canary-secret; canary-secret', {
    ...context,
    correlation_id: 'request-canary-secret',
  });

  const output = lines[0]!;
  assert.equal(output.includes('canary-secret'), false);
  const record = JSON.parse(output);
  assert.equal(record.message, 'credential=[REDACTED]; [REDACTED]');
  assert.equal(record.correlation_id, 'request-[REDACTED]');
});

test('writes exactly one JSON line per log record', () => {
  const lines: string[] = [];
  const logger = createLogger({ sink: (line) => lines.push(line) });

  logger.debug('first');
  logger.warn('second');

  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal(line.includes('\n'), false);
    assert.doesNotThrow(() => JSON.parse(line));
  }
});
