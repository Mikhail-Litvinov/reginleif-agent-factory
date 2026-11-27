import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmationWindow, issueConfirmation, verifyConfirmation } from '../api/second-press.ts';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routes } from '../contracts/routes.ts';

test('confirmation binds actor, channel, operation, target and hash and expires and is used once', async () => {
  const rows = new Map<string, any>();
  const repo = { settings: { snapshot: async () => ({ 'confirm.windowSeconds': 30 }) }, confirmations: {
    create: async (row: any) => { rows.set(row.id, { ...row, usedAt: null }); return row; },
    get: async (id: string) => rows.get(id),
    consume: async (input: any) => {
      const row = rows.get(input.id);
      if (!row || row.usedAt || row.expiresAt <= input.now || ['actorId', 'channel', 'deviceSessionId', 'operation', 'targetType', 'targetId', 'requestHash'].some(key => row[key] !== input[key])) return null;
      row.usedAt = input.now; return row;
    },
  } } as any;
  const now = new Date('2030-01-01T00:00:00Z');
  const scope = { actorId: 'actor', channel: 'api', deviceSessionId: null, operation: 'cancel', targetType: 'task', targetId: 'task', requestHash: 'hash' };
  const issued = await issueConfirmation(repo, scope, now);
  assert.equal(Date.parse(issued.expires_at) - now.getTime(), 30_000);
  const token = `${issued.confirmation_id}.${issued.nonce}`;
  for (const key of ['actorId', 'channel', 'deviceSessionId', 'operation', 'targetType', 'targetId', 'requestHash'] as const) {
    assert.equal(await verifyConfirmation(repo, token, { ...scope, [key]: 'other' }, now), undefined, key);
  }
  assert.equal(await verifyConfirmation(repo, `${issued.confirmation_id}.wrong`, scope, now), undefined);
  assert.equal(await verifyConfirmation(repo, token, scope, new Date(issued.expires_at)), undefined);
  assert.equal(await verifyConfirmation(repo, token, scope, now), issued.confirmation_id);
  assert.equal(await verifyConfirmation(repo, token, scope, now), undefined);
});

test('a missing or invalid confirmation setting is refused', async () => {
  for (const value of [undefined, null, 0, -1, 1.5, '60']) {
    await assert.rejects(confirmationWindow({ settings: { snapshot: async () => ({ 'confirm.windowSeconds': value }) } } as any));
  }
});

test('second press route marks equal the direct and indirect API requirements', async () => {
  const doc = await readFile(fileURLToPath(new URL('../../docs/agent-factory/api.md', import.meta.url)), 'utf8');
  const expected = new Set<string>();
  const decisions = doc.slice(doc.indexOf('### Decisions '), doc.indexOf('**Who handles a block.**'));
  for (const line of doc.split('\n').filter(line => line.startsWith('| `') && /second press|two presses|two-press|x-confirm|\bD23\b/i.test(line))) {
    const cell = line.split('|')[1]!;
    for (const match of cell.matchAll(/`(POST|PUT|PATCH|DELETE) (\/[^`]+)`/g)) expected.add(`${match[1]} ${match[2]}`);
    if (decisions.includes(line)) for (const match of cell.matchAll(/`([a-z][a-z-]*)`/g)) expected.add(`POST /tasks/{id}/${match[1]}`);
  }
  // Publication is described in prose; API-arbitrated poll answers inherit the decision rules.
  assert.match(doc, /second press through\s*`POST \/tasks\/\{id\}\/publish`/i);
  expected.add('POST /tasks/{id}/publish');
  const pollRow = doc.split('\n').find(line => line.startsWith('| `POST /conversations/{id}/polls/{poll_id}/answer`'));
  assert.match(pollRow ?? '', /decision route of the task with the same body \(Decisions\)/);
  expected.add('POST /conversations/{id}/polls/{poll_id}/answer');
  const marked = routes.filter(route => route.secondPress).map(route => `${route.method} ${route.path}`);
  assert.deepEqual(marked.sort(), [...expected].sort());
});

test('confirmation headers and repository writes stay in the shared mechanism', async () => {
  async function scan(dir: string): Promise<string[]> {
    const files = (await readdir(dir, { withFileTypes: true })).filter(file => file.name !== 'node_modules');
    return (await Promise.all(files.map(file => file.isDirectory() ? scan(join(dir, file.name)) : Promise.resolve([join(dir, file.name)])))).flat();
  }
  for (const path of await scan(fileURLToPath(new URL('..', import.meta.url)))) {    if (!path.endsWith('.ts') || /[\\/]tests[\\/]/.test(path) || /[\\/]api[\\/]second-press\.ts$/.test(path)) continue;
    const source = await readFile(path, 'utf8');
    const withoutDeclarations = source.replace(/name:\s*['"]X-Confirm['"]/g, 'name: declaredHeader');
    assert.doesNotMatch(withoutDeclarations, /x-confirm|\.confirmations\.(?:create|consume)\s*\(/i, path);
    if (!/[\\/]db[\\/]repo[\\/]decisions\.ts$/.test(path)) {
      assert.doesNotMatch(source, /\.insert\(\s*confirmations\s*\)|\binsert\s+into\s+confirmations\b/i, path);
    }
  }
});
