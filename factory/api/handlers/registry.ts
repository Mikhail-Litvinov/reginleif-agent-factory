import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Repo } from '../../db/repo/index.ts';
import { RegistryRefusedError } from '../../db/repo/registry.ts';
import { ConfirmationSettingError } from '../second-press.ts';
import { createRegistryGate } from '../../registry/gate.ts';
import { createRegistrySearch, type Embedder } from '../../registry/search.ts';
import { createRegistryService, RegistryConflictError } from '../../registry/service.ts';
import type { HandlerContext } from '../server.ts';
import { apiRow, apiRows, id, query, response, writeAudit, type HandlerDeps, type HandlerRegistrar, type Row } from './shared.ts';
import { pageLimits } from './settings.ts';

type Search = ReturnType<typeof createRegistrySearch>;
type Service = ReturnType<typeof createRegistryService>;
type Options = Omit<HandlerDeps, 'repo'> & { search?: Search; embed?: Embedder; service?: Service };
type Identity = NonNullable<HandlerContext['identity']> & { sessionRef?: string | null };
const uuid = z.uuid();
const statuses = z.enum(['draft', 'active', 'superseded', 'revoked', 'rejected']);
const querySchema = z.object({
  project_id: uuid.optional(), category: z.string().optional(), kind: z.string().optional(), status: statuses.optional(),
  scope: z.enum(['global', 'project']).optional(), q: z.string().optional(), source: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(), cursor: z.string().optional(),
}).strict();

const refusedStatus: Record<string, number> = {
  forbidden: 403, not_found: 404, press_replayed: 409, poll_closed: 409, rule_needs_regulation: 409,
  guard_conflict: 409, regulation_conflict: 409, confirmation_required: 409, confirmation_invalid: 409,
  permission_by_poll: 409, evidence_missing: 422, registry_scope_required: 422, validation_failed: 422,
  regulation_too_large: 422, unavailable: 503,
};
const fail = (code: string, status: number, extra: Row = {}) => response(status, { code, ...extra });
const actor = (context: HandlerContext) => {
  const identity = context.identity;
  if (!identity) throw new RegistryRefusedError('forbidden');
  if (identity.role === 'owner') return { type: 'owner' as const, id: identity.ownerId ?? identity.id };
  if (identity.role === 'registry') {
    const scoped = identity as Identity;
    return { type: 'agent' as const, id: identity.id, tokenId: identity.id, runId: identity.runId ?? undefined, sessionRef: scoped.sessionRef ?? undefined };
  }
  if (identity.role === 'relay') return { type: 'relay' as const };
  throw new RegistryRefusedError('forbidden');
};
const present = (value: unknown) => {
  if (typeof value !== 'string') throw new RegistryRefusedError('validation_failed');
  const parsed = uuid.safeParse(value);
  if (!parsed.success) throw new RegistryRefusedError('validation_failed');
  return parsed.data.toLowerCase();
};
const actorWire = (value: unknown) => {
  if (value == null || typeof value === 'string') return value;
  if (typeof value === 'object' && typeof Reflect.get(value, 'id') === 'string') return Reflect.get(value, 'id') as string;
  return JSON.stringify(value);
};
const recordKey = (value: unknown) => {
  if (typeof value === 'string' && /^DEC-\d{5,}$/i.test(value)) return value;
  return present(value);
};
const selected = (row: Row, links: unknown[] = [], history: unknown[] = []) => ({
  ...apiRow(row), created_by: actorWire(row.createdBy), status_changed_by: actorWire(row.statusChangedBy),
  links: apiRows(links as Row[]).map(link => ({ ...link, created_by: actorWire(link.created_by) })),
  history: apiRows(history as Row[]),
});
const regulationWire = (row: Row) => ({ ...apiRow(row), proposed_by: actorWire(row.proposedBy) });
const cursorScope = (context: HandlerContext) => {
  const params = new URL(context.request.url ?? '/', 'http://localhost').searchParams;
  params.delete('limit');
  params.delete('cursor');
  params.sort();
  return createHash('sha256').update([context.route.path, context.identity?.id ?? 'public', params.toString()].join('\0')).digest('base64url');
};
const cursorOffset = (cursor: string | undefined, scope: string) => {
  if (cursor === undefined) return 0;
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const [foundScope, offset] = JSON.parse(bytes.toString('utf8')) as [unknown, unknown];
    if (foundScope !== scope || !Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error();
    return offset as number;
  } catch { throw Object.assign(new Error('bad_cursor'), { code: 'bad_cursor' }); }
};
const nextCursor = (offset: number, count: number, limit: number, scope: string) => count > offset + limit
  ? Buffer.from(JSON.stringify([scope, offset + limit])).toString('base64url') : null;

function queryInput(context: HandlerContext) {
  const params = new URL(context.request.url ?? '/', 'http://localhost').searchParams;
  const values: Record<string, string> = Object.create(null);
  for (const key of new Set(params.keys())) {
    if (!context.route.parameters.some(parameter => parameter.in === 'query' && parameter.name === key)) throw new RegistryRefusedError('validation_failed');
    if (params.getAll(key).length !== 1) throw new RegistryRefusedError('validation_failed');
    values[key] = params.get(key)!;
  }
  const parsed = querySchema.safeParse(values);
  if (!parsed.success) throw new RegistryRefusedError('validation_failed');
  return parsed.data;
}

export function registerRegistryHandlers(api: HandlerRegistrar, repo: Repo, { now = () => new Date(), embed = () => undefined, search: injectedSearch, service: injectedService }: Options = {}): void {
  const search = injectedSearch ?? createRegistrySearch(repo, embed);
  const service = injectedService ?? createRegistryService(repo, async (input, registry) => {
    const result = await search({ query: input.problem ?? '', ...(input.projectId ? { projectId: input.projectId } : {}), category: input.category ?? undefined });
    return result.items.map(hit => ({ id: id(), recordId: hit.record.id, recordVersion: hit.record.version ?? 1, foundBy: 'inquiry', ranking: hit.ranking, score: String(hit.score), matchedFields: hit.matchedFields }));
  });

  const guarded = (method: Parameters<HandlerRegistrar['register']>[0], path: string, handler: (context: HandlerContext) => Promise<ReturnType<typeof response> | { status: number; body?: unknown; headers?: Record<string, string> }>) => {
    api.register(method, path, async context => {
      try {
        const enabled = (await repo.settings.snapshot(['registry.enabled']))['registry.enabled'];
        if (enabled !== true) return fail('unavailable', 503);
        return await handler(context);
      } catch (error) {
        if (error instanceof RegistryRefusedError) {
          const status = refusedStatus[error.reason];
          if (status) return fail(error.reason, status, error instanceof RegistryConflictError ? { conflicts_with: error.conflictsWith }
            : error.reason === 'poll_closed' ? { answered_via: null, answered_at: null } : {});
        }
        if (error instanceof ConfirmationSettingError) return fail('unavailable', 503);
        if (error && typeof error === 'object' && Reflect.get(error, 'code') === 'bad_cursor') return fail('bad_cursor', 400);
        throw error;
      }
    }, { authorizeScope: async ({ identity, params, body, scope }) => {
      if (identity.role !== 'registry') return false;
      const token = await repo.tokens.get(identity.id);
      if (!token || token.role !== 'registry') return false;
      if (scope === 'draft_agent_only' || scope === 'draft_only') return Boolean(token.runId || token.sessionRef);
      if (scope !== 'own_session_or_run') return false;
      if (path === '/registry/inquiries/{id}' || path === '/rights/requests/{id}') {
        const inquiry = await repo.registry.inquiries.get(params.id!);
        return Boolean(inquiry && ((token.runId != null && inquiry.runId === token.runId) || (token.sessionRef != null && inquiry.sessionRef === token.sessionRef)));
      }
      if (path === '/rights/requests' && method === 'GET') return true;
      return Boolean(token.runId || token.sessionRef);
    } });
  };
  const list = async <T extends Row>(rows: T[], context: HandlerContext, convert: (row: T) => unknown) => {
    const params = queryInput(context);
    const limits = await pageLimits(repo);
    const limit = params.limit ?? limits.defaultLimit;
    if (limit > limits.maxLimit) throw new RegistryRefusedError('validation_failed');
    const scope = cursorScope(context);
    const offset = cursorOffset(params.cursor, scope);
    const items = rows.slice(offset, offset + limit);
    return response(200, { items: items.map(convert), next_cursor: nextCursor(offset, rows.length, limit, scope) });
  };
  const searchLimit = async (context: HandlerContext, params: z.output<typeof querySchema>) => {
    const limits = await pageLimits(repo);
    const limit = params.limit ?? limits.defaultLimit;
    const offset = cursorOffset(params.cursor, cursorScope(context));
    if (limit > limits.maxLimit || !Number.isSafeInteger(limit + offset + 1)) throw new RegistryRefusedError('validation_failed');
    return limit + offset + 1;
  };
  const record = async (idOrNumber: string) => {
    const number = /^DEC-(\d{5,})$/i.exec(idOrNumber);
    const row = number ? await repo.registry.records.byNumber(BigInt(number[1]!)) : await repo.registry.records.get(idOrNumber);
    if (!row) throw new RegistryRefusedError('not_found');
    const [links, history] = await Promise.all([repo.registry.links.forRecord(row.id), repo.registry.records.history(row.id)]);
    return selected(row, links, history);
  };

  guarded('POST', '/registry/inquiries', async context => {
    const input = context.body as Row;
    const identity = context.identity!;
    const scoped = identity as Identity;
    const inquiry = await service.openInquiry(actor(context) as never, {
      id: id(), tokenId: identity.role === 'registry' ? identity.id : null,
      runId: identity.role === 'registry' ? identity.runId ?? null : null,
      sessionRef: identity.role === 'registry' ? scoped.sessionRef ?? null : null,
      problem: input.problem, category: input.category, projectId: input.project_id ?? null,
      action: input.action ?? null, target: input.target ?? null, reuseIntent: input.reuse_intent ?? 'once',
    });
    const results = await repo.registry.results.forInquiry(inquiry.inquiry.id);
    return response(201, { ...apiRow(inquiry.inquiry), results: results.map(result => ({ ...apiRow(result), score: Number(result.score) })) });
  });
  guarded('GET', '/registry/inquiries/{id}', async context => {
    const found = await repo.registry.inquiries.get(present(context.params.id));
    if (!found) throw new RegistryRefusedError('not_found');
    const results = await repo.registry.results.forInquiry(found.id);
    return response(200, { ...apiRow(found), results: results.map(result => ({ ...apiRow(result), score: Number(result.score) })) });
  });
  guarded('POST', '/registry/inquiries/{id}/verdicts', async context => {
    const body = context.body as Row;
    const result = await service.setVerdict(actor(context) as never, present(context.params.id), body.record_id, {
      verdict: body.verdict, difference: body.difference, conflictsWithId: body.conflicts_with,
    } as never);
    return response(201, apiRow(result));
  });
  guarded('POST', '/registry/gate', async context => {
    const body = context.body as Row;
    const settings = await repo.settings.snapshot(['registry.gateTimeoutMs']);
    const timeoutMs = settings['registry.gateTimeoutMs'];
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RegistryRefusedError('unavailable');
    const gate = createRegistryGate(repo, search, { timeoutMs, recordFailOpen: () => context.logger.info('Registry gate failed open') });
    const identity = context.identity!;
    const scoped = identity as Identity;
    const answer = await gate({ tokenId: identity.id, runId: identity.runId, sessionRef: scoped.sessionRef }, { inquiryId: body.inquiry_id, question: body.question });
    return response(200, answer.pass ? { pass: true } : { pass: false, records: await Promise.all(answer.records.map(row => record(row!.id))) });
  });
  guarded('GET', '/registry/search', async context => {
    const params = queryInput(context);
    const result = await search({ query: params.q ?? '', projectId: params.project_id, category: params.category, kind: params.kind, status: params.status, scopeType: params.scope, limit: await searchLimit(context, params) });
    return list(result.items as unknown as Row[], context, row => ({
      record: apiRow(row.record), matched_fields: row.matchedFields, ranking: row.ranking, score: Number(row.score), degraded: row.degraded,
    }));
  });
  guarded('GET', '/registry/records', async context => {
    const params = queryInput(context);
    let rows = params.q === undefined
      ? await repo.registry.records.list({ projectId: params.project_id, category: params.category, kind: params.kind, status: params.status, scopeType: params.scope, source: params.source })
      : (await search({ query: params.q, projectId: params.project_id, category: params.category, kind: params.kind, status: params.status, scopeType: params.scope, limit: await searchLimit(context, params) }))
        .items.map(hit => hit.record).filter(row => params.source === undefined || row.source === params.source);
    return list(rows as Row[], context, row => selected(row));
  });
  guarded('GET', '/registry/records/{id}', async context => response(200, await record(recordKey(context.params.id))));
  guarded('POST', '/registry/records', async context => {
    const body = context.body as Row;
    const identity = context.identity!;
    const isOwner = identity.role === 'owner';
    const created = await service.createRecord(actor(context) as never, {
      id: id(), kind: body.kind, authority: isOwner ? 'owner' : 'agent', status: 'draft', scopeType: body.scope_type,
      projectId: body.project_id ?? null, repository: body.repository ?? null, machineId: body.machine_id ?? null,
      action: body.action ?? null, target: body.target ?? null, category: body.category, problem: body.problem, decision: body.decision,
      exceptionsText: body.exceptions_text ?? null, grounds: body.grounds ?? null, consequences: body.consequences ?? null,
      reuse: body.reuse ?? 'once', tags: body.tags ?? [], evidence: body.evidence ?? null,
      source: isOwner ? 'owner_button' : 'agent_proposal', runId: identity.runId ?? null,
    } as never);
    return response(201, selected(created));
  });
  guarded('GET', '/registry/drafts', async context => {
    const rows = await repo.registry.records.list({ status: 'draft' });
    return list(rows as Row[], context, row => selected(row));
  });
  guarded('POST', '/registry/records/{id}/activate', async context => {
    const ids = ((context.body as Row | undefined)?.ids as string[] | undefined) ?? [context.params.id];
    const activated = await service.changeStatuses(actor(context) as never, ids.map(present), 'active', now());
    return response(200, await Promise.all(activated.map(async row => {
      if (!row) throw new RegistryRefusedError('not_found');
      return await record(row.id);
    })));
  });
  guarded('POST', '/registry/records/{id}/revoke', async context => {
    const changed = await service.changeStatus(actor(context) as never, present(context.params.id), 'revoked');
    return response(200, await record(changed!.id));
  });
  guarded('POST', '/registry/records/{id}/supersede', async context => {
    const body = context.body as Row;
    const identity = context.identity!;
    const created = await service.createSupersedingDraft(actor(context) as never, present(context.params.id), id(), {
      id: id(), kind: body.kind, authority: 'owner', status: 'draft', scopeType: body.scope_type, projectId: body.project_id ?? null,
      repository: body.repository ?? null, machineId: body.machine_id ?? null, action: body.action ?? null, target: body.target ?? null,
      category: body.category, problem: body.problem, decision: body.decision, exceptionsText: body.exceptions_text ?? null,
      grounds: body.grounds ?? null, consequences: body.consequences ?? null, reuse: body.reuse ?? 'once', tags: body.tags ?? [],
      evidence: body.evidence ?? null, source: 'owner_button', runId: identity.runId ?? null,
    } as never);
    return response(201, selected(created));
  });
  guarded('POST', '/registry/polls', async context => {
    const body = context.body as Row;
    const answer = await service.registerPoll(actor(context) as never, present(body.inquiry_id), { question: body.question, options: body.options, now: now() });
    return response(201, { poll_id: answer.pollId, display_line: answer.displayLine });
  });
  guarded('POST', '/registry/captures', async context => {
    const body = context.body as Row;
    const captured = await service.capturePoll(actor(context) as never, { pressId: body.press_id, telegramUserId: body.telegram_user_id, pollId: present(body.poll_id), optionIndex: body.option_index, now: now() });
    return response(200, await record(captured.id));
  });

  guarded('GET', '/regulation/versions', async context => {
    const params = queryInput(context);
    const versions = await repo.registry.regulations.list({ status: params.status });
    return list(versions as Row[], context, row => {
      const { clauses: _clauses, ...summary } = row;
      return regulationWire(summary);
    });
  });
  guarded('GET', '/regulation/versions/{id}', async context => {
    const version = await repo.registry.regulations.get(present(context.params.id));
    if (!version) throw new RegistryRefusedError('not_found');
    return response(200, regulationWire(version));
  });
  guarded('POST', '/regulation/versions', async context => {
    const identity = context.identity!;
    const body = context.body as Row;
    const version = await service.createRegulationDraft(actor(context) as never, { id: id(), clauses: body.clauses, basisVersionId: body.basis_version_id } as never);
    return response(201, regulationWire(version));
  });
  guarded('GET', '/regulation/versions/{id}/diff', async context => {
    const diff = await service.getRegulationDiff(present(context.params.id), queryInput(context).project_id ? { projectId: queryInput(context).project_id } : undefined);
    return response(200, { from_id: diff.fromId, to_id: diff.toId, changes: diff.changes.map(change => ({
      clause_id: change.clauseId, change: change.change,
      before: change.before === null ? null : apiRow(change.before as Row), after: change.after === null ? null : apiRow(change.after as Row),
    })) });
  });
  for (const operation of ['activate', 'revoke'] as const) {
    guarded('POST', `/regulation/versions/{id}/${operation}`, async context => {
      const actorValue = actor(context) as { type: 'owner'; id: string };
      const idValue = present(context.params.id);
      const confirmHeader = context.request.headers['x-confirm'];
      if (typeof confirmHeader !== 'string') {
        const requested = await service.requestRegulationConfirmation(actorValue, idValue, {
          channel: 'api', deviceSessionId: null, now: now(),
        }, operation);
        return response(409, { code: 'confirmation_required', confirmation_id: requested.id, nonce: requested.nonce, expires_at: requested.expiresAt.toISOString() });
      }
      const changed = operation === 'activate'
        ? await service.activateRegulation(actorValue, idValue, { confirm: confirmHeader, channel: 'api', deviceSessionId: null, now: now() })
        : await service.revokeRegulation(actorValue, idValue, { confirm: confirmHeader, channel: 'api', deviceSessionId: null, now: now() });
      await writeAudit(repo, context, `regulation.${operation}`, 'regulation_version', idValue, 'ok', { operation });
      return response(200, regulationWire(changed));
    });
  }
}
