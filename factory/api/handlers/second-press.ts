import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Repo } from '../../db/repo/index.ts';
import type { HandlerContext } from '../server.ts';
import { response } from './shared.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export const canonicalJson = (value: unknown): string => {
  if (value === null || value === undefined || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
};
export const requestHash = (value: string) => hash(value);

export type SecondPressInput = {
  actorId: string; operation: string; targetType: string; targetId: string; requestHash: string; now: Date; windowSeconds: number;
};

/**
 * The D23 second press for an API request (api.md "Second press"): without `X-Confirm` it records a confirmations row
 * and answers `409 confirmation_required`; with it the row is checked (nonce, actor, channel, operation, target, request
 * hash) and consumed once. Returns undefined when the press is valid, otherwise the response to send. Run it inside the
 * transaction of the change so a consumed press and the change commit together.
 */
export async function secondPress(tx: Pick<Repo, 'confirmations'>, context: HandlerContext, input: SecondPressInput) {
  const header = context.request.headers['x-confirm'];
  const scope = { actorId: input.actorId, channel: 'api' as const, deviceSessionId: null, operation: input.operation, targetType: input.targetType, targetId: input.targetId, requestHash: input.requestHash };
  if (typeof header !== 'string') {
    const id = randomUUID();
    const nonce = randomBytes(32).toString('base64url');
    const expiresAt = new Date(input.now.getTime() + input.windowSeconds * 1000);
    await tx.confirmations.create({ id, ...scope, nonceHash: hash(nonce), issuedAt: input.now, expiresAt });
    return response(409, { code: 'confirmation_required', confirmation_id: id, nonce, expires_at: expiresAt.toISOString() });
  }
  const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]+)$/i.exec(header);
  if (!match) return response(409, { code: 'confirmation_invalid' });
  const confirmation = await tx.confirmations.get(match[1]!);
  const expected = confirmation?.nonceHash;
  const actual = hash(match[2]!);
  const nonceMatches = !!expected && expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  if (!nonceMatches || !await tx.confirmations.consume({ id: match[1]!, ...scope, now: input.now })) return response(409, { code: 'confirmation_invalid' });
  return undefined;
}
