import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routes } from '../contracts/routes.ts';
import type { Repo } from '../db/repo/index.ts';
import { createApiServer } from '../api/server.ts';
import { registerAllHandlers } from '../api/handlers/register-all.ts';

// A route without a handler answers 501 not_implemented. Every route of contracts/routes.ts is either registered by
// registerAllHandlers or named here with the package that delivers it. A route listed here that gets a handler fails
// the test too, so the list cannot go stale.
// Package names are the handler files of docs/agent-factory/modules.md that deliver the routes, with their phase.
const later = (pkg: string, entries: string[]): Record<string, string> => Object.fromEntries(entries.map(entry => [entry, pkg]));

const laterPackages: Record<string, string> = {
  ...later('decisions publish route (api/handlers decisions, phase 2)', ['POST /tasks/{id}/publish']),
  ...later('notifications handlers (api/handlers notifications, phase 2)', ['GET /notifications', 'POST /notifications/{id}/ack']),
  ...later('run artifacts and proposals handlers (api/handlers artifacts, proposals; phase 2 routes, phase 4 upload activities)', [
    'POST /runs/{run_id}/artifacts', 'PUT /artifacts/{id}/content', 'HEAD /artifacts/{id}/content', 'GET /artifacts/{id}/content', 'POST /runs/{run_id}/proposals',
  ]),
  ...later('registry handlers (api/handlers/registry.ts, phase 2)', [
    'POST /registry/inquiries', 'GET /registry/inquiries/{id}', 'POST /registry/inquiries/{id}/verdicts', 'POST /registry/gate', 'GET /registry/search',
    'GET /registry/records', 'GET /registry/records/{id}', 'POST /registry/records', 'POST /registry/records/{id}/activate',
    'POST /registry/records/{id}/revoke', 'POST /registry/records/{id}/supersede',
    'GET /regulation/versions', 'GET /regulation/versions/{id}', 'POST /regulation/versions', 'GET /regulation/versions/{id}/diff',
    'POST /regulation/versions/{id}/activate', 'POST /regulation/versions/{id}/revoke',
  ]),
  ...later('rights handlers (api/handlers/rights.ts, phase 2)', [
    'GET /roles', 'GET /roles/{id}', 'GET /tasks/{id}/participants', 'POST /rights/check', 'POST /rights/requests', 'GET /rights/requests',
    'GET /rights/requests/{id}', 'POST /rights/requests/{id}/answer', 'GET /rights/grants', 'POST /rights/grants/{id}/revoke',
    'GET /rights/suspensions', 'GET /rights/suspensions/{id}', 'POST /rights/suspensions/{id}/restore',
  ]),
  ...later('personnel handlers (api/handlers/personnel.ts, phase 5 reads, phase 8 the rest)', [
    'GET /personnel/positions', 'GET /personnel/positions/{id}', 'GET /personnel/profiles', 'GET /personnel/profiles/{agent_id}',
    'GET /personnel/assessments', 'GET /personnel/assessments/{id}', 'GET /personnel/incidents', 'GET /personnel/incidents/{id}',
    'GET /personnel/measures', 'GET /personnel/measures/{id}', 'POST /personnel/incidents', 'POST /personnel/measures',
    'POST /personnel/measures/{id}/restore', 'POST /personnel/chief-engineer', 'DELETE /personnel/chief-engineer',
    'PUT /personnel/replacement-procedure', 'PUT /personnel/mode',
  ]),
  ...later('robotics handlers (api/handlers/robotics.ts, robotics stages R0-R9)', [
    'GET /robots', 'GET /robots/{id}', 'POST /robots', 'PATCH /robots/{id}', 'GET /robots/{id}/configurations', 'POST /robots/{id}/configurations',
    'GET /robots/{id}/state', 'POST /robots/{id}/assignments', 'DELETE /robots/{id}/assignments/{aid}', 'GET /robots/{id}/leases',
    'POST /robots/{id}/leases', 'DELETE /robots/{id}/leases/{number}', 'GET /robot-zones', 'PATCH /robot-zones/{id}',
    'POST /robot-start-confirmations', 'GET /unattended-policies', 'POST /unattended-policies', 'POST /robots/{id}/stop',
    'POST /robots/{id}/release', 'GET /robots/{id}/diagnostics', 'POST /robots/{id}/diagnostics', 'POST /robot-start-presses',
    'GET /robot-skills', 'GET /robot-skills/{id}', 'POST /robot-skills/{id}/qualifications', 'POST /robot-experiments/{id}/admissions',
    'GET /robots/{id}/maintenance', 'POST /robots/{id}/maintenance', 'GET /inventory', 'GET /robot-experiments', 'GET /robot-experiments/{id}',
    'GET /robot-evidence/{id}', 'GET /robot-stages', 'POST /robots/{id}/reports', 'GET /robots/{id}/commands', 'POST /robots/{id}/challenges',
  ]),
  ...later('system handlers (api/handlers system: health and readiness phase 2, metrics phase 7; openapi route phase 2)', [
    'GET /system/health', 'GET /system/ready', 'GET /system/metrics', 'GET /openapi.json',
  ]),
};

const key = (method: string, path: string) => `${method} ${path}`;

function registered(): string[] {
  const api = createApiServer({ tokens: { byHash: async () => undefined } });
  const seen: string[] = [];
  const original = api.register.bind(api);
  api.register = (method, path, handler, options) => { seen.push(key(method, path)); original(method, path, handler, options); };
  registerAllHandlers(api, {} as Repo);
  return seen;
}

test('every route of the contract has a registered handler or names the later package that delivers it', () => {
  const seen = registered();
  const have = new Set(seen);
  const missing = routes.map(route => key(route.method, route.path)).filter(entry => !have.has(entry) && !(entry in laterPackages));
  assert.deepEqual(missing, [], 'routes without a handler and without a later-package entry');
  assert.deepEqual(Object.keys(laterPackages).filter(entry => have.has(entry)), [], 'routes listed as later packages that already have a handler');
  assert.deepEqual(Object.keys(laterPackages).filter(entry => !routes.some(route => key(route.method, route.path) === entry)), [], 'later-package entries that are not routes');
  for (const [entry, name] of Object.entries(laterPackages)) assert.ok(name.length > 0, `${entry} names no package`);
});

test('no route is registered by two handler groups', () => {
  const seen = registered();
  assert.deepEqual(seen.filter((entry, index) => seen.indexOf(entry) !== index), []);
});
