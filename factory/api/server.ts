import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { routes, type Route } from '../contracts/routes.ts';
import { databaseUnavailable } from '../db/repo/errors.ts';
import { createLogger, type Logger } from '../lib/log.ts';
import { BadCursorError } from './cursor.ts';

type Identity = { id: string; role: string | null; prefix: string | null; tokenHash: string | null; workerId: string | null; ownerId?: string | null; runId?: string | null; revokedAt: Date | null; expiresAt: Date | null; validUntil: Date | null };
type AuthorizeScope = (context: { identity: Identity; route: Route; params: Record<string, string>; body: unknown; scope: string }) => Promise<boolean>;
type Dependencies = { tokens: { byHash(hash: string): Promise<Identity | undefined> }; authorizeScope?: AuthorizeScope; logger?: Logger; clock?: () => Date };
// Every route template that has a path parameter names it `{id}`; the router fills it before the handler runs.
export type PathParams = Record<string, string> & { id: string };
export type HandlerContext = { request: IncomingMessage; route: Route; params: PathParams; body: unknown; identity: Identity | null; requestId: string; logger: Logger };
export type Handler = (context: HandlerContext) => Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>;
type Registration = { authorizeScope?: AuthorizeScope; onProblem?: (context: HandlerContext, status: number, code: string) => Promise<void> };

const uuid = z.string().uuid();
const matching = routes.map((route) => {
  const names: string[] = [];
  const pattern = route.path.split('/').map((part) => {
    const match = /^\{([^}]+)\}$/.exec(part);
    if (match) { names.push(match[1]!); return '([^/]+)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { route, names, regex: new RegExp(`^${pattern}$`), specificity: names.length };
}).sort((a, b) => a.specificity - b.specificity);

export function createApiServer(deps: Dependencies) {
  const handlers = new Map<string, Registration & { handler: Handler }>();
  const logger = deps.logger ?? createLogger();
  const clock = deps.clock ?? (() => new Date());
  const server = createServer(async (req, res) => {
    const suppliedId = req.headers['x-request-id'];
    const requestId = typeof suppliedId === 'string' && uuid.safeParse(suppliedId).success ? suppliedId : randomUUID();
    const log = logger.child({ correlation_id: requestId });
    res.setHeader('X-Request-Id', requestId);
    let context: HandlerContext | undefined;
    let registered: (Registration & { handler: Handler }) | undefined;
    const problem = async (status: number, code: string, detail: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
      if (context && registered?.onProblem && status !== 503) {
        try { await registered.onProblem(context, status, code); }
        catch { log.info('API request audit failed'); }
      }
      log.info('API request failed');
      res.writeHead(status, { ...headers, 'content-type': 'application/problem+json' });
      res.end(JSON.stringify({ ...extra, type: 'about:blank', title: code, status, code, detail, request_id: requestId, errors: [] }));
    };
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      const match = matching.find((item) => item.route.method === req.method && item.regex.test(pathname));
      if (!match) { await problem(404, 'not_found', 'Route not found'); return; }
      const route = match.route;
      registered = handlers.get(`${route.method} ${route.path}`);
      context = { request: req, route, params: {} as PathParams, body: undefined, identity: null, requestId, logger: log };
      const values = match.regex.exec(pathname)!;
      let params: PathParams;
      try { params = Object.fromEntries(match.names.map((name, i) => [name, decodeURIComponent(values[i + 1]!) ])) as PathParams; }
      catch { await problem(422, 'validation_failed', 'Invalid path parameter'); return; }
      context.params = params;
      let identity: Identity | null = null;
      if (!route.roles.includes('none')) {
        const bearer = /^Bearer afk_([^_\s]+)_([^\s]+)$/.exec(req.headers.authorization ?? '');
        if (!bearer) { await problem(401, 'unauthenticated', 'Authentication required'); return; }
        const digest = createHash('sha256').update(bearer[2]!).digest('hex');
        identity = await deps.tokens.byHash(digest) ?? null;
        context.identity = identity;
        const stored = identity?.tokenHash;
        const validHash = typeof stored === 'string' && /^[0-9a-f]{64}$/.test(stored) && timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(stored, 'hex'));
        const now = clock().getTime();
        if (!identity || !validHash || identity.prefix !== bearer[1] || identity.revokedAt || (identity.expiresAt && identity.expiresAt.getTime() <= now) || (identity.validUntil && identity.validUntil.getTime() <= now)) { await problem(401, 'unauthenticated', 'Authentication required'); return; }
        if (!identity.role || !route.roles.some((role) => role.split(':')[0] === identity!.role)) { await problem(403, 'forbidden', 'Access denied'); return; }
        if (identity.role === 'worker' && (!identity.workerId || (route.roles.includes('worker:own_id') && params.id !== identity.workerId))) { await problem(403, 'forbidden', 'Access denied'); return; }
      }
      let body: unknown;
      if (route.request instanceof z.ZodType || route.request === 'none') {
        const chunks: Buffer[] = [];
        let unexpectedBody = false;
        for await (const chunk of req) {
          if (route.request === 'none') unexpectedBody = true;
          else chunks.push(Buffer.from(chunk));
        }
        if (unexpectedBody) { await problem(422, 'validation_failed', 'Unexpected request body'); return; }
        if (route.request instanceof z.ZodType && (chunks.length || !route.requestOptional)) {
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { await problem(422, 'validation_failed', 'Invalid request body'); return; }
          const parsed = route.request.safeParse(body);
          if (!parsed.success) { await problem(422, 'validation_failed', 'Invalid request body'); return; }
          body = parsed.data;
        }
      }
      context.body = body;
      if (identity) {
        const grants = route.roles.filter((role) => role.split(':')[0] === identity!.role);
        if (!grants.includes(identity.role!) && !(await Promise.all(grants.map(async (grant) => {
          if (grant === 'worker:own_id') return params.id === identity!.workerId;
          const context = { identity: identity!, route, params, body, scope: grant.split(':')[1]! };
          if (registered?.authorizeScope && !await registered.authorizeScope(context)) return false;
          return deps.authorizeScope ? deps.authorizeScope(context) : Boolean(registered?.authorizeScope);
        }))).some(Boolean)) { await problem(403, 'forbidden', 'Access denied'); return; }
      }
      if (!registered) { await problem(501, 'not_implemented', 'Route is not implemented'); return; }
      const result = await registered.handler(context);
      if (result.status >= 400) {
        const body = result.body && typeof result.body === 'object' ? result.body as Record<string, unknown> : {};
        const code = typeof body.code === 'string' && route.errors[result.status]?.includes(body.code) ? body.code : 'internal';
        if (code === 'internal') { await problem(500, code, 'Request failed'); return; }
        const fields = ['current_row_version', 'retry_after'];
        if (code === 'confirmation_required') fields.push('confirmation_id', 'nonce', 'expires_at');
        if (code === 'guard_conflict') fields.push('conflicts_with');
        const extra = Object.fromEntries(fields.filter(field => Object.hasOwn(body, field)).map(field => [field, body[field]]));
        await problem(result.status, code, 'Request failed', extra, result.headers);
        return;
      }
      log.info('API request completed');
      res.writeHead(result.status, result.headers);
      const contentType = result.headers?.['content-type'] ?? '';
      res.end(result.body === undefined ? undefined : typeof result.body === 'string' && (contentType.startsWith('text/') || contentType.includes('application/octet-stream')) ? result.body : JSON.stringify(result.body));
    } catch (error) {
      // A malformed or foreign cursor is the caller's mistake (api.md:385, :667), whichever handler read the stream.
      if (res.headersSent) res.destroy();
      else if (error instanceof BadCursorError) await problem(400, 'bad_cursor', 'Invalid cursor');
      else if (databaseUnavailable(error)) await problem(503, 'unavailable', 'Database unavailable', { retry_after: 1 }, { 'Retry-After': '1' });
      else await problem(500, 'internal', 'Request failed');
    }
  });
  return {
    register(method: Route['method'], path: string, handler: Handler, options?: Registration) {
      if (!routes.some((route) => route.method === method && route.path === path)) throw new Error('Unknown route');
      handlers.set(`${method} ${path}`, { handler, ...options });
    },
    listen(port: number): Promise<AddressInfo> { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address() as AddressInfo); }); }); },
    close(): Promise<void> { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); },
  };
}
