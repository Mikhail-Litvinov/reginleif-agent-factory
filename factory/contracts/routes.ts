import { z } from 'zod';
import { artifactUploadRequestSchema, childTaskProposalRequestSchema, createTaskRequestSchema, decisionRequestSchemas, problemDetailsSchema, taskDecisionResponseSchema } from './schemas/index.ts';
import { executionPolicySchema, pageSchema, streamPageSchema, policyPutSchema, projectCreateSchema, projectDetailSchema, projectPatchSchema, projectSchema, routingRuleCreateSchema, routingRuleSchema } from './schemas/projects.ts';
import * as R from './schemas/resources.ts';
import * as Q from './schemas/requests.ts';

/** The API document leaves some body shapes open for their handler packages. */
export type Body = z.ZodType | 'unspecified' | 'none' | 'binary' | 'text' | 'event-stream';

export const confirmationRequiredSchema = problemDetailsSchema.extend({
  code: z.literal('confirmation_required'), confirmation_id: z.string().uuid(),
  nonce: z.string(), expires_at: z.string(),
});
export const guardConflictSchema = problemDetailsSchema.extend({ code: z.literal('guard_conflict'), conflicts_with: z.array(z.string().uuid()) });
const pollClosedSchema = problemDetailsSchema.extend({
  code: z.literal('poll_closed'), answered_via: z.string().nullable(), answered_at: z.iso.datetime().nullable(),
});

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  path: string;
  operationId: string;
  roles: readonly string[];
  request: Body;
  requestOptional?: boolean;
  responses: Readonly<Record<string, Body>>;
  errors: Readonly<Record<number, readonly string[]>>;
  idempotent: boolean;
  secondPress?: 'always' | 'policy-loosening' | 'forced-cleanup' | 'decision-kind' | 'zone-change' | 'robot-release';
  parameters: readonly { name: string; in: 'query' | 'header'; required?: boolean; repeatable?: boolean; schema?: z.ZodType }[];
}

// api.md, Idempotency: 8–128 ASCII letters, digits, underscores or hyphens.
const idempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/);
// A missing owner_act_ref on a right answer is 400; the Errors table calls a
// malformed request validation_failed, although its general status is 422.
const decisions = [
  ['approve', 'approve'], ['reject', 'reject'], ['request-changes', 'request_changes'],
  ['cancel', 'cancel'], ['pause', 'pause'], ['resume', 'resume'],
  ['feedback', 'add_feedback'], ['priority', 'change_priority'],
  ['revisions', 'revise_requirements'], ['resolve-block', 'resolve_block'],
  ['force-close', 'force_close'], ['allow-agent', 'allow_agent'],
] as const;

function relayPayload(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) {
    return schema.extend({ press_id: z.string(), telegram_user_id: z.number().int() });
  }
  if (schema instanceof z.ZodUnion) {
    const options = schema.options.map((option) => {
      if (!(option instanceof z.ZodType)) throw new Error('Unsupported decision option');
      return relayPayload(option);
    });
    return z.union([options[0]!, options[1]!, ...options.slice(2)]);
  }
  throw new Error('Unsupported decision schema');
}

function decisionErrors(path: string): Route['errors'] {
  const errors: Record<number, readonly string[]> = {
    401: ['unauthenticated'], 403: ['forbidden'], 404: ['not_found'],
    409: ['idempotency_conflict', 'idempotency_in_progress', 'press_replayed', 'not_allowed_in_state',
      ...(['reject', 'cancel', 'force-close'].includes(path) ? ['confirmation_required', 'confirmation_invalid'] : []),
      ...(path === 'resolve-block' ? ['block_handled'] : [])],
    422: ['validation_failed', ...(path === 'resolve-block' ? ['owner_only'] : [])],
    429: ['rate_limited'], 500: ['internal'], 503: ['unavailable'],
  };
  if (path === 'resolve-block') errors[426] = ['contract_unsupported'];
  return errors;
}

// The route-specific chief engineer exception overrides the general prohibition
// on decisions by workers; the worker is limited to its own chief engineer run.
const decisionRoutes: readonly Route[] = decisions.map(([path, kind]) => ({
  method: 'POST', path: `/tasks/{id}/${path}`, operationId: `task_${kind}`,
  roles: path === 'resolve-block' ? ['owner', 'device', 'relay:owner_press', 'worker:chief_engineer_run'] : ['owner', 'device', 'relay:owner_press'],
  request: z.union([decisionRequestSchemas[kind], relayPayload(decisionRequestSchemas[kind])]), responses: { 202: taskDecisionResponseSchema },
  errors: decisionErrors(path),
  idempotent: true, parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: idempotencyKeySchema }, { name: 'X-Request-Id', in: 'header' },
    ...(path === 'resolve-block' ? [{ name: 'X-Factory-Contract', in: 'header' as const }] : []),
    ...(['reject', 'cancel', 'force-close'].includes(path) ? [{ name: 'X-Confirm', in: 'header' as const }] : [])],
}));

type Method = Route['method'];
type Input = { method: Method; path: string; roles: readonly string[]; request?: Body;
  responses?: Route['responses']; errors?: Route['errors']; parameters?: Route['parameters']; idempotent?: boolean };

const owner = ['owner'] as const;
const readers = ['owner', 'reader', 'relay'] as const;
const clientReaders = ['owner', 'reader', 'device'] as const;
const workers = ['worker:own_runs'] as const;
const entries: Input[] = [
  { method: 'GET', path: '/projects', roles: readers, responses: { 200: pageSchema(projectSchema) } },
  { method: 'POST', path: '/projects', roles: owner, request: projectCreateSchema, responses: { 201: projectSchema } },
  { method: 'GET', path: '/projects/{id}', roles: readers, responses: { 200: projectDetailSchema } },
  { method: 'PATCH', path: '/projects/{id}', roles: owner, request: projectPatchSchema, responses: { 200: projectSchema }, errors: { 409: ['version_conflict'] } },
  { method: 'POST', path: '/projects/{id}/archive', roles: owner, request: 'none', responses: { 200: projectSchema }, errors: { 409: ['project_active', 'version_conflict'] } },
  { method: 'GET', path: '/projects/{id}/policy', roles: readers, responses: { 200: executionPolicySchema } },
  { method: 'PUT', path: '/projects/{id}/policy', roles: owner, request: policyPutSchema, responses: { 201: executionPolicySchema }, errors: { 409: ['confirmation_required', 'version_conflict'] } },
  { method: 'GET', path: '/projects/{id}/routing-rules', roles: readers, responses: { 200: pageSchema(routingRuleSchema) } },
  { method: 'POST', path: '/projects/{id}/routing-rules', roles: owner, request: routingRuleCreateSchema, responses: { 201: routingRuleSchema } },
  { method: 'DELETE', path: '/projects/{id}/routing-rules/{rule}', roles: owner, request: 'none', responses: { 200: routingRuleSchema } },
  { method: 'GET', path: '/tasks', roles: readers },
  { method: 'POST', path: '/tasks', roles: owner, request: createTaskRequestSchema, responses: { 201: 'unspecified' }, errors: { 404: ['not_found'], 409: ['dependency_cycle'] } },
  { method: 'GET', path: '/tasks/{id}', roles: readers },
  { method: 'DELETE', path: '/tasks/{id}', roles: owner, request: 'none', errors: { 409: ['task_active', 'version_conflict'] } },
  { method: 'GET', path: '/tasks/{id}/revisions', roles: readers },
  { method: 'GET', path: '/tasks/{id}/revisions/{n}', roles: readers },
  { method: 'POST', path: '/tasks/{id}/dependencies', roles: owner, errors: { 409: ['dependency_cycle'] } },
  { method: 'DELETE', path: '/tasks/{id}/dependencies/{dep}', roles: owner },
  { method: 'GET', path: '/tasks/{id}/runs', roles: readers },
  { method: 'GET', path: '/tasks/{id}/events', roles: readers },
  { method: 'GET', path: '/tasks/{id}/artifacts', roles: [...readers, 'worker:own_runs'] },
  { method: 'GET', path: '/tasks/{id}/reviews', roles: readers },
  { method: 'GET', path: '/tasks/{id}/decisions', roles: readers },
  { method: 'GET', path: '/decisions/{id}', roles: readers },
  { method: 'POST', path: '/tasks/{id}/publish', roles: owner },
  { method: 'POST', path: '/tasks/{id}/cleanup', roles: owner, errors: { 409: ['task_active'] } },
  { method: 'GET', path: '/agents', roles: readers },
  { method: 'GET', path: '/agents/{id}', roles: readers },
  { method: 'POST', path: '/agents', roles: owner, responses: { 201: 'unspecified' } },
  { method: 'PATCH', path: '/agents/{id}', roles: owner, errors: { 409: ['version_conflict'] } },
  { method: 'DELETE', path: '/agents/{id}', roles: owner },
  { method: 'GET', path: '/workers', roles: readers },
  { method: 'GET', path: '/workers/{id}', roles: readers },
  { method: 'PATCH', path: '/workers/{id}', roles: owner, errors: { 409: ['version_conflict'] } },
  { method: 'POST', path: '/workers/register', roles: ['worker'], idempotent: true, errors: { 409: ['machine_mismatch', 'machine_conflict', 'queue_isolation_required'] } },
  { method: 'POST', path: '/workers/{id}/heartbeat', roles: ['worker:own_id'], responses: { 200: 'unspecified' }, idempotent: true },
  { method: 'GET', path: '/tokens', roles: owner },
  { method: 'POST', path: '/tokens', roles: owner, errors: { 409: ['token_already_issued'] } },
  { method: 'POST', path: '/tokens/{id}/rotate', roles: owner, responses: { 201: 'unspecified' }, errors: { 409: ['token_already_issued', 'version_conflict'] } },
  { method: 'DELETE', path: '/tokens/{id}', roles: owner, errors: { 409: ['version_conflict'] } },
  { method: 'GET', path: '/notifications', roles: readers },
  { method: 'POST', path: '/notifications/{id}/ack', roles: ['owner', 'relay'] },
  { method: 'POST', path: '/runs/{run_id}/artifacts', roles: workers, request: artifactUploadRequestSchema, idempotent: true },
  { method: 'PUT', path: '/artifacts/{id}/content', roles: workers, request: 'binary', idempotent: true, parameters: [{ name: 'Content-Length', in: 'header', required: true }, { name: 'Content-Range', in: 'header' }], errors: { 413: ['payload_too_large'], 422: ['checksum_mismatch'] } },
  { method: 'HEAD', path: '/artifacts/{id}/content', roles: workers, responses: { 200: 'none' } },
  { method: 'GET', path: '/artifacts/{id}/content', roles: [...readers, ...workers], responses: { 200: 'binary' } },
  { method: 'POST', path: '/runs/{run_id}/proposals', roles: workers, request: childTaskProposalRequestSchema, responses: { 201: 'unspecified' }, errors: { 409: ['depth_exceeded'] } },
  { method: 'POST', path: '/devices', roles: owner, errors: { 409: ['token_already_issued'] } },
  { method: 'POST', path: '/devices/enroll', roles: ['none'], errors: { 401: ['unauthenticated'] } },
  { method: 'GET', path: '/devices', roles: ['owner', 'device'] },
  { method: 'GET', path: '/devices/{id}/sessions', roles: ['owner', 'device'] },
  { method: 'DELETE', path: '/devices/{id}', roles: ['owner', 'device'] },
  { method: 'DELETE', path: '/device-sessions/{id}', roles: ['owner', 'device'] },
  { method: 'GET', path: '/conversations', roles: clientReaders },
  { method: 'GET', path: '/conversations/{id}', roles: clientReaders },
  { method: 'GET', path: '/conversations/{id}/messages', roles: clientReaders },
  { method: 'POST', path: '/conversations/{id}/messages', roles: ['owner', 'device'], errors: { 409: ['request_closed'] } },
  { method: 'POST', path: '/hub/messages', roles: ['hub'], idempotent: true },
  { method: 'POST', path: '/hub/polls', roles: ['hub'], idempotent: true },
  { method: 'POST', path: '/hub/states', roles: ['hub'], idempotent: true },
  { method: 'POST', path: '/conversations/{id}/polls/{poll_id}/answer', roles: ['owner', 'device'], errors: { 409: ['poll_closed'] } },
  { method: 'GET', path: '/conversations/{id}/polls/{poll_id}', roles: clientReaders },
  { method: 'GET', path: '/hub/poll-answers', roles: ['hub'] },
  { method: 'POST', path: '/hub/poll-answers/{id}/result', roles: ['hub'], idempotent: true, errors: { 409: ['request_closed'] } },
  { method: 'POST', path: '/hub/polls/{id}/result', roles: ['hub'], errors: { 409: ['poll_closed'] } },
  { method: 'GET', path: '/hub/polls', roles: ['hub'] },
  { method: 'GET', path: '/events/stream', roles: clientReaders, responses: { 200: 'event-stream' }, errors: { 400: ['bad_cursor'] } },
  // Open shapes: stop-all has no specified request, scope, or result fields.
  { method: 'POST', path: '/system/stop-all', roles: ['owner', 'device'], request: 'none', responses: { 204: 'none' } },
  { method: 'POST', path: '/registry/inquiries', roles: ['registry:own_session_or_run', 'owner'], errors: { 422: ['registry_scope_required'] } },
  { method: 'GET', path: '/registry/inquiries/{id}', roles: [...readers, 'registry:own_session_or_run'] },
  { method: 'POST', path: '/registry/inquiries/{id}/verdicts', roles: ['registry'] },
  { method: 'POST', path: '/registry/gate', roles: ['registry'] },
  { method: 'GET', path: '/registry/search', roles: [...readers, 'registry'], errors: { 400: ['bad_cursor'] } },
  { method: 'GET', path: '/registry/records', roles: readers, errors: { 400: ['bad_cursor'] } },
  { method: 'GET', path: '/registry/records/{id}', roles: readers },
  { method: 'POST', path: '/registry/records', roles: ['owner', 'registry:draft_agent_only'], responses: { 201: 'unspecified' }, errors: { 409: ['permission_by_poll'], 422: ['registry_scope_required', 'evidence_missing'] } },
  { method: 'GET', path: '/registry/drafts', roles: readers, errors: { 400: ['bad_cursor'] } },
  { method: 'POST', path: '/registry/records/{id}/activate', roles: owner, errors: { 409: ['rule_needs_regulation', 'guard_conflict'] } },
  { method: 'POST', path: '/registry/records/{id}/revoke', roles: owner },
  { method: 'POST', path: '/registry/records/{id}/supersede', roles: owner, errors: { 409: ['permission_by_poll'], 422: ['registry_scope_required', 'evidence_missing'] } },
  { method: 'POST', path: '/registry/polls', roles: ['relay'] },
  { method: 'POST', path: '/registry/captures', roles: ['relay'], errors: { 409: ['press_replayed', 'poll_closed'] } },
  { method: 'GET', path: '/regulation/versions', roles: [...readers, 'registry'], errors: { 400: ['bad_cursor'] } },
  { method: 'GET', path: '/regulation/versions/{id}', roles: [...readers, 'registry'] },
  { method: 'POST', path: '/regulation/versions', roles: ['owner', 'registry:draft_only'], responses: { 201: 'unspecified' } },
  { method: 'GET', path: '/regulation/versions/{id}/diff', roles: readers },
  { method: 'POST', path: '/regulation/versions/{id}/activate', roles: owner, errors: { 409: ['confirmation_required', 'guard_conflict', 'regulation_conflict'], 422: ['regulation_too_large'] } },
  { method: 'POST', path: '/regulation/versions/{id}/revoke', roles: owner },
  { method: 'GET', path: '/roles', roles: readers },
  { method: 'GET', path: '/roles/{id}', roles: readers },
  { method: 'GET', path: '/tasks/{id}/participants', roles: readers },
  { method: 'POST', path: '/rights/check', roles: ['registry', 'worker'] },
  { method: 'POST', path: '/rights/requests', roles: ['registry:own_session_or_run', 'worker'] },
  { method: 'GET', path: '/rights/requests', roles: [...readers, 'registry:own_session_or_run'] },
  { method: 'GET', path: '/rights/requests/{id}', roles: [...readers, 'registry:own_session_or_run'] },
  { method: 'POST', path: '/rights/requests/{id}/answer', roles: owner, errors: { 400: ['validation_failed'], 409: ['confirmation_invalid', 'request_not_owner', 'request_closed'] } },
  { method: 'GET', path: '/rights/grants', roles: readers },
  { method: 'POST', path: '/rights/grants/{id}/revoke', roles: owner },
  { method: 'GET', path: '/rights/suspensions', roles: readers },
  { method: 'GET', path: '/rights/suspensions/{id}', roles: readers },
  { method: 'POST', path: '/rights/suspensions/{id}/restore', roles: ['owner:chief_engineer_suspension', 'worker:chief_engineer_run'], errors: { 409: ['request_closed'] } },
  { method: 'GET', path: '/personnel/positions', roles: readers },
  { method: 'GET', path: '/personnel/positions/{id}', roles: readers },
  { method: 'GET', path: '/personnel/profiles', roles: readers },
  { method: 'GET', path: '/personnel/profiles/{agent_id}', roles: readers },
  { method: 'GET', path: '/personnel/assessments', roles: readers },
  { method: 'GET', path: '/personnel/assessments/{id}', roles: readers },
  { method: 'GET', path: '/personnel/incidents', roles: readers },
  { method: 'GET', path: '/personnel/incidents/{id}', roles: readers },
  { method: 'GET', path: '/personnel/measures', roles: readers },
  { method: 'GET', path: '/personnel/measures/{id}', roles: readers },
  { method: 'POST', path: '/personnel/incidents', roles: ['service'], idempotent: true, errors: { 409: ['protected_conduct'], 422: ['measure_invalid'] } },
  { method: 'POST', path: '/personnel/measures', roles: ['service'], errors: { 422: ['measure_invalid'] } },
  { method: 'POST', path: '/personnel/measures/{id}/restore', roles: ['service'], errors: { 422: ['measure_invalid'] } },
  { method: 'POST', path: '/personnel/chief-engineer', roles: owner },
  { method: 'DELETE', path: '/personnel/chief-engineer', roles: owner },
  // Open shapes: replacement procedure field names and storage are not specified.
  { method: 'PUT', path: '/personnel/replacement-procedure', roles: owner, errors: { 409: ['replacement_not_approved'] } },
  { method: 'PUT', path: '/personnel/mode', roles: owner, errors: { 409: ['calibration_missing'] } },
  // Open shapes: robot row and writable columns are unsettled; state has no field list.
  { method: 'GET', path: '/robots', roles: readers },
  { method: 'GET', path: '/robots/{id}', roles: readers },
  { method: 'POST', path: '/robots', roles: owner },
  { method: 'PATCH', path: '/robots/{id}', roles: owner },
  // Open shapes: configuration, assignment and zone table columns are unsettled.
  { method: 'GET', path: '/robots/{id}/configurations', roles: readers },
  { method: 'POST', path: '/robots/{id}/configurations', roles: owner },
  { method: 'GET', path: '/robots/{id}/state', roles: readers },
  { method: 'POST', path: '/robots/{id}/assignments', roles: ['service', 'owner'] },
  { method: 'DELETE', path: '/robots/{id}/assignments/{aid}', roles: ['service', 'owner'], request: 'none' },
  // Open shapes: lease row, signed package and DELETE body are not specified.
  { method: 'GET', path: '/robots/{id}/leases', roles: readers },
  { method: 'POST', path: '/robots/{id}/leases', roles: ['service'], errors: { 409: ['lease_held', 'lease_ending', 'people_may_be_present', 'unattended_policy_missing', 'confirmation_invalid', 'robot_state_unconfirmed'], 422: ['qualification_invalid', 'admission_invalid'] } },
  { method: 'DELETE', path: '/robots/{id}/leases/{number}', roles: ['service', 'owner'] },
  { method: 'GET', path: '/robot-zones', roles: readers },
  { method: 'PATCH', path: '/robot-zones/{id}', roles: owner, errors: { 422: ['owner_only'] } },
  // Open shapes: start press answer and unattended-policy columns are not specified.
  { method: 'POST', path: '/robot-start-confirmations', roles: owner, errors: { 409: ['confirmation_required'] } },
  { method: 'GET', path: '/unattended-policies', roles: readers },
  { method: 'POST', path: '/unattended-policies', roles: ['service'], errors: { 422: ['review_invalid'] } },
  // Open shapes: stop and release request fields and the release answer are not specified.
  { method: 'POST', path: '/robots/{id}/stop', roles: ['owner', 'device', 'service'], responses: { 202: 'unspecified' } },
  { method: 'POST', path: '/robots/{id}/release', roles: ['service', 'owner'], errors: { 409: ['release_requires_check'], 422: ['owner_only'] } },
  // Open shapes: diagnostics and inventory have no table; maintenance columns are unsettled.
  { method: 'GET', path: '/robots/{id}/diagnostics', roles: readers },
  { method: 'POST', path: '/robots/{id}/diagnostics', roles: ['service'] },
  { method: 'POST', path: '/robot-start-presses', roles: owner },
  // Open shapes: skill, qualification, admission, experiment, evidence and stage columns are unsettled.
  { method: 'GET', path: '/robot-skills', roles: readers },
  { method: 'GET', path: '/robot-skills/{id}', roles: readers },
  { method: 'POST', path: '/robot-skills/{id}/qualifications', roles: ['service'], errors: { 422: ['qualification_invalid', 'evidence_missing', 'review_invalid'] } },
  { method: 'POST', path: '/robot-experiments/{id}/admissions', roles: ['service', 'owner'], errors: { 422: ['review_invalid', 'admission_invalid'] } },
  { method: 'GET', path: '/robots/{id}/maintenance', roles: readers },
  { method: 'POST', path: '/robots/{id}/maintenance', roles: ['owner', 'service'] },
  { method: 'GET', path: '/inventory', roles: readers },
  { method: 'GET', path: '/robot-experiments', roles: readers },
  { method: 'GET', path: '/robot-experiments/{id}', roles: readers },
  { method: 'GET', path: '/robot-evidence/{id}', roles: readers },
  { method: 'GET', path: '/robot-stages', roles: readers },
  // Open shapes: robot channel report, command and challenge signed forms and columns are unsettled.
  { method: 'POST', path: '/robots/{id}/reports', roles: ['robot:own_id'], errors: { 409: ['command_stale', 'command_replayed'] } },
  { method: 'GET', path: '/robots/{id}/commands', roles: ['robot:own_id'] },
  { method: 'POST', path: '/robots/{id}/challenges', roles: ['robot:own_id'], errors: { 409: ['heartbeat_stale'] } },
  { method: 'GET', path: '/system/health', roles: ['none'], responses: { 200: z.strictObject({ status: z.string() }) } },
  { method: 'GET', path: '/system/ready', roles: readers },
  { method: 'GET', path: '/system/metrics', roles: readers, responses: { 200: 'text' } },
  { method: 'GET', path: '/system/audit', roles: owner },
  { method: 'GET', path: '/openapi.json', roles: ['none'] },
];

const queryParameters: Readonly<Record<string, readonly string[]>> = {
  '/projects': ['archived', 'q'],
  '/tasks': ['project_id', 'status', 'priority_gte', 'agent_id', 'parent_id', 'created_after', 'created_before', 'updated_after', 'awaiting_approval', 'q', 'origin_type', 'sort', 'direction'],
  '/tasks/{id}/runs': ['status', 'role'], '/tasks/{id}/events': ['type', 'run_id'],
  '/tasks/{id}/artifacts': ['type', 'run_id'], '/agents': ['provider', 'enabled'],
  '/workers': ['status', 'platform'], '/notifications': ['state', 'event_type'],
  '/conversations': ['source', 'project_id', 'task_id', 'archived'],
  '/hub/poll-answers': ['state'], '/hub/polls': ['state'],
  '/registry/search': ['project_id', 'category', 'kind', 'status', 'scope', 'q'],
  '/registry/records': ['project_id', 'category', 'kind', 'status', 'scope', 'q', 'source'],
  '/rights/requests': ['task_id', 'participant', 'state'], '/rights/grants': ['task_id', 'participant', 'state'],
  '/rights/suspensions': ['agent_id', 'state'], '/personnel/profiles': ['provider', 'position_id', 'version_id'],
  '/personnel/assessments': ['agent_id', 'position_id', 'after'],
  '/personnel/incidents': ['agent_id', 'class', 'state'], '/personnel/measures': ['agent_id', 'level', 'state'],
  '/system/audit': ['actor_id', 'action', 'target_id'],
};
const cursorStreams = new Set(['/tasks/{id}/events', '/events/stream', '/conversations/{id}/messages', '/system/audit', '/notifications']);
const secondPress = new Set([
  'PUT /projects/{id}/policy', 'POST /tasks/{id}/publish', 'POST /tasks/{id}/cleanup',
  'POST /devices', 'POST /system/stop-all', 'POST /conversations/{id}/polls/{poll_id}/answer', 'POST /regulation/versions/{id}/activate',
  'POST /regulation/versions/{id}/revoke', 'POST /personnel/chief-engineer',
  'DELETE /personnel/chief-engineer', 'PUT /personnel/replacement-procedure', 'PUT /personnel/mode',
  'POST /robot-start-confirmations', 'POST /robots/{id}/release',
  'PATCH /robot-zones/{id}',
  'POST /tasks/{id}/reject', 'POST /tasks/{id}/cancel', 'POST /tasks/{id}/force-close',
]);
const secondPressCases: Record<string, NonNullable<Route['secondPress']>> = {
  'PUT /projects/{id}/policy': 'policy-loosening',
  'POST /tasks/{id}/cleanup': 'forced-cleanup',
  'POST /conversations/{id}/polls/{poll_id}/answer': 'decision-kind',
  'PATCH /robot-zones/{id}': 'zone-change',
  'POST /robots/{id}/release': 'robot-release',
};
const lists = new Set(['/projects', '/tasks', '/tasks/{id}/revisions', '/tasks/{id}/runs', '/tasks/{id}/events', '/tasks/{id}/artifacts', '/tasks/{id}/reviews', '/tasks/{id}/decisions', '/agents', '/workers', '/tokens', '/notifications', '/devices', '/devices/{id}/sessions', '/conversations', '/conversations/{id}/messages', '/hub/poll-answers', '/hub/polls', '/registry/search', '/registry/records', '/registry/drafts', '/regulation/versions', '/roles', '/tasks/{id}/participants', '/rights/requests', '/rights/grants', '/rights/suspensions', '/personnel/positions', '/personnel/profiles', '/personnel/assessments', '/personnel/incidents', '/personnel/measures', '/robots', '/robots/{id}/configurations', '/robots/{id}/leases', '/robot-zones', '/unattended-policies', '/robot-skills', '/robots/{id}/maintenance', '/inventory', '/robot-experiments', '/robot-stages', '/system/audit']);

type Shape = { request?: Body; requestOptional?: boolean; responses: Route['responses'] };
const shapes: Record<string, Shape> = {};
const shape = (key: string, responses: Route['responses'], request?: Body) => { shapes[key] = { responses, request }; };
const get = (path: string, body: z.ZodType) => shape(`GET ${path}`, {200:body});
const list = (path: string, body: z.ZodType) => get(path, pageSchema(body));
const stream = (path: string, body: z.ZodType) => get(path, streamPageSchema(body));
const action = (method: Method, path: string, status: number, body: z.ZodType, request: Body = 'none') => shape(`${method} ${path}`, {[status]:body}, request);

list('/tasks', R.Task); action('POST','/tasks',201,R.TaskCreated,createTaskRequestSchema);
get('/tasks/{id}',R.TaskDetail); action('DELETE','/tasks/{id}',200,R.Task);
list('/tasks/{id}/revisions',R.TaskRevision); get('/tasks/{id}/revisions/{n}',R.TaskRevision);
action('POST','/tasks/{id}/dependencies',201,R.TaskDependency,Q.DependencyCreate);
action('DELETE','/tasks/{id}/dependencies/{dep}',200,R.TaskDependency);
list('/tasks/{id}/runs',R.TaskRun); stream('/tasks/{id}/events',R.TaskEvent); list('/tasks/{id}/artifacts',R.TaskArtifact);
list('/tasks/{id}/reviews',R.TaskReview); list('/tasks/{id}/decisions',R.TaskDecision); get('/decisions/{id}',R.TaskDecision);
action('POST','/tasks/{id}/publish',202,taskDecisionResponseSchema);
shape('POST /tasks/{id}/cleanup',{200:R.CleanupPlan,202:R.CleanupRecorded},'none');
list('/agents',R.Agent); get('/agents/{id}',R.Agent); action('POST','/agents',201,R.Agent,Q.AgentCreate); action('PATCH','/agents/{id}',200,R.Agent,Q.AgentPatch); action('DELETE','/agents/{id}',200,R.Agent);
list('/workers',R.Worker); get('/workers/{id}',R.Worker); action('PATCH','/workers/{id}',200,R.Worker,Q.WorkerPatch);
action('POST','/workers/register',200,Q.WorkerRegistered,Q.WorkerRegister); action('POST','/workers/{id}/heartbeat',200,Q.HeartbeatAnswer,Q.Heartbeat);
list('/tokens',R.Token); action('POST','/tokens',201,Q.TokenSecret,Q.TokenCreate); action('POST','/tokens/{id}/rotate',201,Q.TokenSecret); action('DELETE','/tokens/{id}',200,R.Token);
stream('/notifications',R.Notification); action('POST','/notifications/{id}/ack',200,R.Notification);
shape('POST /runs/{run_id}/artifacts',{200:R.ArtifactUploadAnswer,201:R.ArtifactUploadAnswer},artifactUploadRequestSchema);
shape('PUT /artifacts/{id}/content',{200:Q.ArtifactContent},'binary'); action('POST','/runs/{run_id}/proposals',201,R.TaskProposal,childTaskProposalRequestSchema);
action('POST','/devices',201,Q.DeviceCode,Q.DeviceCreate); action('POST','/devices/enroll',201,Q.DeviceSessionSecret,Q.Enroll);
list('/devices',R.Device); list('/devices/{id}/sessions',R.DeviceSession); action('DELETE','/devices/{id}',200,R.Device); action('DELETE','/device-sessions/{id}',200,R.DeviceSession);
list('/conversations',R.Conversation); get('/conversations/{id}',R.Conversation); stream('/conversations/{id}/messages',R.Message);
action('POST','/conversations/{id}/messages',201,Q.MessageAnswer,Q.MessageCreate);
for (const [path,body] of [['/hub/messages',R.Message],['/hub/polls',R.Poll],['/hub/states',R.Conversation]] as const) shape(`POST ${path}`,{200:body,201:body},Q.HubItem);
action('POST','/conversations/{id}/polls/{poll_id}/answer',202,Q.PollAnswerResponse,Q.PollAnswer);
get('/conversations/{id}/polls/{poll_id}',R.PollDetail); list('/hub/poll-answers',R.PollAnswerRequest); list('/hub/polls',R.Poll);
action('POST','/hub/poll-answers/{id}/result',200,R.PollAnswerRequest,Q.PollAnswerResult); action('POST','/hub/polls/{id}/result',200,R.Poll,Q.PollResult);
action('POST','/registry/inquiries',201,R.Inquiry,Q.InquiryCreate); get('/registry/inquiries/{id}',R.Inquiry);
action('POST','/registry/inquiries/{id}/verdicts',201,R.InquiryResult,Q.Verdict); action('POST','/registry/gate',200,Q.GateAnswer,Q.Gate);
list('/registry/search',R.SearchHit); list('/registry/records',R.RegistryRecord); get('/registry/records/{id}',R.RegistryRecord); list('/registry/drafts',R.RegistryRecord);
action('POST','/registry/records',201,R.RegistryRecord,Q.RecordCreate);
shapes['POST /registry/records/{id}/activate'] = {responses:{200:z.array(R.RegistryRecord)}, request:Q.Activate, requestOptional:true};
action('POST','/registry/records/{id}/revoke',200,R.RegistryRecord); action('POST','/registry/records/{id}/supersede',201,R.RegistryRecord,Q.RecordCreate);
action('POST','/registry/polls',201,Q.RegistryPollAnswer,Q.RegistryPoll); action('POST','/registry/captures',200,R.RegistryRecord,Q.Capture);
list('/regulation/versions',R.RegulationVersionSummary); get('/regulation/versions/{id}',R.RegulationVersion);
action('POST','/regulation/versions',201,R.RegulationVersion,Q.RegulationCreate); get('/regulation/versions/{id}/diff',R.RegulationDiff);
action('POST','/regulation/versions/{id}/activate',200,R.RegulationVersion); action('POST','/regulation/versions/{id}/revoke',200,R.RegulationVersion);
list('/roles',R.Role); get('/roles/{id}',R.Role); list('/tasks/{id}/participants',R.Participant);
action('POST','/rights/check',200,Q.RightCheckAnswer,Q.RightCheck); shape('POST /rights/requests',{200:Q.RightCheckAnswer,202:Q.RightRequestRecorded},Q.RightRequestCreate);
list('/rights/requests',R.RightRequest); get('/rights/requests/{id}',R.RightRequest); action('POST','/rights/requests/{id}/answer',201,Q.RightAnswerCreated,Q.RightAnswerCreate);
list('/rights/grants',R.RightGrant); action('POST','/rights/grants/{id}/revoke',200,R.RightGrant);
list('/rights/suspensions',R.RightsSuspension); get('/rights/suspensions/{id}',R.RightsSuspension); action('POST','/rights/suspensions/{id}/restore',200,R.RightsSuspension,Q.SuspensionRestore);
for (const [path,body] of [['positions',R.Position],['profiles',R.Profile],['assessments',R.Assessment],['incidents',R.Incident],['measures',R.Measure]] as const) list(`/personnel/${path}`,body);
get('/personnel/positions/{id}',R.Position); get('/personnel/profiles/{agent_id}',R.Profile); get('/personnel/assessments/{id}',R.Assessment); get('/personnel/incidents/{id}',R.Incident); get('/personnel/measures/{id}',R.Measure);
shape('POST /personnel/incidents',{200:R.Incident,201:R.Incident},Q.IncidentCreate); action('POST','/personnel/measures',201,R.Measure,Q.MeasureCreate); action('POST','/personnel/measures/{id}/restore',200,R.Measure);
action('POST','/personnel/chief-engineer',201,R.PositionAssignment,Q.ChiefEngineer); action('DELETE','/personnel/chief-engineer',200,R.PositionAssignment); action('PUT','/personnel/mode',200,Q.Mode,Q.Mode);
get('/system/ready',R.Readiness); stream('/system/audit',R.AuditEntry); get('/openapi.json',z.json());

function toRoute(entry: Input): Route {
  const mapped = shapes[`${entry.method} ${entry.path}`];
  const isRead = entry.method === 'GET' || entry.method === 'HEAD';
  const earlierOwnerRoute = /^\/(projects|tasks|decisions|agents|workers|notifications)(\/|$)/.test(entry.path) && entry.path !== '/tasks/{id}/participants';
  const roles = earlierOwnerRoute && entry.roles.includes('owner') ? [...entry.roles, 'device'] : entry.roles;
  const keyedMutation = !isRead && !entry.path.startsWith('/hub/') && entry.path !== '/devices/enroll' &&
    !(entry.path === '/workers/register' || entry.path === '/workers/{id}/heartbeat' || entry.path === '/runs/{run_id}/artifacts' || (entry.path === '/artifacts/{id}/content' && entry.method === 'PUT'));
  const parameters = [...(entry.parameters ?? [])];
  if (entry.method === 'GET') {
    const names = [...(queryParameters[entry.path] ?? [])];
    if (lists.has(entry.path) || entry.path === '/projects/{id}/routing-rules') names.push('limit', 'cursor', 'include_deleted');
    else if (entry.path === '/events/stream') names.push('cursor');
    for (const name of names) parameters.push({ name, in: 'query', ...((entry.path === '/tasks' && name === 'status') || (entry.path === '/events/stream' && name === 'cursor') ? { repeatable: true } : {}) });
    if (entry.path === '/events/stream') parameters.push({ name: 'Last-Event-ID', in: 'header' });
  }
  if (entry.method === 'POST' && entry.path === '/tasks/{id}/cleanup') parameters.push({name:'dry_run',in:'query'}, {name:'force',in:'query'});
  parameters.push({ name: 'X-Request-Id', in: 'header' });
  if (entry.roles.some((role) => role === 'worker' || role.startsWith('worker:'))) parameters.push({ name: 'X-Factory-Contract', in: 'header', required: true });
  if (entry.method === 'PATCH' && (entry.path === '/projects/{id}' || entry.path === '/agents/{id}')) parameters.push({ name: 'If-Match', in: 'header', required: true });
  if ((entry.method === 'DELETE' && entry.path === '/tasks/{id}') || (entry.method === 'POST' && entry.path === '/projects/{id}/archive')) parameters.push({ name: 'If-Match', in: 'header' });
  if (entry.method === 'PUT' && entry.path === '/projects/{id}/policy') parameters.push({ name: 'If-Match', in: 'header', required: true });
  if (keyedMutation) parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: idempotencyKeySchema });
  const confirms = secondPress.has(`${entry.method} ${entry.path}`);
  if (confirms) parameters.push({ name: 'X-Confirm', in: 'header' });
  const errors: Record<number, readonly string[]> = { 422: ['validation_failed'], 429: ['rate_limited'], 500: ['internal'], 503: ['unavailable'] };
  if (!entry.roles.includes('none')) {
    errors[401] = roles.includes('device') ? ['unauthenticated', 'device_revoked'] : ['unauthenticated'];
    errors[403] = ['forbidden'];
  }
  if (entry.path.includes('{')) errors[404] = ['not_found'];
  for (const [status, codes] of Object.entries(entry.errors ?? {})) {
    const key = Number(status);
    errors[key] = [...new Set([...(errors[key] ?? []), ...codes])];
  }
  if (entry.roles.some((role) => role === 'worker' || role.startsWith('worker:'))) errors[426] = ['contract_unsupported'];
  if (keyedMutation) errors[409] = [...(errors[409] ?? []), 'idempotency_conflict', 'idempotency_in_progress'];
  if (confirms) errors[409] = [...new Set([...(errors[409] ?? []), 'confirmation_required', 'confirmation_invalid'])];
  if (cursorStreams.has(entry.path)) errors[400] = [...(errors[400] ?? []), ...((errors[400] ?? []).includes('bad_cursor') ? [] : ['bad_cursor'])];
  if (entry.method === 'GET' && (lists.has(entry.path) || entry.path === '/projects/{id}/routing-rules') && /^\/(projects|tasks)(\/|$)/.test(entry.path)) errors[400] = ['bad_cursor'];
  return {
    method: entry.method, path: entry.path,
    operationId: `${entry.method.toLowerCase()}_${entry.path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
    roles, request: mapped?.request ?? entry.request ?? (isRead ? 'none' : 'unspecified'), requestOptional: mapped?.requestOptional,
    responses: mapped?.responses ?? entry.responses ?? (isRead ? { 200: 'unspecified' } : { default: 'unspecified' }), errors,
    idempotent: entry.idempotent ?? (isRead || keyedMutation), parameters,
  };
}

export const routes: readonly Route[] = [...decisionRoutes, ...entries.map(toRoute)].map((route) => ({
  ...route,
  ...(secondPress.has(`${route.method} ${route.path}`) ? { secondPress: secondPressCases[`${route.method} ${route.path}`] ?? 'always' } : {}),
  responses: {
    ...route.responses,
    ...Object.fromEntries(Object.entries(route.errors).map(([status, codes]) => {
      const variants: z.ZodType[] = [problemDetailsSchema];
      if (codes.includes('confirmation_required')) variants.push(confirmationRequiredSchema);
      if (codes.includes('guard_conflict')) variants.push(guardConflictSchema);
      if (codes.includes('poll_closed')) variants.push(pollClosedSchema);
      return [status, variants.length > 1 ? z.union([variants[0]!, variants[1]!, ...variants.slice(2)]) : variants[0]!];
    })),
  },
}));
