import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApiServer } from '../api/server.ts';
import { StaleVersionError } from '../db/repo/errors.ts';

const repoDirectory = new URL('../db/repo/', import.meta.url);

test('every repository method with an expected row version uses the shared update helper', async () => {
  const files = await readdir(repoDirectory);
  const violations: string[] = [];
  for (const file of files.filter(name => name.endsWith('.ts') && name !== 'errors.ts')) {
    const source = await readFile(new URL(file, repoDirectory), 'utf8');
    const methods = [...source.matchAll(/^\t(\w+): async \([\s\S]*?(?=^\t\w+: async \(|^\}\);)/gm)];
    for (const method of methods) {
      const body = method[0]!;
      if (/\.rowVersion\s*(?:,|===|!==)/.test(body) && !/versionedUpdate\s*\(/.test(body)) {
        violations.push(`${file}:${method[1]}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('the server maps a stale row version to the documented conflict Problem', async () => {
  const secret = 'stale-version-test-secret';
  const tokenHash = createHash('sha256').update(secret).digest('hex');
  const api = createApiServer({ tokens: { byHash: async () => ({ id: randomUUID(), role: 'owner', prefix: 'test', tokenHash,
    workerId: null, revokedAt: null, expiresAt: null, validUntil: null }) } });
  api.register('PATCH', '/projects/{id}', async () => { throw new StaleVersionError('project', 4n, 7n); });
  const address = await api.listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/projects/${randomUUID()}`, {
      method: 'PATCH', headers: { authorization: `Bearer afk_test_${secret}`, 'content-type': 'application/json', 'If-Match': '4' }, body: '{}',
    });
    assert.equal(response.status, 409);
    const problem = await response.json() as { code: string; current_row_version: number; request_id: string; errors: unknown[] };
    assert.equal(problem.code, 'version_conflict');
    assert.equal(problem.current_row_version, 7);
    assert.ok(problem.request_id);
    assert.deepEqual(problem.errors, []);
  } finally { await api.close(); }
});
