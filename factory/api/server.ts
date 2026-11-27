import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { routes, type Route } from '../contracts/routes.ts';
import { createLogger, type Logger } from '../lib/log.ts';

type Identity = { id: string; ownerId?: string | null; role: string | null; prefix: string | null; tokenHash: string | null; workerId: string | null; revokedAt: Date | null; expiresAt: Date | null; validUntil: Date | null };
type DeviceAuth = {
  deviceSessions: {
    byTokenHash(hash: string): Promise<{ id: string; deviceId: string | null; prefix: string | null; tokenHash: string | null; revokedAt: Date | null; expiresAt: Date | null } | undefined>;
    touch(id: string, now?: Date): Promise<unknown>;
  };
  devices: { get(id: string): Promise<{ ownerId?: string | null; revokedAt: Date | null } | undefined> };
};
type Dependencies = { tokens: { byHash(hash: string): Promise<Identity | undefined> }; workers: { get(id: string): Promise<{ machineId: string | null } | undefined> }; deviceSessions?: DeviceAuth['deviceSessions']; devices?: DeviceAuth['devices']; authorizeScope?: (context: { identity: Identity; route: Route; params: Record<string, string>; body: unknown; scope: string }) => Promise<boolean>; logger?: Logger; clock?: () => Date };
type FailedAuthenticationLimit = { limit: number; windowSeconds: number };
export type HandlerContext = { request: IncomingMessage; route: Route; params: Record<string, string>; body: unknown; identity: Identity | null; requestId: string; logger: Logger; now: Date };
export type Handler = (context: HandlerContext) => Promise<{ status: number; body?: unknown; headers?: Record<string, string>; stream?: (signal: AbortSignal) => AsyncIterable<string> }>;

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
  const handlers = new Map<string, Handler>();
  const logger = deps.logger ?? createLogger();
  const clock = deps.clock ?? (() => new Date());
  const streams = new Set<AbortController>();
  let deviceAuth = deps.devices && deps.deviceSessions ? { devices: deps.devices, deviceSessions: deps.deviceSessions } : undefined;
  let failedAuthSettings: (() => Promise<FailedAuthenticationLimit>) | undefined;
  const failedAuth = new Map<string, { remaining: number; checkedAt: number }>();
  const server = createServer(async (req, res) => {
    const suppliedId = req.headers['x-request-id'];
    const requestId = typeof suppliedId === 'string' && uuid.safeParse(suppliedId).success ? suppliedId : randomUUID();
    const log = logger.child({ correlation_id: requestId });
    res.setHeader('X-Request-Id', requestId);
    const problem = (status: number, code: string, detail: string, headers?: Record<string, string>, fields?: object) => {
      log.info('API request failed');
      res.writeHead(status, { ...headers, 'content-type': 'application/problem+json' });
      res.end(JSON.stringify({ ...fields, type: 'about:blank', title: code, status, code, detail, request_id: requestId, errors: [] }));
    };
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      const match = matching.find((item) => item.route.method === req.method && item.regex.test(pathname));
      if (!match) { problem(404, 'not_found', 'Route not found'); return; }
      const values = match.regex.exec(pathname)!;
      const params = Object.fromEntries(match.names.map((name, i) => [name, decodeURIComponent(values[i + 1]!)]));
      const route = match.route;
      const now = clock();
      const source = req.socket.remoteAddress ?? '';
      const failureRate = async (record: boolean): Promise<boolean> => {
        if (!failedAuthSettings) return false;
        const { limit, windowSeconds } = await failedAuthSettings();
        const time = now.getTime();
        const existing = failedAuth.get(source);
        const replenishPerMs = limit / (windowSeconds * 1000);
        const elapsed = existing ? Math.max(0, time - existing.checkedAt) : 0;
        const available = existing ? Math.min(limit, existing.remaining + elapsed * replenishPerMs) : limit;
        const allowed = available >= 1;
        const remaining = record && allowed ? available - 1 : available;
        if (record) failedAuth.set(source, { remaining, checkedAt: time });
        const reset = Math.ceil((1 - Math.min(1, remaining)) / replenishPerMs / 1000);
        res.setHeader('RateLimit-Limit', limit);
        res.setHeader('RateLimit-Remaining', Math.floor(remaining));
        res.setHeader('RateLimit-Reset', reset);
        if (!allowed) problem(429, 'rate_limited', 'Too many failed authentication attempts', { 'Retry-After': String(reset) });
        return !allowed;
      };
      const refuseAuthentication = async (code = 'unauthenticated') => {
        if (!await failureRate(true)) problem(401, code, 'Authentication required');
      };
      const enrolling = route.path === '/devices/enroll';
      if (enrolling && await failureRate(false)) return;
      let identity: Identity | null = null;
      if (!route.roles.includes('none')) {
        const bearer = /^Bearer afk_([^_\s]+)_([^\s]+)$/.exec(req.headers.authorization ?? '');
        if (!bearer) { await refuseAuthentication(); return; }
        const digest = createHash('sha256').update(bearer[2]!).digest('hex');
        identity = await deps.tokens.byHash(digest) ?? null;
        if (!identity && deviceAuth) {
          const session = await deviceAuth.deviceSessions.byTokenHash(digest);
          const device = session?.deviceId ? await deviceAuth.devices.get(session.deviceId) : undefined;
          if (session && device) identity = { id: session.id, ownerId: device.ownerId, role: 'device', prefix: session.prefix, tokenHash: session.tokenHash, workerId: null, revokedAt: session.revokedAt ?? device.revokedAt, expiresAt: session.expiresAt, validUntil: null };
        }
        const stored = identity?.tokenHash;
        const validHash = typeof stored === 'string' && /^[0-9a-f]{64}$/.test(stored) && timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(stored, 'hex'));
        if (!identity || !validHash || identity.prefix !== bearer[1]) { await refuseAuthentication(); return; }
        if (identity.revokedAt || (identity.expiresAt && identity.expiresAt <= now) || (identity.validUntil && identity.validUntil <= now)) {
          await refuseAuthentication(identity.role === 'device' && identity.revokedAt ? 'device_revoked' : 'unauthenticated'); return;
        }
        if (!identity.role || !route.roles.some((role) => role.split(':')[0] === identity!.role)) {
          problem(403, identity.role === 'device' ? 'device_not_allowed' : 'forbidden', 'Access denied'); return;
        }
        if (identity.role === 'device' && deviceAuth && !await deviceAuth.deviceSessions.touch(identity.id, now)) { await refuseAuthentication('device_revoked'); return; }
        if (identity.role === 'worker' && (!identity.workerId || (route.roles.includes('worker:own_id') && params.id !== identity.workerId))) { problem(403, 'forbidden', 'Access denied'); return; }
      }
      let body: unknown;
      if (route.request instanceof z.ZodType) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { problem(422, 'validation_failed', 'Invalid request body'); return; }
        const parsed = route.request.safeParse(body);
        if (!parsed.success) { problem(422, 'validation_failed', 'Invalid request body'); return; }
        body = parsed.data;
      }
      if (identity?.role === 'worker' && route.path === '/workers/register') {
        const worker = await deps.workers.get(identity.workerId!);
        if (!worker || worker.machineId !== (body as { machine_id: string }).machine_id) { problem(403, 'forbidden', 'Access denied'); return; }
      }
      if (identity) {
        const grants = route.roles.filter((role) => role.split(':')[0] === identity!.role);
        if (!grants.includes(identity.role!) && !(await Promise.all(grants.map(async (grant) => {
          if (grant === 'worker:own_id') return params.id === identity!.workerId;
          return deps.authorizeScope?.({ identity: identity!, route, params, body, scope: grant.split(':')[1]! }) ?? false;
        }))).some(Boolean)) { problem(403, 'forbidden', 'Access denied'); return; }
      }
      const handler = handlers.get(`${route.method} ${route.path}`);
      if (!handler) { problem(501, 'not_implemented', 'Route is not implemented'); return; }
      const result = await handler({ request: req, route, params, body, identity, requestId, logger: log, now });
      if (result.status >= 400) {
        if (enrolling && result.status === 401 && await failureRate(true)) return;
        const error = result.body as { code?: unknown; detail?: unknown } | undefined;
        const code = typeof error?.code === 'string' ? error.code : 'internal';
        problem(result.status, code, typeof error?.detail === 'string' ? error.detail : 'Request failed', result.headers, error);
        return;
      }
      log.info('API request completed');
      res.writeHead(result.status, { ...(result.body === undefined ? {} : { 'content-type': 'application/json' }), ...result.headers });
      if (result.stream) {
        const controller = new AbortController();
        streams.add(controller);
        res.once('close', () => controller.abort());
        try {
          if (res.destroyed) controller.abort();
          res.flushHeaders();
          for await (const chunk of result.stream(controller.signal)) {
            if (controller.signal.aborted) break;
            if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
          }
        } finally {
          streams.delete(controller);
          res.end();
        }
      } else res.end(result.body === undefined ? undefined : JSON.stringify(result.body));
    } catch { if (!res.headersSent) problem(500, 'internal', 'Request failed'); else res.destroy(); }
  });
  return {
    useDeviceAuthentication(auth: DeviceAuth) { deviceAuth = auth; },
    useFailedAuthenticationLimit(settings: () => Promise<FailedAuthenticationLimit>) { failedAuthSettings = settings; },
    register(method: Route['method'], path: string, handler: Handler) {
      if (!routes.some((route) => route.method === method && route.path === path)) throw new Error('Unknown route');
      handlers.set(`${method} ${path}`, handler);
    },
    listen(port: number): Promise<AddressInfo> { return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server.address() as AddressInfo); }); }); },
    close(): Promise<void> {
      for (const stream of streams) stream.abort();
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
