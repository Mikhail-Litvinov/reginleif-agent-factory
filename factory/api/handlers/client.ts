import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { BadCursorError, decodeCursor, encodeCursor, readStreamPage, streamSource, streams, type Stream } from '../cursor.ts';
import { DecisionProblem, hash, mutationHash, recordDecision, type DecisionKind } from '../decisions.ts';
import { decisionRequestSchemas } from '../../contracts/schemas/index.ts';
import * as Q from '../../contracts/schemas/requests.ts';
import * as R from '../../contracts/schemas/resources.ts';
import type { Repo } from '../../db/repo/index.ts';
import type { createApiServer, Handler, HandlerContext } from '../server.ts';

type Tx = Parameters<Parameters<Repo['transaction']>[0]>[0];
type Result = Awaited<ReturnType<Handler>>;
type ProtocolRow = z.ZodObject;
type Poll = Awaited<ReturnType<Repo['polls']['get']>>;
type Options = { horizon?: () => Promise<string>; waitForEvents?: (signal: AbortSignal) => Promise<void> };
type Principal = { ownerId: string; deviceSessionId: string | null; tokenId: string | null };

const uuid = z.uuid();
const keySyntax = /^[A-Za-z0-9_-]{8,128}$/; // api.md, Idempotency.
const randomSecret = () => randomBytes(32).toString('base64url'); // database.md, Client tables.
const replayHeaders = { 'Idempotent-Replay': 'true' };
const unavailable = () => new DecisionProblem('unavailable', 503);
const missing = () => new DecisionProblem('not_found', 404);
const invalid = () => new DecisionProblem('validation_failed', 422);
const pollClosed = (poll: NonNullable<Poll>) => new DecisionProblem('poll_closed', 409, {
  answered_via: poll.answeredVia,
  answered_at: poll.answeredAt?.toISOString() ?? null,
});

export const clientPromptPolicy = {
  served: ['factory_decision', 'confirmation', 'session_poll'],
  unserved: ['third_party_tool_permission'],
} as const;

const conversationStates = R.Conversation.shape.state;
const pollStates = R.Poll.shape.state;
const requestStates = R.PollAnswerRequest.shape.state;
const hubMessage = z.strictObject({
  body: z.string(),
  parsed: z.json().optional(),
  attachment_ids: Q.MessageCreate.shape.attachment_ids,
  title: z.string().optional(),
});
const hubPoll = z.strictObject({ question: z.string(), options: Q.RegistryPoll.shape.options.min(1), title: z.string().optional() });
const hubState = z.object({ state: conversationStates.optional(), title: z.string().optional() });
const streamSchemas = { task_events: R.TaskEvent, audit_log: R.AuditEntry, notifications: R.Notification, messages: R.Message };

function project(schema: ProtocolRow, row: object): Record<string, unknown> {
  const stored = row as Record<string, unknown>;
  return Object.fromEntries(Object.keys(schema.shape).map(field => {
    const value = stored[field.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())];
    return [field, value instanceof Date ? value.toISOString() : typeof value === 'bigint' ? Number(value) : value ?? null];
  }));
}

function query(context: HandlerContext) {
  return new URL(context.request.url ?? '/', 'http://localhost').searchParams;
}

function principal(context: HandlerContext): Principal {
  const identity = context.identity;
  if (!identity?.ownerId) throw new DecisionProblem('forbidden', 403);
  const isDevice = identity.role === 'device';
  return { ownerId: identity.ownerId, deviceSessionId: isDevice ? identity.id : null, tokenId: isDevice ? null : identity.id };
}

function mutationKey(context: HandlerContext): string {
  const key = context.request.headers['idempotency-key'];
  if (typeof key !== 'string' || !keySyntax.test(key)) throw invalid();
  return key;
}

function requestHash(context: HandlerContext): string {
  return mutationHash(context.route.method, new URL(context.request.url ?? '/', 'http://localhost').pathname, context.body ?? null);
}

function presentId(value: string | undefined): string {
  if (!uuid.safeParse(value).success) throw invalid();
  return value!;
}

async function audit(tx: Tx, context: HandlerContext, actor: Principal | null, action: string, targetType: string, targetId: string | null, details: Record<string, string> = {}, outcome = 'ok') {
  const row = await tx.audit.append({
    id: randomUUID(), requestId: context.requestId, actorId: actor?.ownerId ?? null, tokenId: actor ? actor.tokenId : context.identity?.id ?? null,
    deviceSessionId: actor?.deviceSessionId ?? null, action, targetType, targetId, outcome,
    // Enrollment sends a credential as its body. The failed and successful audit rows carry metadata only.
    requestHash: action === 'device.enroll' ? null : requestHash(context), details,
  });
  return row.id;
}

async function positiveSettings(repo: Repo, defaults: Record<string, number>) {
  const settings = await repo.settings.snapshot(Object.keys(defaults));
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const value = settings[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw unavailable();
    return [key, value];
  })) as Record<string, number>;
}

// Phase 2 has no seeded values for these API settings. Read overrides for each request.
const confirmationSeconds = { 'confirm.windowSeconds': 60 };
const enrollmentSeconds = { 'device.codeTtlSeconds': 300, 'device.sessionTtlSeconds': 2_592_000 };
const pageDefaults = { 'page.default': 50, 'page.max': 200 };
const failureDefaults = { 'rate.failedAuth.limit': 10, 'rate.failedAuth.windowSeconds': 60 };
const millisecondsPerSecond = 1000;
const expires = (now: Date, seconds: number) => new Date(now.getTime() + seconds * millisecondsPerSecond);

async function pageSize(repo: Repo, context: HandlerContext) {
  const settings = await positiveSettings(repo, pageDefaults);
  const raw = query(context).get('limit');
  const max = settings['page.max']!;
  const size = raw === null ? Math.min(settings['page.default']!, max) : Number(raw);
  if ((raw !== null && !/^[1-9]\d*$/.test(raw)) || !Number.isSafeInteger(size) || size > max) throw invalid();
  return size;
}

const pageCursor = z.tuple([z.string(), z.iso.datetime(), uuid]);
async function pageBounds(repo: Repo, context: HandlerContext) {
  const search = query(context);
  const scope = JSON.stringify([context.route.path, context.params, [...search].filter(([key]) => key !== 'cursor' && key !== 'limit').sort()]);
  const value = search.get('cursor');
  let after: { time: Date; id: string } | undefined;
  if (value !== null) {
    try {
      const bytes = Buffer.from(value, 'base64url');
      const [cursorScope, time, id] = pageCursor.parse(JSON.parse(bytes.toString()));
      if (bytes.toString('base64url') !== value || cursorScope !== scope) throw invalid();
      after = { time: new Date(time), id };
    } catch { throw invalid(); }
  }
  const size = await pageSize(repo, context);
  return { scope, size, after, limit: size + 1 };
}

function page<T extends { id: string; createdAt: Date }>(rows: T[], bounds: { size: number; scope: string }, serialize: (row: T) => unknown): Result {
  const items = rows.slice(0, bounds.size);
  const last = items.at(-1);
  return { status: 200, body: {
    items: items.map(serialize),
    next_cursor: last && rows.length > bounds.size ? Buffer.from(JSON.stringify([bounds.scope, last.createdAt.toISOString(), last.id])).toString('base64url') : null,
  } };
}

async function keyed(repo: Repo, context: HandlerContext, actorKey: string, effect: (tx: Tx) => Promise<Result>, secret = false): Promise<Result> {
  const key = mutationKey(context);
  const digest = requestHash(context);
  const confirm = context.request.headers['x-confirm'];
  return repo.transaction(async tx => {
    await tx.decisions.lockKey(actorKey, key);
    if (await tx.decisions.byActorKey(actorKey, key)) throw new DecisionProblem('idempotency_conflict');
    const claim = await tx.idempotencyKeys.claim({ actorId: actorKey, key, requestHash: digest, state: 'in_progress' });
    if (claim.replayed) {
      if (claim.row.requestHash !== digest) throw new DecisionProblem('idempotency_conflict');
      if (claim.row.state !== 'done') return { status: 409, body: { code: 'idempotency_in_progress' }, headers: { 'Retry-After': '1' } };
      if (claim.row.responseStatus !== 409 || !confirm) {
        if (secret && claim.row.responseStatus === 201) throw new DecisionProblem('token_already_issued');
        return { status: claim.row.responseStatus!, body: claim.row.responseBody ?? undefined, headers: replayHeaders };
      }
    }
    const result = await effect(tx);
    const body = secret && result.status === 201 ? null : result.body ?? null;
    await tx.idempotencyKeys.complete(actorKey, key, result.status, body);
    return result;
  });
}

async function confirm(tx: Tx, context: HandlerContext, actor: Principal, operation: string, targetId: string, windowSeconds: number): Promise<Result | undefined> {
  const value = context.request.headers['x-confirm'];
  const bindings = {
    actorId: actor.ownerId, channel: actor.deviceSessionId ? 'client' : 'api',
    deviceSessionId: actor.deviceSessionId, operation, targetType: operation === 'device.create' ? 'owner' : 'system',
    targetId, requestHash: requestHash(context),
  };
  if (value === undefined) {
    const id = randomUUID();
    const nonce = randomSecret();
    const expiresAt = expires(context.now, windowSeconds);
    await tx.confirmations.create({ id, ...bindings, nonceHash: hash(nonce), issuedAt: context.now, expiresAt });
    await audit(tx, context, actor, operation, bindings.targetType, targetId, {}, 'confirmation_required');
    return { status: 409, body: { code: 'confirmation_required', confirmation_id: id, nonce, expires_at: expiresAt.toISOString() } };
  }
  const [id, nonce, extra] = (typeof value === 'string' ? value : '').split('.');
  if (!uuid.safeParse(id).success || !nonce || extra !== undefined) throw new DecisionProblem('confirmation_invalid');
  const row = await tx.confirmations.get(id!);
  const expected = row?.nonceHash;
  if (!expected || !/^[a-f0-9]{64}$/.test(expected) || !timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(hash(nonce), 'hex')) ||
      !await tx.confirmations.consume({ id: id!, ...bindings, now: context.now })) throw new DecisionProblem('confirmation_invalid');
}

export async function readClientEvents(repo: Repo, stream: Stream, options: { cursor?: string; limit: number; horizon?: () => Promise<string>; conversationId?: string }) {
  return readStreamPage(stream, streamSource(repo, stream, { conversationId: options.conversationId }), options);
}

function streamCursors(context: HandlerContext): Map<Stream, string> {
  const cursors = new Map<Stream, string>();
  const set = (cursor: string, fromHeader: boolean) => {
    const stream = streams.find(candidate => {
      try { decodeCursor(candidate, cursor); return true; } catch { return false; }
    });
    if (!stream || (!fromHeader && cursors.has(stream))) throw new BadCursorError();
    cursors.set(stream, cursor);
  };
  for (const cursor of query(context).getAll('cursor')) set(cursor, false);
  const last = context.request.headers['last-event-id'];
  if (last !== undefined && last !== '') {
    if (typeof last !== 'string') throw new BadCursorError();
    set(last, true);
  }
  return cursors;
}

async function events(repo: Repo, context: HandlerContext, options: Options): Promise<Result> {
  const cursors = streamCursors(context);
  const limit = await pageSize(repo, context);
  // The wire has one event ID per frame. The consumer can resume other streams with repeated cursor parameters.
  return {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    stream: async function* (signal) {
      const wait = options.waitForEvents ?? ((stop: AbortSignal) => delay(millisecondsPerSecond, undefined, { signal: stop }));
      try {
        while (!signal.aborted) {
          let backlog = false;
          const below = await (options.horizon ?? repo.audit.snapshotXmin)();
          for (const stream of streams) {
            const result = await readClientEvents(repo, stream, { cursor: cursors.get(stream), limit, horizon: async () => below });
            backlog ||= result.items.length === limit;
            for (const row of result.items) {
              if (signal.aborted) return;
              const cursor = encodeCursor(stream, row);
              const schema = streamSchemas[stream];
              const data = schema.parse(project(schema, row));
              cursors.set(stream, cursor);
              yield `id: ${cursor}\nevent: ${stream}\ndata: ${JSON.stringify(data)}\n\n`;
            }
          }
          if (!backlog && !signal.aborted) await wait(signal);
        }
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    },
  };
}

function registerDevices(register: Register, repo: Repo) {
  register('POST', '/devices', async context => {
    const actor = principal(context);
    const settings = await positiveSettings(repo, { ...confirmationSeconds, ...enrollmentSeconds });
    const body = context.body as z.infer<typeof Q.DeviceCreate>;
    return keyed(repo, context, actor.ownerId, async tx => {
      const first = await confirm(tx, context, actor, 'device.create', actor.ownerId, settings['confirm.windowSeconds']!);
      if (first) return first;
      const code = randomSecret();
      const row = await tx.devices.create({ id: randomUUID(), ownerId: actor.ownerId, ...body, codeHash: hash(code), codeExpiresAt: expires(context.now, settings['device.codeTtlSeconds']!) });
      await audit(tx, context, actor, 'device.create', 'devices', row.id);
      return { status: 201, body: { ...project(R.Device, row), code }, headers: { 'cache-control': 'no-store' } };
    }, true);
  });
  register('POST', '/devices/enroll', async context => {
    const { code } = context.body as z.infer<typeof Q.Enroll>;
    const settings = await positiveSettings(repo, enrollmentSeconds);
    return repo.transaction(async tx => {
      const device = await tx.devices.consumeCode(hash(code), context.now);
      if (!device) {
        await audit(tx, context, null, 'device.enroll', 'devices', null, {}, 'denied');
        return { status: 401, body: { code: 'unauthenticated' } };
      }
      const prefix = randomBytes(16).toString('hex'); // Separate from the 32-byte session secret used for authentication.
      const secret = randomSecret();
      const row = await tx.deviceSessions.create({ id: randomUUID(), deviceId: device.id, prefix, tokenHash: hash(secret), expiresAt: expires(context.now, settings['device.sessionTtlSeconds']!) });
      await audit(tx, context, { ownerId: device.ownerId!, deviceSessionId: row.id, tokenId: null }, 'device.enroll', 'device_sessions', row.id);
      return { status: 201, body: { ...project(R.DeviceSession, row), secret: `afk_${prefix}_${secret}` }, headers: { 'cache-control': 'no-store' } };
    });
  });
  register('GET', '/devices', async context => {
    const bounds = await pageBounds(repo, context);
    return page(await repo.devices.list(principal(context).ownerId, bounds), bounds, row => project(R.Device, row));
  });
  const ownedDevice = async (db: Tx, id: string, actor: Principal) => {
    const row = await db.devices.get(id);
    if (!row || row.ownerId !== actor.ownerId) throw missing();
    return row;
  };
  register('GET', '/devices/{id}/sessions', async context => {
    const id = presentId(context.params.id);
    await ownedDevice(repo, id, principal(context));
    const bounds = await pageBounds(repo, context);
    return page(await repo.deviceSessions.list(id, bounds), bounds, row => project(R.DeviceSession, row));
  });
  register('DELETE', '/devices/{id}', async context => {
    const id = presentId(context.params.id);
    const actor = principal(context);
    return keyed(repo, context, actor.deviceSessionId ?? actor.ownerId, async tx => {
      const current = await ownedDevice(tx, id, actor);
      const revoked = await tx.devices.revoke(id);
      if (revoked) await tx.deviceSessions.revokeForDevice(id);
      await audit(tx, context, actor, 'device.revoke', 'devices', id);
      return { status: 200, body: project(R.Device, revoked ?? await tx.devices.get(id) ?? current) };
    });
  });
  register('DELETE', '/device-sessions/{id}', async context => {
    const id = presentId(context.params.id);
    const actor = principal(context);
    return keyed(repo, context, actor.deviceSessionId ?? actor.ownerId, async tx => {
      const current = await tx.deviceSessions.get(id);
      if (!current?.deviceId) throw missing();
      await ownedDevice(tx, current.deviceId, actor);
      const revoked = await tx.deviceSessions.revoke(id);
      await audit(tx, context, actor, 'session.revoke', 'device_sessions', id);
      return { status: 200, body: project(R.DeviceSession, revoked ?? await tx.deviceSessions.get(id) ?? current) };
    });
  });
}

async function conversation(repo: Tx, id: string) {
  const row = await repo.conversations.get(id);
  if (!row) throw missing();
  return row;
}

function registerConversations(register: Register, repo: Repo, options: Options) {
  register('GET', '/conversations', async context => {
    const search = query(context);
    const source = search.get('source');
    const archived = search.get('archived');
    const projectId = search.get('project_id');
    const taskId = search.get('task_id');
    if ((source !== null && !R.Conversation.shape.source.safeParse(source).success) ||
      (archived !== null && archived !== 'true' && archived !== 'false')) throw invalid();
    const bounds = await pageBounds(repo, context);
    const rows = await repo.conversations.list({
      ...bounds, source: source ?? undefined, archived: archived === null ? undefined : archived === 'true',
      projectId: projectId === null ? undefined : presentId(projectId), taskId: taskId === null ? undefined : presentId(taskId),
    });
    return page(rows, bounds, row => project(R.Conversation, row));
  });
  register('GET', '/conversations/{id}', async context => ({
    status: 200, body: project(R.Conversation, await conversation(repo, presentId(context.params.id))),
  }));
  register('GET', '/conversations/{id}/messages', async context => {
    const id = presentId(context.params.id);
    await conversation(repo, id);
    const result = await readClientEvents(repo, 'messages', { conversationId: id, cursor: query(context).get('cursor') ?? undefined, limit: await pageSize(repo, context), horizon: options.horizon });
    return { status: 200, body: { ...result, items: result.items.map(row => project(R.Message, row)) } };
  });
  register('POST', '/conversations/{id}/messages', async context => {
    const id = presentId(context.params.id);
    const actor = principal(context);
    const body = context.body as z.infer<typeof Q.MessageCreate>;
    if (!body.text.trim()) throw invalid();
    return keyed(repo, context, actor.deviceSessionId ?? actor.ownerId, async tx => {
      const current = await tx.conversations.lock(id);
      if (!current) throw missing();
      if (current.state === 'ended') throw new DecisionProblem('request_closed');
      let taskId = current.taskId;
      if (!taskId && current.projectId) {
        const task = await tx.tasks.create({
          id: randomUUID(), projectId: current.projectId, title: current.title ?? body.text, priority: 0, createdBy: actor.ownerId,
        }, { id: randomUUID(), requirements: body.text, acceptanceCriteria: [] });
        taskId = task.id;
      }
      const row = await tx.messages.append({
        id: randomUUID(), conversationId: id, sourceKey: randomUUID(), kind: 'owner', author: 'owner',
        body: body.text, parsed: null, taskId, attachmentIds: body.attachment_ids ?? [], deviceSessionId: actor.deviceSessionId,
        ownerId: actor.deviceSessionId ? null : actor.ownerId,
      });
      await tx.conversations.touchMessage(id, row.createdAt);
      await audit(tx, context, actor, 'message.create', 'messages', row.id);
      return { status: 201, body: { message: project(R.Message, row), task_id: taskId } };
    });
  });
}

function registerHubIntake(register: Register, repo: Repo) {
  for (const resource of ['messages', 'polls', 'states'] as const) {
    const path = `/hub/${resource}`;
    register('POST', path, async context => {
      const { key, session_ref: sessionRef, kind, content } = context.body as z.infer<typeof Q.HubItem>;
      if (!key.trim() || !sessionRef.trim()) throw invalid();
      // State notices store only the known state. Native prompts never become message or poll rows.
      const stateInput = hubState.safeParse(content);
      const knownState = conversationStates.safeParse(kind);
      const state = stateInput.success ? stateInput.data.state ?? (knownState.success ? knownState.data : undefined) : undefined;
      const messageInput = hubMessage.safeParse(content);
      const pollInput = hubPoll.safeParse(content);
      const messageKind = R.Message.shape.kind.safeParse(kind);
      if ((resource === 'states' && !state) ||
          (resource === 'messages' && (!messageKind.success || !messageInput.success || kind === 'owner')) ||
          (resource === 'polls' && (kind !== 'poll' || !pollInput.success || new Set(pollInput.data.options.map(option => option.key)).size !== pollInput.data.options.length))) throw invalid();
      const title = resource === 'states' && state !== 'permission_wait' && stateInput.success ? stateInput.data.title
        : resource === 'messages' && messageInput.success ? messageInput.data.title
        : resource === 'polls' && pollInput.success ? pollInput.data.title : undefined;
      // The conversation scopes the hub's key across retries and token rotations.
      const recordKey = 'hub:' + hash(JSON.stringify([path, sessionRef, key]));
      return repo.transaction(async tx => {
        const current = await tx.conversations.forHubSession({ id: randomUUID(), sessionRef, state: state ?? 'active', title: title ?? sessionRef });
        await tx.decisions.lockKey(current.id, recordKey);
        const existing = await tx.idempotencyKeys.get(current.id, recordKey);
        if (existing) return { status: 200, body: existing.responseBody, headers: replayHeaders };
        let row: object;
        if (resource === 'states') {
          row = project(R.Conversation, (await tx.conversations.updateState(current.id, state!))!);
        } else {
          const message = messageInput.data;
          const poll = pollInput.data;
          const isPoll = resource === 'polls';
          // A message has no power to create an approval, even if it carries look-alike parsed fields.
          const plain = !isPoll && (kind === 'text' || kind === 'approval' || message?.parsed == null);
          const stored = await tx.messages.append({
            id: randomUUID(), conversationId: current.id, sourceKey: (isPoll ? 'poll:' : 'message:') + key,
            kind: isPoll ? 'question' : plain ? 'text' : kind, author: 'agent',
            body: isPoll ? poll!.question : message!.body,
            parsed: plain || isPoll ? null : message!.parsed, attachmentIds: isPoll ? [] : message!.attachment_ids ?? [],
          });
          await tx.conversations.touchMessage(current.id, stored.createdAt);
          row = isPoll ? project(R.Poll, await tx.polls.create({
            id: randomUUID(), conversationId: current.id, messageId: stored.id, sourceKey: key, arbiter: 'hub',
            state: 'open', options: poll!.options.map(option => ({ ...option, recommended: option.recommended ?? false })),
          })) : project(R.Message, stored);
        }
        await tx.idempotencyKeys.claim({ actorId: current.id, key: recordKey, requestHash: requestHash(context), state: 'done', responseStatus: 201, responseBody: row });
        await audit(tx, context, null, `hub.${resource}`, 'conversations', current.id);
        return { status: 201, body: row };
      });
    });
  }
}

async function getPoll(repo: Tx, context: HandlerContext) {
  const id = presentId(context.params.poll_id);
  const poll = await repo.polls.get(id);
  if (!poll || poll.conversationId !== presentId(context.params.id)) throw missing();
  return poll;
}

function pollOption(poll: NonNullable<Poll>, key: string) {
  const options = R.Poll.shape.options.safeParse(poll.options);
  const option = options.success && options.data.find(item => item.key === key);
  if (!option) throw invalid();
  return option;
}

async function decisionInput(repo: Repo, poll: NonNullable<Poll>, key: string) {
  const option = pollOption(poll, key);
  if (!Object.hasOwn(decisionRequestSchemas, key)) throw invalid();
  const kind = key as DecisionKind;
  if (!poll.taskId) throw missing();
  const message = poll.messageId && await repo.messages.get(poll.messageId);
  const parsed = message && z.object({ decisions: z.record(z.string(), z.record(z.string(), z.json())) }).safeParse(message.parsed);
  const parameters = parsed && parsed.success ? parsed.data.decisions[key] : undefined;
  // The current contract exposes option keys and labels. Standard approval options can be derived from the revision.
  const approval = kind === 'approve' ? { comment: '' } : kind === 'reject' ? { reason: option.label } :
    kind === 'request_changes' ? { findings: [], comment: option.label } : {};
  const body = decisionRequestSchemas[kind].safeParse({
    ...approval, ...parameters, ...(poll.revisionNumber === null ? {} : { revision_number: poll.revisionNumber }),
  });
  if (!body.success) throw invalid();
  return { kind, body: body.data, taskId: poll.taskId };
}

function registerPolls(register: Register, repo: Repo) {
  register('GET', '/conversations/{id}/polls/{poll_id}', async context => {
    const poll = await getPoll(repo, context);
    const requests = context.identity?.role === 'device' ? await repo.pollAnswerRequests.listForPoll(poll.id, context.identity.id) : [];
    return { status: 200, body: { ...project(R.Poll, poll), answer_requests: requests.map(row => project(R.PollAnswerRequest, row)) } };
  });
  register('POST', '/conversations/{id}/polls/{poll_id}/answer', async context => {
    const { answer_key: answerKey } = context.body as z.infer<typeof Q.PollAnswer>;
    const actor = principal(context);
    const key = mutationKey(context);
    const poll = await getPoll(repo, context);
    if (poll.arbiter === 'api') {
      const settings = await positiveSettings(repo, confirmationSeconds);
      const input = await decisionInput(repo, poll, answerKey);
      const result = await recordDecision(repo, {
        ...input, actorId: actor.ownerId, deviceSessionId: actor.deviceSessionId, channel: actor.deviceSessionId ? 'client' : 'api',
        idempotencyKey: key, windowSeconds: settings['confirm.windowSeconds']!, now: context.now,
        confirm: typeof context.request.headers['x-confirm'] === 'string' ? context.request.headers['x-confirm'] : undefined,
        path: `/conversations/${poll.conversationId}/polls/${poll.id}/answer`, poll: { id: poll.id, answerKey },
      });
      return { status: result.status, body: result.body, headers: {
        ...(result.replayed ? replayHeaders : {}), ...(result.status === 202 ? { Location: result.location } : {}),
      } };
    }
    const actorKey = actor.deviceSessionId ?? actor.ownerId;
    const digest = requestHash(context);
    return repo.transaction(async tx => {
      await tx.decisions.lockKey(actorKey, key);
      const claim = await tx.idempotencyKeys.claim({ actorId: actorKey, key, requestHash: digest, state: 'in_progress' });
      if (claim.row.requestHash !== digest || await tx.decisions.byActorKey(actorKey, key)) throw new DecisionProblem('idempotency_conflict');
      const previous = claim.replayed && typeof claim.row.responseBody === 'string' && await tx.pollAnswerRequests.get(claim.row.responseBody);
      if (claim.replayed && !previous) throw new DecisionProblem('idempotency_conflict');
      pollOption(poll, answerKey);
      const row = previous || await tx.pollAnswerRequests.create({ id: randomUUID(), pollId: poll.id, deviceSessionId: actor.deviceSessionId, idempotencyKey: key, answerKey });
      if (row.pollId !== poll.id || row.answerKey !== answerKey) throw new DecisionProblem('idempotency_conflict');
      if (!claim.replayed) {
        await tx.idempotencyKeys.complete(actorKey, key, 202, row.id);
        await audit(tx, context, actor, 'poll.answer_request', 'poll_answer_requests', row.id);
      }
      return { status: 202, body: project(R.PollAnswerRequest, row), headers: claim.replayed ? replayHeaders : undefined };
    });
  });
  register('GET', '/hub/poll-answers', async context => {
    const state = requestStates.safeParse(query(context).get('state') ?? 'pending');
    if (!state.success) throw invalid();
    const bounds = await pageBounds(repo, context);
    return repo.transaction(async tx => {
      const rows = await tx.pollAnswerRequests.list(state.data, bounds);
      const response = page(rows, bounds, row => project(R.PollAnswerRequest, row));
      const items = (response.body as { items: object[] }).items;
      for (const [index, row] of rows.slice(0, bounds.size).entries()) {
        if (!row.deliveredAt) {
          const current = await tx.pollAnswerRequests.markDelivered(row.id) ?? await tx.pollAnswerRequests.get(row.id);
          if (current) items[index] = project(R.PollAnswerRequest, current);
        }
      }
      return response;
    });
  });
  register('POST', '/hub/poll-answers/{id}/result', async context => {
    const id = presentId(context.params.id);
    const { state, refusal_reason: refusalReason, hub_ref: hubRef } = context.body as z.infer<typeof Q.PollAnswerResult>;
    if (state === 'refused' && !refusalReason?.trim()) throw invalid();
    return repo.transaction(async tx => {
      const initial = await tx.pollAnswerRequests.get(id);
      if (!initial?.pollId) throw missing();
      const poll = await tx.polls.get(initial.pollId);
      if (!poll || poll.arbiter !== 'hub') throw missing();
      const decided = await tx.pollAnswerRequests.decide(id, { state, refusalReason, hubRef });
      if (!decided) {
        const row = await tx.pollAnswerRequests.get(id);
        if (row?.state !== state || row.refusalReason !== (refusalReason ?? null) || row.hubRef !== (hubRef ?? null)) throw new DecisionProblem('request_closed');
        return { status: 200, body: project(R.PollAnswerRequest, row), headers: replayHeaders };
      }
      if (state === 'accepted' && !await tx.polls.answer(poll.id, {
        answerKey: decided.answerKey!, answeredVia: decided.deviceSessionId ? 'client' : 'api', answeredSessionId: decided.deviceSessionId, arbiter: 'hub', now: context.now,
      })) throw new DecisionProblem('request_closed');
      await audit(tx, context, null, 'hub.poll_answer_result', 'poll_answer_requests', id);
      return { status: 200, body: project(R.PollAnswerRequest, decided) };
    });
  });
  register('POST', '/hub/polls/{id}/result', async context => {
    const id = presentId(context.params.id);
    const { answer_key: answerKey } = context.body as z.infer<typeof Q.PollResult>;
    return repo.transaction(async tx => {
      const poll = await tx.polls.get(id);
      if (!poll || poll.arbiter !== 'hub') throw missing();
      if (poll.state !== 'open') throw pollClosed(poll);
      pollOption(poll, answerKey);
      const row = await tx.polls.answer(id, { answerKey, answeredVia: 'telegram', answeredSessionId: null, arbiter: 'hub', now: context.now });
      if (!row) throw pollClosed(await tx.polls.get(id) ?? poll);
      await audit(tx, context, null, 'hub.poll_result', 'polls', id);
      return { status: 200, body: project(R.Poll, row) };
    });
  });
  register('GET', '/hub/polls', async context => {
    const state = pollStates.optional().safeParse(query(context).get('state') ?? undefined);
    if (!state.success) throw invalid();
    const bounds = await pageBounds(repo, context);
    return page(await repo.polls.list({ ...bounds, state: state.data, hubView: true }), bounds, row => project(R.Poll, row));
  });
}

async function stopAll(repo: Repo, context: HandlerContext): Promise<Result> {
  for await (const chunk of context.request) if (Buffer.byteLength(chunk) > 0) throw invalid();
  const actor = principal(context);
  const settings = await positiveSettings(repo, confirmationSeconds);
  return keyed(repo, context, actor.deviceSessionId ?? actor.ownerId, async tx => {
    const first = await confirm(tx, context, actor, 'stop-all', actor.ownerId, settings['confirm.windowSeconds']!);
    if (first) return first;
    await tx.decisions.lockKey('system', 'stop-all');
    const { live, grants } = await tx.rightsSuspensions.stopTargets();
    const targets = new Map<string, { agentId: string | null; sessionRef?: string | null; taskId?: string | null }>();
    for (const { agentId } of live) if (agentId) targets.set(agentId, { agentId });
    const targetKey = (grant: (typeof grants)[number]) => grant.agentId ?? (grant.sessionRef ? `session:${grant.sessionRef}` : `task:${grant.taskId}`);
    for (const grant of grants) {
      const target = targetKey(grant);
      if (!targets.has(target)) targets.set(target, { agentId: grant.agentId, sessionRef: grant.agentId ? null : grant.sessionRef, taskId: grant.taskId });
    }
    const suspensions = new Map<string, string>();
    for (const [key, target] of [...targets].sort(([left], [right]) => left.localeCompare(right))) {
      const existing = target.agentId && await tx.rightsSuspensions.openForAgent(target.agentId);
      if (existing) { suspensions.set(key, existing.id); continue; }
      const id = randomUUID();
      const auditId = await audit(tx, context, actor, 'system.stop_all', 'rights_suspensions', id, { reason: 'owner_stop' });
      await tx.rightsSuspensions.create({ id, ...target, auditId, reason: 'owner_stop', eventKey: `${auditId}:${key}` });
      suspensions.set(key, id);
    }
    for (const grant of grants) await tx.rightGrants.end(grant.id, { endedBy: 'critical', suspensionId: suspensions.get(targetKey(grant))! });
    await tx.tokens.revokeForStop([...targets.values()].flatMap(target => target.agentId ? [target.agentId] : []),
      [...new Set(grants.flatMap(grant => grant.sessionRef ? [grant.sessionRef] : []))]);
    await audit(tx, context, actor, 'system.stop_all', 'system', null, { reason: 'owner_stop' });
    return { status: 204 };
  });
}

type Register = (method: Parameters<ReturnType<typeof createApiServer>['register']>[0], path: string, handler: Handler) => void;

export function registerClientHandlers(server: ReturnType<typeof createApiServer>, repo: Repo, options: Options = {}): void {
  if (repo.deviceSessions && repo.devices) server.useDeviceAuthentication({
    deviceSessions: { byTokenHash: repo.deviceSessions.lookupTokenHash, touch: repo.deviceSessions.touch },
    devices: repo.devices,
  });
  if (repo.settings) server.useFailedAuthenticationLimit(async () => {
    const settings = await positiveSettings(repo, failureDefaults);
    return { limit: settings['rate.failedAuth.limit']!, windowSeconds: settings['rate.failedAuth.windowSeconds']! };
  });
  const register: Register = (method, path, handler) => server.register(method, path, async context => {
    try {
      const search = query(context);
      for (const key of new Set(search.keys())) {
        const parameter = context.route.parameters?.find(parameter => parameter.in === 'query' && parameter.name === key);
        if (!parameter || (!parameter.repeatable && search.getAll(key).length !== 1)) throw invalid();
        if (key === 'include_deleted' && (context.identity?.role !== 'owner' || !['true', 'false'].includes(search.get(key)!))) throw invalid();
      }
      const result = await handler(context);
      const schema = context.route.responses?.[result.status];
      if (schema instanceof z.ZodType && result.status < 400) result.body = schema.parse(result.body);
      return result;
    } catch (error) {
      if (error instanceof DecisionProblem || error instanceof BadCursorError) {
        return { status: error.status, body: { code: error.code, ...(error instanceof DecisionProblem ? error.pollResult : undefined) } };
      }
      throw error;
    }
  });
  registerDevices(register, repo);
  registerConversations(register, repo, options);
  registerHubIntake(register, repo);
  registerPolls(register, repo);
  register('GET', '/events/stream', context => events(repo, context, options));
  register('POST', '/system/stop-all', context => stopAll(repo, context));
}
