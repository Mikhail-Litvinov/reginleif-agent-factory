import { createHash, randomUUID } from 'node:crypto';
import type { Repo } from '../../db/repo/index.ts';
import type { HandlerContext } from '../server.ts';
import type { HandlerDeps, HandlerRegistrar } from './shared.ts';
import { apiRow, apiRows, query, response } from './shared.ts';
import { consumeConfirmationAct } from '../second-press.ts';
import { checkForSubject, type Right } from '../../rights/check.ts';
import { answerOwnerRequest, answerState, createRightRequest } from '../../rights/requests.ts';

type Tx = Parameters<Parameters<Repo['transaction']>[0]>[0];

function parseCall(action: string, target: unknown): Right | undefined {
  if (typeof target === 'string') return { action, target, conditions: {} };
  if (!target || typeof target !== 'object' || Array.isArray(target)) return undefined;
  const value = target as Record<string, unknown>;
  if (typeof value.target !== 'string' || !Object.hasOwn(value, 'conditions') || Object.keys(value).some(key => key !== 'target' && key !== 'conditions')) return undefined;
  return { action, target: value.target, conditions: value.conditions };
}

type Subject = { projectId: string | null; taskId: string | null; participant: string | null; agentId: string | null; sessionRef: string | null; runId: string | null };
type Resolved = { subject: Subject } | { status: 403 | 404 };
type SubjectInput = { run_id?: string; session_id?: string; task_id?: string };

// The subject of a check or a request: the run of a task, or an unbound registry session. The registry token must be bound to
// the same run or session; a worker token must own the run.
async function resolveSubject(tx: Tx, context: HandlerContext, input: SubjectInput): Promise<Resolved> {
  const identity = context.identity;
  if (!identity) return { status: 403 };
  const token = await tx.tokens.get(identity.id);
  if (!token) return { status: 403 };
  if (identity.role === 'registry' && (input.run_id ? token.runId !== input.run_id : token.sessionRef !== input.session_id)) return { status: 403 };
  if (input.run_id) {
    const run = await tx.taskReads.getRun(input.run_id);
    if (!run) return { status: 404 };
    if (identity.role === 'worker' && run.workerId !== identity.workerId) return { status: 403 };
    if (input.task_id && input.task_id !== run.taskId) return { status: 403 };
    const task = await tx.tasks.get(run.taskId);
    if (!task) return { status: 404 };
    return { subject: { projectId: task.projectId, taskId: run.taskId, participant: run.participant, agentId: run.agentId, sessionRef: null, runId: run.id } };
  }
  if (identity.role !== 'registry' || !input.session_id || input.task_id) return { status: 403 };
  const conversation = await tx.conversations.bySessionRef(input.session_id);
  const runs = await tx.taskReads.runsForSession(input.session_id);
  const agents = [...new Set(runs.map(run => run.agentId).filter((id): id is string => id !== null))];
  if (agents.length > 1) return { status: 403 };
  return { subject: { projectId: conversation?.projectId ?? null, taskId: null, participant: null, agentId: agents[0] ?? null, sessionRef: input.session_id, runId: null } };
}

const failure = (status: 403 | 404) => response(status, { code: status === 403 ? 'forbidden' : 'not_found' });

// The contract reads answered_by as one uuid; the column keeps {type, id?}. A code answer has no actor, so it reads null.
function answerRow(answer: Record<string, any>) {
  const by = answer.answeredBy as { id?: string } | null | undefined;
  return { ...apiRow(answer), answered_by: by?.id ?? answer.answerRunId ?? null };
}

async function requestRow(tx: Tx, request: Record<string, any>) {
  const answers = await tx.rightAnswers.listForRequest(request.id);
  return { ...apiRow(request), state: answerState(answers), answers: answers.map(answerRow) };
}

// A registry token reads only the requests of its own run or session.
async function ownRequest(tx: Tx, context: HandlerContext, request: { runId: string | null; sessionRef: string | null }): Promise<boolean> {
  if (context.identity?.role !== 'registry') return true;
  const token = await tx.tokens.get(context.identity.id);
  if (!token) return false;
  return Boolean((token.runId && request.runId === token.runId) || (token.sessionRef && request.sessionRef === token.sessionRef));
}

const suspensionRow = (row: Record<string, any>) => {
  const by = row.restoredBy as { id?: string } | null | undefined;
  return { ...apiRow(row), restored_by: by?.id ?? null, state: row.endedAt ? 'restored' : 'open' };
};

class ConfirmationLost extends Error {}

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function registerRightsHandlers(api: HandlerRegistrar, { repo, now = () => new Date() }: HandlerDeps): void {
  api.register('POST', '/rights/check', async context => {
    const input = context.body as SubjectInput & { action: string; target: unknown };
    return repo.transaction(async tx => {
      const resolved = await resolveSubject(tx, context, input);
      if (!('subject' in resolved)) return failure(resolved.status);
      const call = parseCall(input.action, input.target);
      const { runId: _runId, ...subject } = resolved.subject;
      return response(200, await checkForSubject(tx, subject, call, now()));
    });
  });

  api.register('GET', '/roles', async context => {
    const params = query(context);
    const rows = await repo.roles.list({ ...(params.get('name') ? { name: params.get('name')! } : {}), ...(params.get('status') ? { status: params.get('status')! } : {}) });
    return response(200, { items: apiRows(rows), next_cursor: null });
  });

  api.register('GET', '/roles/{id}', async context => {
    const row = await repo.roles.get(context.params.id);
    return row ? response(200, apiRow(row)) : failure(404);
  });

  api.register('GET', '/tasks/{id}/participants', async context => {
    if (!await repo.tasks.get(context.params.id)) return failure(404);
    const rows = await repo.roleAssignments.listForTask(context.params.id, { includeSuperseded: true });
    return response(200, { items: apiRows(rows), next_cursor: null });
  });

  api.register('POST', '/rights/requests', async context => {
    const input = context.body as SubjectInput & { action: string; target: unknown; reason: string; tried: string };
    return repo.transaction(async tx => {
      const resolved = await resolveSubject(tx, context, input);
      if (!('subject' in resolved)) return failure(resolved.status);
      const right = parseCall(input.action, input.target);
      if (!right) return response(400, { code: 'validation_failed' });
      const { runId, ...subject } = resolved.subject;
      const result = await createRightRequest(tx, { subject, runId, right, reason: input.reason, tried: input.tried, now: now() });
      return response(result.status, result.body);
    });
  }, { authorizeScope: async ({ identity }) => identity.role === 'registry' });

  const listRequests = async (context: HandlerContext) => repo.transaction(async tx => {
    const params = query(context);
    const requests = await tx.rightRequests.list({
      ...(params.get('task_id') ? { taskId: params.get('task_id')! } : {}),
      ...(params.get('session_id') ? { sessionRef: params.get('session_id')! } : {}),
      ...(params.get('participant') ? { participant: params.get('participant')! } : {}),
    });
    const items = [];
    for (const request of requests) {
      if (!await ownRequest(tx, context, request)) continue;
      const row = await requestRow(tx, request);
      if (!params.get('state') || row.state === params.get('state')) items.push(row);
    }
    return response(200, { items, next_cursor: null });
  });
  api.register('GET', '/rights/requests', listRequests, { authorizeScope: async ({ identity }) => identity.role === 'registry' });

  api.register('GET', '/rights/requests/{id}', async context => repo.transaction(async tx => {
    const request = await tx.rightRequests.get(context.params.id);
    if (!request) return failure(404);
    // A registry token never learns whether another run's request exists.
    if (!await ownRequest(tx, context, request)) return failure(404);
    return response(200, await requestRow(tx, request));
  }), { authorizeScope: async ({ identity }) => identity.role === 'registry' });

  api.register('POST', '/rights/requests/{id}/answer', async context => {
    const input = context.body as { answer: 'grant' | 'refuse'; owner_act_ref?: string; reason?: string };
    const ownerId = context.identity?.ownerId;
    if (!ownerId) return failure(403);
    try {
      return await repo.transaction(async tx => {
        const request = await tx.rightRequests.get(context.params.id);
        if (!request) return failure(404);
        const at = now();
        let result: Awaited<ReturnType<typeof answerOwnerRequest>>;
        if (input.answer === 'refuse') {
          result = await answerOwnerRequest(tx, { requestId: request.id, ownerId, answer: 'refuse', ...(input.reason !== undefined ? { reason: input.reason } : {}) });
        } else {
          const act = input.owner_act_ref ? await tx.confirmations.get(input.owner_act_ref) : undefined;
          result = await answerOwnerRequest(tx, { requestId: request.id, ownerId, answer: 'grant', ownerActRef: input.owner_act_ref ?? '', channel: act?.channel ?? '', deviceSessionId: act?.deviceSessionId ?? null, now: at, ...(input.reason !== undefined ? { reason: input.reason } : {}) });
          if (!('error' in result)) {
            // The owner act is single use: it is consumed in the transaction that records the grant.
            const used = await consumeConfirmationAct(tx, input.owner_act_ref!, { actorId: ownerId, channel: act!.channel ?? '', deviceSessionId: act!.deviceSessionId ?? null, operation: 'right_request', targetType: 'right_request', targetId: request.id, requestHash: request.requestHash! }, at);
            if (!used) throw new ConfirmationLost();
          }
        }
        if ('error' in result) {
          if (result.error === 'not_found') return failure(404);
          return response(409, { code: result.error });
        }
        await tx.audit.append({ id: randomUUID(), actorId: ownerId, tokenId: context.identity!.id, deviceSessionId: null, requestId: context.requestId, action: `rights.${input.answer}`, targetType: 'right_request', targetId: request.id, outcome: 'ok', requestHash: sha([context.request.method, context.request.url, input]), details: { route: context.route.path, answer_id: result.answer.id } });
        const grant = 'grant' in result && result.grant ? { grant: apiRow(result.grant) } : {};
        return response(201, { ...answerRow(result.answer), ...grant });
      });
    } catch (error) {
      if (error instanceof ConfirmationLost) return response(409, { code: 'confirmation_invalid' });
      throw error;
    }
  });

  api.register('GET', '/rights/grants', async context => {
    const params = query(context);
    const state = params.get('state');
    const rows = await repo.rightGrants.list({
      ...(params.get('task_id') ? { taskId: params.get('task_id')! } : {}),
      ...(params.get('session_id') ? { sessionRef: params.get('session_id')! } : {}),
      ...(params.get('participant') ? { participant: params.get('participant')! } : {}),
      ...(state ? { state: state as 'live' } : {}),
    });
    return response(200, { items: apiRows(rows), next_cursor: null });
  });

  api.register('POST', '/rights/grants/{id}/revoke', async context => {
    const ownerId = context.identity?.ownerId;
    if (!ownerId) return failure(403);
    return repo.transaction(async tx => {
      const grant = await tx.rightGrants.get(context.params.id);
      if (!grant) return failure(404);
      const ended = await tx.rightGrants.end(grant.id, { endedBy: 'revocation', revokedBy: ownerId });
      // A grant that already ended stays as it is: revoking twice is not an error.
      if (!ended) return response(200, apiRow(grant));
      const right = grant.right as { action?: string; target?: string } | null;
      const live = grant.taskId
        ? (await tx.taskReads.runs(grant.taskId)).filter(run => !run.finishedAt && run.participant === grant.participant)
        : grant.sessionRef ? await tx.taskReads.runsForSession(grant.sessionRef) : [];
      const at = now();
      for (const run of live) {
        const held = Array.isArray(run.profileRights) && (run.profileRights as Array<{ action?: string; target?: string }>).some(entry => entry.action === right?.action && entry.target === right?.target);
        if (!held) continue;
        await tx.outbox.create({ id: randomUUID(), kind: 'stop_run', taskId: run.taskId, decisionId: null, payload: { run_id: run.id, reason: 'right_revoked', grant_id: grant.id }, state: 'pending', attempts: 0, nextAttemptAt: at });
      }
      await tx.audit.append({ id: randomUUID(), actorId: ownerId, tokenId: context.identity!.id, deviceSessionId: null, requestId: context.requestId, action: 'rights.revoke', targetType: 'right_grant', targetId: grant.id, outcome: 'ok', requestHash: sha([context.request.method, context.request.url]), details: { route: context.route.path } });
      return response(200, apiRow(ended));
    });
  });

  api.register('GET', '/rights/suspensions', async context => {
    const params = query(context);
    const state = params.get('state');
    const rows = await repo.rightsSuspensions.list({
      ...(params.get('agent_id') ? { agentId: params.get('agent_id')! } : {}),
      ...(state === 'open' || state === 'restored' ? { state } : {}),
    });
    return response(200, { items: rows.map(suspensionRow), next_cursor: null });
  });

  api.register('GET', '/rights/suspensions/{id}', async context => {
    const row = await repo.rightsSuspensions.get(context.params.id);
    return row ? response(200, suspensionRow(row)) : failure(404);
  });

  // The token role is checked by the route table; whether this owner or this run may restore this suspension is decided in the handler.
  api.register('POST', '/rights/suspensions/{id}/restore', async context => {
    const input = context.body as { restore_reason: string };
    const identity = context.identity;
    if (!identity) return failure(403);
    return repo.transaction(async tx => {
      const suspension = await tx.rightsSuspensions.get(context.params.id);
      if (!suspension) return failure(404);
      let restoredBy: { type: 'owner' | 'run'; id: string };
      if (identity.role === 'owner') {
        // The owner restores only a suspended chief engineer; the chief engineer is the agent of a chief_engineer run.
        const run = suspension.runId ? await tx.taskReads.getRun(suspension.runId) : undefined;
        if (!identity.ownerId || run?.role !== 'chief_engineer') return failure(403);
        restoredBy = { type: 'owner', id: identity.ownerId };
      } else if (identity.role === 'worker') {
        const token = await tx.tokens.get(identity.id);
        const run = token?.runId ? await tx.taskReads.getRun(token.runId) : undefined;
        if (!run || run.role !== 'chief_engineer' || run.workerId !== identity.workerId || !run.agentId || run.agentId === suspension.agentId) return failure(403);
        if (await tx.rightsSuspensions.openForAgent(run.agentId)) return failure(403);
        restoredBy = { type: 'run', id: run.id };
      } else return failure(403);
      if (suspension.endedAt) return response(409, { code: 'request_closed' });
      const restoreAuditId = randomUUID();
      await tx.audit.append({ id: restoreAuditId, actorId: identity.ownerId ?? identity.id, tokenId: identity.id, deviceSessionId: null, requestId: context.requestId, action: 'rights.restore', targetType: 'rights_suspension', targetId: suspension.id, outcome: 'ok', requestHash: sha([context.request.method, context.request.url, input]), details: { route: context.route.path, restored_by: restoredBy } });
      const restored = await tx.rightsSuspensions.restore(suspension.id, { restoredBy, restoreReason: input.restore_reason, restoreAuditId });
      if (!restored) return response(409, { code: 'request_closed' });
      return response(200, suspensionRow(restored));
    });
  }, { authorizeScope: async ({ identity, scope }) => (scope === 'chief_engineer_suspension' ? identity.role === 'owner' : identity.role === 'worker') });
}
