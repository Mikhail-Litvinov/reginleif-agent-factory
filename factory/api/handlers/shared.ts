import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { Route } from '../../contracts/routes.ts';
import type { Repo } from '../../db/repo/index.ts';
import type { HandlerContext } from '../server.ts';
import { MAX_PAGE_LIMIT } from './settings.ts';

export type HandlerRegistrar = { register(method: Route['method'], path: string, handler: (context: HandlerContext) => Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>): void };
export type HandlerDeps = { repo: Repo; queueGatewayEnabled?: boolean; now?: () => Date };
export type Row = Record<string, any>;

export const response = (status: number, body?: unknown, headers?: Record<string, string>) => ({ status, body, headers });
export const apiRow = (row: Row): Row => Object.fromEntries(Object.entries(row).filter(([key]) => {
  if (key === 'tokenHash' || key === 'commitXid' || key === 'requestHash') return false;
  if (key === 'updatedAt' && 'prefix' in row && 'role' in row) return false;
  return true;
}).map(([key, value]) => {
  const name = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  const output = value instanceof Date ? value.toISOString() : typeof value === 'bigint' ? Number(value) : value;
  return [name, output];
}));
export const apiRows = (rows: Row[]) => rows.map(apiRow);
export const query = (context: HandlerContext) => new URL(context.request.url ?? '/', 'http://localhost').searchParams;
export const positiveInt = (value: string | null, fallback: number, max = MAX_PAGE_LIMIT) => {
  if (value === null) return fallback;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};
export const version = (context: HandlerContext) => {
  const value = context.request.headers['if-match'];
  if (!value) return undefined;
  const parsed = /^(?:W\/)?"?(\d+)"?$/.exec(value);
  return parsed ? BigInt(parsed[1]!) : undefined;
};
export const asObject = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};

export const secretToken = () => {
  const prefix = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  return { prefix, secret, tokenHash: createHash('sha256').update(secret).digest('hex') };
};
export const id = () => randomUUID();
export async function writeAudit(tx: Pick<Repo, 'audit'>, context: HandlerContext, action: string, targetType: string, targetId: string | null, outcome: string, request: unknown): Promise<void> {
  const requestHash = createHash('sha256').update(JSON.stringify([context.request.method, context.request.url, request])).digest('hex');
  await tx.audit.append({ id: id(), actorId: context.identity?.ownerId ?? context.identity?.id ?? null,
    tokenId: context.identity?.id ?? null, deviceSessionId: null, requestId: context.requestId, action, targetType, targetId,
    outcome, requestHash, details: { route: context.route.path } });
}
