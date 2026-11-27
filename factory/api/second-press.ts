import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Repo } from '../db/repo/index.ts';
import type { HandlerContext } from './server.ts';

type Store = Pick<Repo, 'confirmations'>;
type Issuer = Store & Pick<Repo, 'settings'>;
export type ConfirmationScope = { actorId: string; channel: string; deviceSessionId: string | null; operation: string; targetType: string; targetId: string; requestHash: string };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const requestHash = hash;
export const canonicalJson = (value: unknown): string => {
  if (value === null || value === undefined || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
};
export function confirmationHeader(context: HandlerContext): string | undefined {
  const value = context.request.headers['x-confirm'];
  return typeof value === 'string' ? value : undefined;
}
export class ConfirmationSettingError extends Error {}
export async function confirmationWindow(repo: Pick<Repo, 'settings'>): Promise<number> {
  const value = (await repo.settings.snapshot(['confirm.windowSeconds']))['confirm.windowSeconds'];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new ConfirmationSettingError('Invalid confirm.windowSeconds');
  return value;
}
export async function issueConfirmation(tx: Issuer, scope: ConfirmationScope, now: Date) {
  const id = randomUUID(), nonce = randomBytes(32).toString('base64url');
  const windowSeconds = await confirmationWindow(tx);
  const expiresAt = new Date(now.getTime() + windowSeconds * 1000);
  await tx.confirmations.create({ id, ...scope, nonceHash: hash(nonce), issuedAt: now, expiresAt });
  return { code: 'confirmation_required' as const, confirmation_id: id, nonce, expires_at: expiresAt.toISOString() };
}
export async function confirmationId(tx: Store, token: string): Promise<string | undefined> {
  const match = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.([A-Za-z0-9_-]+)$/i.exec(token);
  if (!match) return undefined;
  const row = await tx.confirmations.get(match[1]!);
  const expected = row?.nonceHash, actual = hash(match[2]!);
  if (!expected || expected.length !== actual.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) return undefined;
  return match[1];
}
export async function verifyConfirmation(tx: Store, token: string, scope: ConfirmationScope, now: Date, decisionId?: string): Promise<string | undefined> {
  const id = await confirmationId(tx, token);
  if (!id) return undefined;
  return await tx.confirmations.consume({ id, ...scope, now, decisionId }) ? id : undefined;
}
export async function secondPress(tx: Issuer, context: HandlerContext, input: { actorId: string; operation: string; targetType: string; targetId: string; requestHash: string; now: Date; channel?: string; deviceSessionId?: string | null }) {
  const { now, ...rest } = input;
  const scope = { ...rest, channel: rest.channel ?? 'api', deviceSessionId: rest.deviceSessionId ?? null };
  const header = confirmationHeader(context);
  if (header === undefined) return { status: 409, body: await issueConfirmation(tx, scope, now) };
  if (!await verifyConfirmation(tx, header, scope, now)) return { status: 409, body: { code: 'confirmation_invalid' } };
}
