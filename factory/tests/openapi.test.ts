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
  const body = { revision_number: 1, reason: 'reason', press_id: '00000000-0000-4000-8000-000000000001', telegram_user_id: 123 };
  assert.equal(route.request.safeParse(body).success, true);
  assert.equal(route.request.safeParse({ ...body, press_id: 'press' }).success, true);
  assert.equal(route.request.safeParse({ ...body, press_id: 42 }).success, false);
});

test('relay resolve-block preserves the call-owner variant', () => {
  const route = routes.find((entry) => entry.method === 'POST' && entry.path === '/tasks/{id}/resolve-block');
  assert.ok(route && typeof route.request !== 'string');
  assert.equal(route.request.safeParse({block_kind:'execution', choice:'call_owner', reason:'Need a decision', press_id:'00000000-0000-4000-8000-000000000001', telegram_user_id:123}).success, true);
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

test('a documented delete takes no body', () => {
  const route = routes.find((entry) => entry.method === 'DELETE' && entry.path === '/tasks/{id}');
  assert.equal(route?.request, 'none');
});

test('project creation accepts defaults and rejects unknown fields', () => {
  const route = routes.find((entry) => entry.method === 'POST' && entry.path === '/projects');
  assert.ok(route && typeof route.request !== 'string');
  const body = { name: 'Example', repository_url: 'https://example.invalid/repository' };
  assert.equal(route.request.safeParse(body).success, true);
  assert.equal(route.request.safeParse({ ...body, unexpected: true }).success, false);
});

test('unspecified bodies equal the Open shapes inventory', async () => {
  const openRequests = [
    'POST /system/stop-all', 'PUT /personnel/replacement-procedure', 'POST /robots', 'PATCH /robots/{id}',
    'POST /robots/{id}/configurations', 'POST /robots/{id}/assignments', 'POST /robots/{id}/leases',
    'DELETE /robots/{id}/leases/{number}', 'PATCH /robot-zones/{id}', 'POST /robot-start-confirmations',
    'POST /unattended-policies', 'POST /robots/{id}/stop', 'POST /robots/{id}/release',
    'POST /robots/{id}/diagnostics', 'POST /robot-start-presses', 'POST /robot-skills/{id}/qualifications',
    'POST /robot-experiments/{id}/admissions', 'POST /robots/{id}/maintenance', 'POST /robots/{id}/reports',
    'POST /robots/{id}/challenges',
  ];
  const openResponses = [
    'POST /system/stop-all', 'PUT /personnel/replacement-procedure', 'GET /robots', 'GET /robots/{id}',
    'POST /robots', 'PATCH /robots/{id}', 'GET /robots/{id}/configurations', 'POST /robots/{id}/configurations',
    'GET /robots/{id}/state', 'POST /robots/{id}/assignments', 'DELETE /robots/{id}/assignments/{aid}',
    'GET /robots/{id}/leases', 'POST /robots/{id}/leases', 'DELETE /robots/{id}/leases/{number}',
    'GET /robot-zones', 'PATCH /robot-zones/{id}', 'POST /robot-start-confirmations', 'GET /unattended-policies',
    'POST /unattended-policies', 'POST /robots/{id}/stop', 'POST /robots/{id}/release', 'GET /robots/{id}/diagnostics',
    'POST /robots/{id}/diagnostics', 'POST /robot-start-presses', 'GET /robot-skills', 'GET /robot-skills/{id}',
    'POST /robot-skills/{id}/qualifications', 'POST /robot-experiments/{id}/admissions', 'GET /robots/{id}/maintenance',
    'POST /robots/{id}/maintenance', 'GET /inventory', 'GET /robot-experiments', 'GET /robot-experiments/{id}',
    'GET /robot-evidence/{id}', 'GET /robot-stages', 'POST /robots/{id}/reports', 'GET /robots/{id}/commands',
    'POST /robots/{id}/challenges',
  ];
  const actualRequests = routes.filter((route) => route.request === 'unspecified').map((route) => `${route.method} ${route.path}`);
  const actualResponses = routes.flatMap((route) => Object.entries(route.responses).filter(([, body]) => body === 'unspecified').map(([status]) => `${route.method} ${route.path} ${status}`));
  assert.deepEqual(actualRequests.sort(), openRequests.sort());
  const expectedResponses = openResponses.map((key) => `${key} ${key.startsWith('GET ') ? '200' : key === 'POST /robots/{id}/stop' ? '202' : 'default'}`);
  assert.deepEqual(actualResponses.sort(), expectedResponses.sort());

  const document = await readFile(new URL('../../docs/agent-factory/api.md', import.meta.url), 'utf8');
  const section = document.split(/## Open shapes\r?\n/)[1];
  assert.ok(section, 'Open shapes section');
  const documented = new Set<string>();
  for (const line of section.split(/\r?\n/).filter((line) => line.startsWith('| `'))) {
    const cell = line.split('|')[1] ?? '';
    let pending = '';
    let method = '';
    for (const matchToken of cell.matchAll(/`([^`]+)`/g)) {
      const token = matchToken[1]!;
      if (token === 'content') continue;
      if (/^(GET|POST|PUT|PATCH|DELETE)$/.test(token)) { pending = token; continue; }
      const match = token.match(/^(GET|POST|PUT|PATCH|DELETE) (\/\S+)$/);
      if (match) {
        method = match[1]!;
        if (pending) documented.add(`${pending} ${match[2]}`);
        documented.add(`${method} ${match[2]}`);
        pending = '';
      } else if (token.startsWith('/') && method) documented.add(`${method} ${token}`);
    }
  }
  // Hub envelopes are defined; only their content value is open.
  const expectedRoutes = new Set([...openRequests, ...openResponses, 'POST /hub/messages', 'POST /hub/polls', 'POST /hub/states']);
  assert.deepEqual([...documented].sort(), [...expectedRoutes].sort());
});

test('artifact content is represented as bytes', () => {
  const operation = JSON.parse(generateOpenApi()).paths['/artifacts/{id}/content'];
  assert.ok(operation.put.requestBody.content['application/octet-stream']);
  assert.ok(operation.get.responses['200'].content['application/octet-stream']);
});

test('created resources and recorded decisions advertise Location', () => {
  const paths = JSON.parse(generateOpenApi()).paths;
  assert.ok(paths['/projects'].post.responses['201'].headers.Location);
  assert.ok(paths['/tasks/{id}/approve'].post.responses['202'].headers.Location);
  assert.ok(paths['/tasks/{id}/cleanup'].post.responses['202'].headers.Location);
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

test('registry guard conflicts include the conflicting record identifiers', () => {
  const route = routes.find((entry) => entry.method === 'POST' && entry.path === '/registry/records/{id}/activate');
  assert.ok(route);
  const response = route.responses[409];
  assert.ok(response && typeof response !== 'string');
  assert.equal(response.safeParse({type:'about:blank',title:'Conflict',status:409,code:'guard_conflict',detail:'Conflict',request_id:'00000000-0000-4000-8000-000000000001',errors:[],conflicts_with:['00000000-0000-4000-8000-000000000002']}).success, true);
  const schema = JSON.parse(generateOpenApi()).paths['/registry/records/{id}/activate'].post.responses['409'].content['application/problem+json'].schema;
  assert.ok(schema.anyOf.some((item: {$ref?: string}) => item.$ref === '#/components/schemas/GuardConflict'));
});

test('registry activation accepts an optional bulk list', () => {
  const operation = JSON.parse(generateOpenApi()).paths['/registry/records/{id}/activate'].post;
  assert.equal(operation.requestBody.required, undefined);
  const route = routes.find((entry) => entry.method === 'POST' && entry.path === '/registry/records/{id}/activate');
  assert.ok(route && typeof route.request !== 'string');
  assert.equal(route.request.safeParse({ids:['00000000-0000-4000-8000-000000000001']}).success, true);
  assert.equal(route.request.safeParse({ids:['invalid']}).success, false);
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

test('worker registration takes a text machine identifier and an integer contract version', () => {
  const route = routes.find((entry) => entry.method === 'POST' && entry.path === '/workers/register');
  assert.ok(route && typeof route.request !== 'string');
  const body = { machine_id: 'host-example', name: 'worker', platform: 'linux', capabilities: {}, version: 'example', contract_version: 1 };
  assert.equal(route.request.safeParse(body).success, true);
  assert.equal(route.request.safeParse({ ...body, machine_id: 7 }).success, false);
});

// Text-typed `*_id` fields, each by the database column that backs it. A column's own definition beats api.md's
// general rule that every `*_id` is a uuid (api.md:375), which holds only where no column says otherwise.
const textIdColumns: Record<string, string> = {
  machine_id: 'database.md:47 workers.machine_id text unique; database.md:85 registry_records.machine_id text nullable',
  press_id: 'database.md:61 task_decisions.press_id text nullable; database.md:85 registry_records.press_id text unique where not null',
  temporal_activity_id: 'database.md:45 task_runs.temporal_activity_id (no type stated; an arbitrary Temporal id, text in db/schema/runs.ts)',
  session_id: 'database.md:188 conversations.session_ref text (the hub session id; database.md:45 task_runs.session_id states no type)',
};
const textIdFields = new Set(Object.keys(textIdColumns));

test('a *_id field backed by a text column is not typed as a uuid in the generated contract', () => {
  const document: unknown = JSON.parse(generateOpenApi(routes));
  const isUuid = (schema: unknown): boolean => {
    if (!schema || typeof schema !== 'object') return false;
    const node = schema as Record<string, unknown>;
    if (node.format === 'uuid') return true;
    return ['anyOf', 'oneOf', 'allOf'].some((key) => Array.isArray(node[key]) && (node[key] as unknown[]).some(isUuid));
  };
  const seen = new Set<string>();
  const uuidTyped: string[] = [];
  const visit = (node: unknown, where: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${where}[${index}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const properties = record.properties && typeof record.properties === 'object' ? record.properties as Record<string, unknown> : {};
    for (const [name, schema] of Object.entries(properties)) {
      if (!textIdFields.has(name)) continue;
      seen.add(name);
      if (isUuid(schema)) uuidTyped.push(`${where}.${name}`);
    }
    if (typeof record.name === 'string' && 'in' in record && textIdFields.has(record.name)) {
      seen.add(record.name);
      if (isUuid(record.schema)) uuidTyped.push(`${where}.${record.name}`);
    }
    for (const [key, value] of Object.entries(record)) visit(value, `${where}.${key}`);
  };
  visit(document, '');
  assert.deepEqual(uuidTyped, []);
  // Every text column must be found in the document, so the walk cannot pass vacuously.
  assert.deepEqual([...seen].sort(), [...textIdFields].sort());
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
  const request = { action: 'read', target: {}, reason: 'reason', tried: 'checked the policy' };
  assert.equal(route.request.safeParse({ ...request, session_id: '00000000-0000-4000-8000-000000000001' }).success, true);
  assert.equal(route.request.safeParse({ ...request, run_id: '00000000-0000-4000-8000-000000000001' }).success, true);
  assert.equal(route.request.safeParse({ ...request, run_id: '00000000-0000-4000-8000-000000000001', session_id: '00000000-0000-4000-8000-000000000002' }).success, false);
});

test('documented table routes occur exactly once, with roles and responses', async () => {
  const lines = (await readFile(new URL('../../docs/agent-factory/api.md', import.meta.url), 'utf8')).split(/\r?\n/);
  const endpointStart = lines.findIndex((line) => line === '## Endpoints');
  const endpointEnd = lines.findIndex((line) => line === '## Resource shapes');
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
