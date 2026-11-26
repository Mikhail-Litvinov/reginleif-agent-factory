import { z } from 'zod';
import { artifactUploadRequestSchema, childTaskProposalRequestSchema, createTaskRequestSchema, decisionRequestSchemas, problemDetailsSchema, taskDecisionResponseSchema } from './schemas/index.ts';

/** The API document leaves some body shapes open for their handler packages. */
export type Body = z.ZodType | 'unspecified' | 'none' | 'binary' | 'text' | 'event-stream';

export const confirmationRequiredSchema = problemDetailsSchema.extend({
  code: z.literal('confirmation_required'), confirmation_id: z.string().uuid(),
  nonce: z.string(), expires_at: z.string(),
});

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  path: string;
  operationId: string;
  roles: readonly string[];
  request: Body;
  responses: Readonly<Record<string, Body>>;
  errors: Readonly<Record<number, readonly string[]>>;
  idempotent: boolean;
  parameters: readonly { name: string; in: 'query' | 'header'; required?: boolean; repeatable?: boolean; schema?: z.ZodType }[];
}

// api.md, Idempotency: 8–128 ASCII letters, digits, underscores or hyphens.
const idempotencyKeySchema = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/);
// Enrollment: api.md gives 401 unauthenticated for an invalid enrollment code;
// its Errors table names the specific code device_code_invalid for that condition.
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
    const options = schema.options.slice(0, 2).map((option) => {
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
const workers = ['worker:own_runs'] as const;
const projectFields = {
  name: z.string(), description: z.string(), repository_url: z.string(), default_branch: z.string(),
  workspace_policy: z.json(), settings: z.json(), priority: z.number(),
};
const entries: Input[] = [
  { method: 'GET', path: '/projects', roles: readers },
  { method: 'POST', path: '/projects', roles: owner, request: z.strictObject(projectFields), responses: { 201: 'unspecified' } },
  { method: 'GET', path: '/projects/{id}', roles: readers },
  { method: 'PATCH', path: '/projects/{id}', roles: owner, request: z.strictObject(projectFields).partial(), errors: { 409: ['version_conflict'] } },
  { method: 'POST', path: '/projects/{id}/archive', roles: owner, responses: { 200: 'unspecified' }, errors: { 409: ['project_active'] } },
  { method: 'GET', path: '/projects/{id}/policy', roles: readers },
  { method: 'PUT', path: '/projects/{id}/policy', roles: owner, errors: { 409: ['confirmation_required'] } },
  { method: 'GET', path: '/projects/{id}/routing-rules', roles: readers },
  { method: 'POST', path: '/projects/{id}/routing-rules', roles: owner, request: z.strictObject({ match: z.json(), preferred_agent_ids: z.array(z.string().uuid()), position: z.number().int() }) },
  { method: 'DELETE', path: '/projects/{id}/routing-rules/{rule}', roles: owner },
  { method: 'GET', path: '/tasks', roles: readers },
  { method: 'POST', path: '/tasks', roles: owner, request: createTaskRequestSchema, responses: { 201: 'unspecified' } },
  { method: 'GET', path: '/tasks/{id}', roles: readers },
  { method: 'DELETE', path: '/tasks/{id}', roles: owner, errors: { 409: ['task_active'] } },
  { method: 'GET', path: '/tasks/{id}/revisions', roles: readers },
  { method: 'GET', path: '/tasks/{id}/revisions/{n}', roles: readers },
  { method: 'POST', path: '/tasks/{id}/dependencies', roles: owner, request: z.strictObject({ depends_on_task_id: z.string().uuid(), dependency_type: z.string() }), responses: { 201: 'unspecified' }, errors: { 409: ['dependency_cycle'] } },
  { method: 'DELETE', path: '/tasks/{id}/dependencies/{dep}', roles: owner },
  { method: 'GET', path: '/tasks/{id}/runs', roles: readers },
  { method: 'GET', path: '/tasks/{id}/events', roles: readers },
  { method: 'GET', path: '/tasks/{id}/artifacts', roles: [...readers, 'worker:own_runs'] },
  { method: 'GET', path: '/tasks/{id}/reviews', roles: readers },
  { method: 'GET', path: '/tasks/{id}/decisions', roles: readers },
  { method: 'GET', path: '/decisions/{id}', roles: readers },
  { method: 'POST', path: '/tasks/{id}/publish', roles: owner },
  { method: 'POST', path: '/tasks/{id}/cleanup', roles: owner, request: z.strictObject({ dry_run: z.boolean().default(true), force: z.boolean().optional() }), responses: { 200: 'unspecified', 202: 'unspecified' }, errors: { 409: ['task_active'] } },
  { method: 'GET', path: '/agents', roles: readers },
  { method: 'GET', path: '/agents/{id}', roles: readers },
  { method: 'POST', path: '/agents', roles: owner, responses: { 201: 'unspecified' } },
  { method: 'PATCH', path: '/agents/{id}', roles: owner, errors: { 409: ['version_conflict'] } },
  { method: 'DELETE', path: '/agents/{id}', roles: owner },
  { method: 'GET', path: '/workers', roles: readers },
  { method: 'GET', path: '/workers/{id}', roles: readers },
  { method: 'PATCH', path: '/workers/{id}', roles: owner, request: z.strictObject({ status: z.enum(['disabled', 'online']).optional(), concurrency_limit: z.number().int().optional() }) },
  { method: 'POST', path: '/workers/register', roles: ['worker'], request: z.strictObject({ machine_id: z.string(), name: z.string(), platform: z.string(), capabilities: z.json(), version: z.string(), contract_version: z.number().int() }), responses: { 200: 'unspecified' }, idempotent: true, errors: { 409: ['queue_isolation_required'] } },
  { method: 'POST', path: '/workers/{id}/heartbeat', roles: ['worker:own_id'], responses: { 200: 'unspecified' }, idempotent: true },
  { method: 'GET', path: '/tokens', roles: owner },
  { method: 'POST', path: '/tokens', roles: owner, request: z.strictObject({ name: z.string(), role: z.string(), worker_id: z.string().uuid().nullable(), expires_at: z.string().nullable() }), responses: { 201: 'unspecified' } },
  { method: 'POST', path: '/tokens/{id}/rotate', roles: owner, responses: { 201: 'unspecified' } },
  { method: 'DELETE', path: '/tokens/{id}', roles: owner },
  { method: 'GET', path: '/notifications', roles: readers },
  { method: 'POST', path: '/notifications/{id}/ack', roles: ['owner', 'relay'] },
  { method: 'POST', path: '/runs/{run_id}/artifacts', roles: workers, request: artifactUploadRequestSchema, idempotent: true },
  { method: 'PUT', path: '/artifacts/{id}/content', roles: workers, request: 'binary', idempotent: true, parameters: [{ name: 'Content-Length', in: 'header', required: true }, { name: 'Content-Range', in: 'header' }], errors: { 413: ['payload_too_large'], 422: ['checksum_mismatch'] } },
  { method: 'HEAD', path: '/artifacts/{id}/content', roles: workers, responses: { 200: 'none' } },
  { method: 'GET', path: '/artifacts/{id}/content', roles: [...readers, ...workers], responses: { 200: 'binary' } },
  { method: 'POST', path: '/runs/{run_id}/proposals', roles: workers, request: childTaskProposalRequestSchema, responses: { 201: 'unspecified' }, errors: { 409: ['depth_exceeded'] } },
  { method: 'POST', path: '/devices', roles: owner, request: z.strictObject({ name: z.string(), platform: z.enum(['android', 'windows']) }), responses: { 201: 'unspecified' } },
  { method: 'POST', path: '/devices/enroll', roles: ['none'], request: z.strictObject({ code: z.string(), name: z.string() }), responses: { 201: 'unspecified' }, errors: { 401: ['device_code_invalid'] } },
  { method: 'GET', path: '/devices', roles: ['owner', 'device'] },
  { method: 'GET', path: '/devices/{id}/sessions', roles: ['owner', 'device'] },
  { method: 'DELETE', path: '/devices/{id}', roles: ['owner', 'device'] },
  { method: 'DELETE', path: '/device-sessions/{id}', roles: ['owner', 'device'] },
  { method: 'GET', path: '/conversations', roles: [...readers, 'device'] },
  { method: 'GET', path: '/conversations/{id}', roles: [...readers, 'device'] },
  { method: 'GET', path: '/conversations/{id}/messages', roles: [...readers, 'device'] },
  { method: 'POST', path: '/conversations/{id}/messages', roles: ['owner', 'device'], request: z.strictObject({ text: z.string(), attachment_ids: z.array(z.string().uuid()) }) },
  { method: 'POST', path: '/hub/messages', roles: ['hub'], idempotent: true },
  { method: 'POST', path: '/hub/polls', roles: ['hub'], idempotent: true },
  { method: 'POST', path: '/hub/states', roles: ['hub'], idempotent: true },
  { method: 'POST', path: '/conversations/{id}/polls/{poll_id}/answer', roles: ['owner', 'device'], request: z.strictObject({ answer_key: z.string() }), responses: { 202: 'unspecified' }, errors: { 409: ['poll_closed'] } },
  { method: 'GET', path: '/conversations/{id}/polls/{poll_id}', roles: [...readers, 'device'] },
  { method: 'GET', path: '/hub/poll-answers', roles: ['hub'] },
  { method: 'POST', path: '/hub/poll-answers/{id}/result', roles: ['hub'], request: z.union([z.strictObject({ state: z.literal('accepted'), refusal_reason: z.string().optional(), hub_ref: z.string() }), z.strictObject({ state: z.literal('refused'), refusal_reason: z.string(), hub_ref: z.string() })]), idempotent: true, errors: { 409: ['request_closed'] } },
  { method: 'POST', path: '/hub/polls/{id}/result', roles: ['hub'], request: z.strictObject({ answer_key: z.string(), answered_via: z.literal('telegram') }), errors: { 409: ['poll_closed'] } },
  { method: 'GET', path: '/hub/polls', roles: ['hub'] },
  { method: 'GET', path: '/events/stream', roles: [...readers, 'device'], responses: { 200: 'event-stream' }, errors: { 400: ['bad_cursor'] } },
  { method: 'POST', path: '/system/stop-all', roles: ['owner', 'device'] },
  { method: 'POST', path: '/registry/inquiries', roles: ['registry:own_session_or_run', 'owner'], request: z.strictObject({ problem: z.string(), category: z.string(), project_id: z.string().uuid().nullable(), action: z.string(), target: z.json(), reuse_intent: z.enum(['standing', 'once']).optional() }), responses: { 201: 'unspecified' } },
  { method: 'GET', path: '/registry/inquiries/{id}', roles: [...readers, 'registry:own_session_or_run'] },
  { method: 'POST', path: '/registry/inquiries/{id}/verdicts', roles: ['registry'], request: z.union([z.strictObject({ record_id: z.string().uuid(), verdict: z.literal('applies'), difference: z.string().optional(), conflicts_with: z.string().uuid().optional() }), z.strictObject({ record_id: z.string().uuid(), verdict: z.enum(['not_applicable', 'outdated']), difference: z.string(), conflicts_with: z.string().uuid().optional() }), z.strictObject({ record_id: z.string().uuid(), verdict: z.literal('conflict'), difference: z.string(), conflicts_with: z.string().uuid() })]), responses: { 201: 'unspecified' } },
  { method: 'POST', path: '/registry/gate', roles: ['registry'], responses: { 200: z.union([z.strictObject({ pass: z.literal(true) }), z.strictObject({ pass: z.literal(false), records: z.array(z.json()) })]) } },
  { method: 'GET', path: '/registry/search', roles: [...readers, 'registry'] },
  { method: 'GET', path: '/registry/records', roles: readers },
  { method: 'GET', path: '/registry/records/{id}', roles: readers },
  { method: 'POST', path: '/registry/records', roles: ['owner', 'registry:draft_agent_only'], responses: { 201: 'unspecified' } },
  { method: 'GET', path: '/registry/drafts', roles: readers },
  { method: 'POST', path: '/registry/records/{id}/activate', roles: owner, errors: { 409: ['rule_needs_regulation', 'guard_conflict'] } },
  { method: 'POST', path: '/registry/records/{id}/revoke', roles: owner },
  { method: 'POST', path: '/registry/records/{id}/supersede', roles: owner },
  { method: 'POST', path: '/registry/polls', roles: ['relay'], request: z.strictObject({ inquiry_id: z.string().uuid(), question: z.string(), options: z.array(z.json()) }), responses: { 201: 'unspecified' } },
  { method: 'POST', path: '/registry/captures', roles: ['relay'], request: z.strictObject({ press_id: z.string(), telegram_user_id: z.number().int(), poll_id: z.string().uuid(), option_index: z.number().int() }), errors: { 409: ['press_replayed'] } },
  { method: 'GET', path: '/regulation/versions', roles: [...readers, 'registry'] },
  { method: 'GET', path: '/regulation/versions/{id}', roles: [...readers, 'registry'] },
  { method: 'POST', path: '/regulation/versions', roles: ['owner', 'registry:draft_only'], responses: { 201: 'unspecified' } },
  { method: 'GET', path: '/regulation/versions/{id}/diff', roles: readers },
  { method: 'POST', path: '/regulation/versions/{id}/activate', roles: owner, errors: { 409: ['confirmation_required', 'guard_conflict', 'regulation_conflict'], 422: ['regulation_too_large'] } },
  { method: 'POST', path: '/regulation/versions/{id}/revoke', roles: owner },
  { method: 'GET', path: '/roles', roles: readers },
  { method: 'GET', path: '/roles/{id}', roles: readers },
  { method: 'GET', path: '/tasks/{id}/participants', roles: readers },
  { method: 'POST', path: '/rights/check', roles: ['registry', 'worker'], request: z.union([z.strictObject({ action: z.string(), target: z.json(), run_id: z.string().uuid(), task_id: z.string().uuid() }), z.strictObject({ action: z.string(), target: z.json(), session_id: z.string().uuid(), task_id: z.string().uuid() })]), responses: { 200: z.object({ allowed: z.boolean(), source: z.enum(['role', 'record', 'grant', 'refused', 'none']) }).passthrough() } },
  { method: 'POST', path: '/rights/requests', roles: ['registry:own_session_or_run', 'worker'], request: z.union([z.strictObject({ run_id: z.string().uuid(), action: z.string(), target: z.json(), reason: z.string(), tried: z.json() }), z.strictObject({ session_id: z.string().uuid(), action: z.string(), target: z.json(), reason: z.string(), tried: z.json() })]), responses: { 200: 'unspecified', 202: 'unspecified' } },
  { method: 'GET', path: '/rights/requests', roles: [...readers, 'registry:own_session_or_run'] },
  { method: 'GET', path: '/rights/requests/{id}', roles: [...readers, 'registry:own_session_or_run'] },
  { method: 'POST', path: '/rights/requests/{id}/answer', roles: owner, errors: { 400: ['validation_failed'], 409: ['confirmation_invalid', 'request_not_owner', 'request_closed'] } },
  { method: 'GET', path: '/rights/grants', roles: readers },
  { method: 'POST', path: '/rights/grants/{id}/revoke', roles: owner },
  { method: 'GET', path: '/rights/suspensions', roles: readers },
  { method: 'GET', path: '/rights/suspensions/{id}', roles: readers },
  { method: 'POST', path: '/rights/suspensions/{id}/restore', roles: ['owner:chief_engineer_suspension', 'worker:chief_engineer_run'], request: z.strictObject({ restore_reason: z.string() }), errors: { 409: ['request_closed'] } },
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
  { method: 'POST', path: '/personnel/chief-engineer', roles: owner, request: z.strictObject({ agent_id: z.string().uuid() }) },
  { method: 'DELETE', path: '/personnel/chief-engineer', roles: owner },
  { method: 'PUT', path: '/personnel/replacement-procedure', roles: owner, errors: { 409: ['replacement_not_approved'] } },
  { method: 'PUT', path: '/personnel/mode', roles: owner, request: z.strictObject({ mode: z.enum(['observe', 'enforce']) }), errors: { 409: ['calibration_missing'] } },
  { method: 'GET', path: '/robots', roles: readers },
  { method: 'GET', path: '/robots/{id}', roles: readers },
  { method: 'POST', path: '/robots', roles: owner },
  { method: 'PATCH', path: '/robots/{id}', roles: owner },
  { method: 'GET', path: '/robots/{id}/configurations', roles: readers },
  { method: 'POST', path: '/robots/{id}/configurations', roles: owner },
  { method: 'GET', path: '/robots/{id}/state', roles: readers },
  { method: 'POST', path: '/robots/{id}/assignments', roles: ['service', 'owner'] },
  { method: 'DELETE', path: '/robots/{id}/assignments/{aid}', roles: ['service', 'owner'] },
  { method: 'GET', path: '/robots/{id}/leases', roles: readers },
  { method: 'POST', path: '/robots/{id}/leases', roles: ['service'], errors: { 409: ['lease_held', 'lease_ending', 'people_may_be_present', 'unattended_policy_missing', 'confirmation_invalid', 'robot_state_unconfirmed'], 422: ['qualification_invalid', 'admission_invalid'] } },
  { method: 'DELETE', path: '/robots/{id}/leases/{number}', roles: ['service', 'owner'] },
  { method: 'GET', path: '/robot-zones', roles: readers },
  { method: 'PATCH', path: '/robot-zones/{id}', roles: owner, errors: { 422: ['owner_only'] } },
  { method: 'POST', path: '/robot-start-confirmations', roles: owner, errors: { 409: ['confirmation_required'] } },
  { method: 'GET', path: '/unattended-policies', roles: readers },
  { method: 'POST', path: '/unattended-policies', roles: ['service'], errors: { 422: ['review_invalid'] } },
  { method: 'POST', path: '/robots/{id}/stop', roles: ['owner', 'device', 'service'], responses: { 202: 'unspecified' } },
  { method: 'POST', path: '/robots/{id}/release', roles: ['service', 'owner'], errors: { 409: ['release_requires_check'], 422: ['owner_only'] } },
  { method: 'GET', path: '/robots/{id}/diagnostics', roles: readers },
  { method: 'POST', path: '/robots/{id}/diagnostics', roles: ['service'] },
  { method: 'POST', path: '/robot-start-presses', roles: owner },
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
  '/tasks': ['project_id', 'status', 'priority_gte', 'agent_id', 'parent_id', 'created_after', 'created_before', 'updated_after', 'awaiting_approval', 'q', 'origin_type'],
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
  'POST /devices', 'POST /system/stop-all', 'POST /regulation/versions/{id}/activate',
  'POST /regulation/versions/{id}/revoke', 'POST /personnel/chief-engineer',
  'DELETE /personnel/chief-engineer', 'PUT /personnel/replacement-procedure', 'PUT /personnel/mode',
  'POST /robot-start-confirmations', 'POST /robots/{id}/release',
]);
const lists = new Set(['/projects', '/tasks', '/tasks/{id}/revisions', '/tasks/{id}/runs', '/tasks/{id}/events', '/tasks/{id}/artifacts', '/tasks/{id}/reviews', '/tasks/{id}/decisions', '/agents', '/workers', '/tokens', '/notifications', '/devices', '/devices/{id}/sessions', '/conversations', '/conversations/{id}/messages', '/hub/poll-answers', '/hub/polls', '/registry/search', '/registry/records', '/registry/drafts', '/regulation/versions', '/roles', '/tasks/{id}/participants', '/rights/requests', '/rights/grants', '/rights/suspensions', '/personnel/positions', '/personnel/profiles', '/personnel/assessments', '/personnel/incidents', '/personnel/measures', '/robots', '/robots/{id}/configurations', '/robots/{id}/leases', '/robot-zones', '/unattended-policies', '/robot-skills', '/robots/{id}/maintenance', '/inventory', '/robot-experiments', '/robot-stages', '/system/audit']);

function toRoute(entry: Input): Route {
  const isRead = entry.method === 'GET' || entry.method === 'HEAD';
  const earlierOwnerRoute = /^\/(projects|tasks|decisions|agents|workers|notifications)(\/|$)/.test(entry.path) && entry.path !== '/tasks/{id}/participants';
  const roles = earlierOwnerRoute && entry.roles.includes('owner') ? [...entry.roles, 'device'] : entry.roles;
  const keyedMutation = !isRead && !(entry.path === '/workers/register' || entry.path === '/workers/{id}/heartbeat' || entry.path === '/runs/{run_id}/artifacts' || (entry.path === '/artifacts/{id}/content' && entry.method === 'PUT'));
  const parameters = [...(entry.parameters ?? [])];
  if (entry.method === 'GET') {
    const names = [...(queryParameters[entry.path] ?? [])];
    if (lists.has(entry.path)) names.push('limit', 'cursor', 'include_deleted');
    else if (entry.path === '/events/stream') names.push('cursor');
    for (const name of names) parameters.push({ name, in: 'query', ...((entry.path === '/tasks' && name === 'status') || (entry.path === '/events/stream' && name === 'cursor') ? { repeatable: true } : {}) });
    if (entry.path === '/events/stream') parameters.push({ name: 'Last-Event-ID', in: 'header' });
  }
  parameters.push({ name: 'X-Request-Id', in: 'header' });
  if (entry.roles.some((role) => role === 'worker' || role.startsWith('worker:'))) parameters.push({ name: 'X-Factory-Contract', in: 'header', required: true });
  if (entry.method === 'PATCH' && (entry.path === '/projects/{id}' || entry.path === '/agents/{id}')) parameters.push({ name: 'If-Match', in: 'header', required: true });
  if (keyedMutation) parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: idempotencyKeySchema });
  const confirms = secondPress.has(`${entry.method} ${entry.path}`);
  if (confirms) parameters.push({ name: 'X-Confirm', in: 'header' });
  const errors: Record<number, readonly string[]> = { 422: ['validation_failed'], 429: ['rate_limited'], 500: ['internal'], 503: ['unavailable'] };
  if (!entry.roles.includes('none')) {
    errors[401] = ['unauthenticated'];
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
  return {
    method: entry.method, path: entry.path,
    operationId: `${entry.method.toLowerCase()}_${entry.path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
    roles, request: entry.request ?? (isRead ? 'none' : 'unspecified'),
    responses: entry.responses ?? (isRead ? { 200: 'unspecified' } : { default: 'unspecified' }), errors,
    idempotent: entry.idempotent ?? (isRead || keyedMutation), parameters,
  };
}

export const routes: readonly Route[] = [...decisionRoutes, ...entries.map(toRoute)].map((route) => ({
  ...route,
  responses: {
    ...route.responses,
    ...Object.fromEntries(Object.entries(route.errors).map(([status, codes]) => [status,
      codes.includes('confirmation_required') ? z.union([problemDetailsSchema, confirmationRequiredSchema]) : problemDetailsSchema,
    ])),
  },
}));
