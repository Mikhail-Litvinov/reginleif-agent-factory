import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { z } from 'zod';
import { generateOpenApi, generateOpenApiQuestions } from '../contracts/generate-openapi.ts';
import type { Route } from '../contracts/routes.ts';
import { routes } from '../contracts/routes.ts';

test('resolve-block limits worker access to the chief engineer run', () => {
  const route = routes.find((entry) => entry.method === 'POST' && entry.path === '/tasks/{id}/resolve-block');
  assert.ok(route);
  assert.ok(route.roles.includes('worker:chief_engineer_run'));
  assert.ok(!route.roles.includes('worker'));
});

test('relay decisions carry the press identity with the decision payload', () => {
  const route = routes.find((entry) => entry.method === 'POST' && entry.path === '/tasks/{id}/reject');
  assert.ok(route && typeof route.request !== 'string');
  assert.equal(route.request.safeParse({ revision_number: 1, reason: 'reason', press_id: 'press', telegram_user_id: 123 }).success, true);
});

test('device sessions inherit earlier owner routes except token management', () => {
  const find = (method: string, path: string) => routes.find((route) => route.method === method && route.path === path);
  assert.ok(find('POST', '/tasks')?.roles.includes('device'));
  assert.ok(find('POST', '/tasks/{id}/approve')?.roles.includes('device'));
  assert.ok(!find('POST', '/tokens')?.roles.includes('device'));
});

test('device enrollment uses the specific invalid-code problem code', () => {
  const route = routes.find((entry) => entry.method === 'POST' && entry.path === '/devices/enroll');
  assert.ok(route);
  assert.ok(route.errors[401]?.includes('device_code_invalid'));
  assert.ok(route.responses[401] && typeof route.responses[401] !== 'string');
});

test('generator retains error schemas and does not impose UUIDs on path parameters', () => {
  const route: Route = {
    method: 'GET', path: '/revisions/{n}', operationId: 'getRevision', roles: ['owner'],
    request: 'none', responses: { 200: z.object({ n: z.number() }) },
    errors: { 404: ['not_found'] }, idempotent: true, parameters: [],
  };
  const document = JSON.parse(generateOpenApi([route]));
  const operation = document.paths['/revisions/{n}'].get;
  assert.deepEqual(operation.parameters[0].schema, { type: 'string' });
  assert.ok(operation.responses['404'].content['application/problem+json'].schema);
});

test('unspecified request bodies remain valid OpenAPI request bodies', () => {
  const route: Route = {
    method: 'POST', path: '/open-shape', operationId: 'openShape', roles: ['owner'],
    request: 'unspecified', responses: { 200: 'unspecified' }, errors: {}, idempotent: true, parameters: [],
  };
  const operation = JSON.parse(generateOpenApi([route])).paths['/open-shape'].post;
  assert.equal(operation.requestBody.content['application/json'].schema['x-body-unspecified'], true);
  assert.equal(operation.requestBody.required, undefined);
});

test('a documented delete without a body definition remains unspecified', () => {
  const route = routes.find((entry) => entry.method === 'DELETE' && entry.path === '/tasks/{id}');
  assert.equal(route?.request, 'unspecified');
});

test('artifact content is represented as bytes', () => {
  const operation = JSON.parse(generateOpenApi()).paths['/artifacts/{id}/content'];
  assert.ok(operation.put.requestBody.content['application/octet-stream']);
  assert.ok(operation.get.responses['200'].content['application/octet-stream']);
});

test('dangerous operations expose second-press errors and header', () => {
  const route = routes.find((entry) => entry.method === 'POST' && entry.path === '/devices');
  assert.ok(route);
  assert.ok(route.parameters.some((parameter) => parameter.name === 'X-Confirm'));
  assert.ok(route.errors[409]?.includes('confirmation_required'));
  assert.ok(route.errors[409]?.includes('confirmation_invalid'));
  const document = JSON.parse(generateOpenApi());
  const schema = document.paths['/devices'].post.responses['409'].content['application/problem+json'].schema;
  assert.ok(schema.anyOf.some((variant: { $ref: string }) => variant.$ref === '#/components/schemas/ConfirmationRequired'));
});

test('task status can be repeated in the query', () => {
  const operation = JSON.parse(generateOpenApi()).paths['/tasks'].get;
  const status = operation.parameters.find((parameter: { name: string }) => parameter.name === 'status');
  assert.equal(status.schema.type, 'array');
  assert.equal(status.explode, true);
});

test('idempotency keys carry the documented length and character constraints', () => {
  const operation = JSON.parse(generateOpenApi()).paths['/tasks'].post;
  const parameter = operation.parameters.find((item: { name: string }) => item.name === 'Idempotency-Key');
  assert.equal(parameter.schema.minLength, 8);
  assert.equal(parameter.schema.maxLength, 128);
  assert.ok(parameter.schema.pattern);
});

test('worker registration accepts textual machine identifiers and an integer contract version', () => {
  const route = routes.find((entry) => entry.method === 'POST' && entry.path === '/workers/register');
  assert.ok(route && typeof route.request !== 'string');
  assert.equal(route.request.safeParse({ machine_id: 'host-example', name: 'worker', platform: 'linux', capabilities: {}, version: 'example', contract_version: 1 }).success, true);
});

test('the registry gate describes its documented pass response', () => {
  const route = routes.find((entry) => entry.method === 'POST' && entry.path === '/registry/gate');
  assert.ok(route);
  const response = route.responses[200];
  assert.ok(response && typeof response !== 'string');
  assert.equal(response.safeParse({ pass: true }).success, true);
  assert.equal(response.safeParse({ pass: false, records: [] }).success, true);
});

test('right requests describe the documented run and session forms', () => {
  const route = routes.find((entry) => entry.method === 'POST' && entry.path === '/rights/requests');
  assert.ok(route && typeof route.request !== 'string');
  const request = { action: 'read', target: {}, reason: 'reason', tried: [] };
  assert.equal(route.request.safeParse({ ...request, session_id: '00000000-0000-4000-8000-000000000001' }).success, true);
  assert.equal(route.request.safeParse({ ...request, run_id: '00000000-0000-4000-8000-000000000001' }).success, true);
});

test('documented table routes occur exactly once, with roles and responses', async () => {
  const lines = (await readFile(new URL('../../docs/agent-factory/api.md', import.meta.url), 'utf8')).split(/\r?\n/);
  const endpointStart = lines.findIndex((line) => line === '## Endpoints');
  const endpointEnd = lines.findIndex((line) => line === '## Idempotency');
  const decisionStart = lines.findIndex((line) => line.startsWith('### Decisions '));
  const decisionEnd = lines.findIndex((line) => line.startsWith('**Who handles a block.**'));
  assert.ok(endpointStart >= 0 && endpointEnd > endpointStart && decisionStart > endpointStart && decisionEnd > decisionStart);
  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('| `') || index <= endpointStart || index >= endpointEnd || (index > decisionStart && index < decisionEnd)) continue;
    const first = line.split(/(?<!\\)\|/)[1] ?? '';
    const segments = [...first.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
    if (!segments.length || !/^(GET|POST|PUT|PATCH|DELETE|HEAD)/.test(segments[0] ?? '')) continue;
    let method = '';
    let path = '';
    const documented: string[] = [];
    for (const segment of segments) {
      const match = segment.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD)(?:\/(GET|POST))?(?: (.*))?$/);
      if (match) {
        method = match[1] ?? '';
        if (!match[3] && !path) continue;
        if (match[3]) {
          path = match[3].startsWith('...') ? path + match[3].slice(3) : match[3];
        }
        if (path.includes('[/{dep}]')) {
          documented.push(`POST ${path.replace('[/{dep}]', '')}`, `DELETE ${path.replace('[/{dep}]', '/{dep}')}`);
        } else {
          documented.push(`${method} ${path}`);
          if (match[2]) documented.push(`${match[2]} ${path}`);
        }
      } else if (segment.startsWith('...')) {
        const suffix = segment.slice(3);
        path = suffix === '/{id}' || suffix === '/{n}' ? path + suffix : path.slice(0, path.lastIndexOf('/')) + suffix;
        documented.push(`${method} ${path}`);
      } else if (segment.startsWith('/')) {
        path = path.slice(0, path.lastIndexOf('/')) + segment;
        documented.push(`${method} ${path}`);
      }
    }
    for (const key of new Set(documented)) {
      const matching = routes.filter((route) => `${route.method} ${route.path}` === key);
      assert.equal(matching.length, 1, `api.md:${index + 1}: ${key}`);
    }
  }
  for (const [offset, line] of lines.slice(decisionStart, decisionEnd).entries()) {
    if (!line.startsWith('| `')) continue;
    for (const [, name] of (line.split('|')[1] ?? '').matchAll(/`([^`]+)`/g)) {
      const key = `POST /tasks/{id}/${name}`;
      assert.equal(routes.filter((route) => `${route.method} ${route.path}` === key).length, 1, `api.md:${decisionStart + offset + 1}: ${key}`);
    }
  }
  for (const [fragment, key] of [
    ['POST /tasks/{id}/publish', 'POST /tasks/{id}/publish'],
    ['GET /decisions/{id}', 'GET /decisions/{id}'],
    ['POST /robots/{id}/reports', 'POST /robots/{id}/reports'],
    ['GET /robots/{id}/commands', 'GET /robots/{id}/commands'],
    ['POST /robots/{id}/challenges', 'POST /robots/{id}/challenges'],
    ['HEAD returns the received size', 'HEAD /artifacts/{id}/content'],
  ] as const) {
    const line = lines.findIndex((text) => text.includes(fragment));
    assert.notEqual(line, -1, `missing api.md reference: ${fragment}`);
    assert.equal(routes.filter((route) => `${route.method} ${route.path}` === key).length, 1, `api.md:${line + 1}: ${key}`);
  }
  const keys = routes.map((route) => `${route.method} ${route.path}`);
  assert.equal(new Set(keys).size, keys.length, 'duplicate route');
  for (const route of routes) {
    assert.ok(route.roles.length, `${route.method} ${route.path}: roles`);
    assert.ok(Object.values(route.responses).every((body) => body !== undefined), `${route.method} ${route.path}: response`);
    assert.ok(Object.keys(route.responses).length, `${route.method} ${route.path}: response`);
  }
});

test('committed OpenAPI document matches regeneration', async () => {
  const committed = await readFile(new URL('../contracts/openapi.json', import.meta.url), 'utf8');
  assert.ok(committed === generateOpenApi(), 'openapi.json differs from regeneration');
});

test('open body inventory matches the route table', async () => {
  const committed = await readFile(new URL('../contracts/openapi-questions.md', import.meta.url), 'utf8');
  assert.ok(committed === generateOpenApiQuestions(), 'openapi-questions.md differs from routes');
});
