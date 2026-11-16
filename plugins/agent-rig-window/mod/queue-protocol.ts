// Queue identifiers and wire shapes shared by rig and the window.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const REQUEST_SUFFIX = ".json";
// A request is claimed by making the directory claims/<id> (the one atomic step the engine offers: mkdir fails on an
// existing directory); the claimant rewrites claims/<id>/beat (epoch milliseconds) on each module poll while the request
// is unanswered. Rig treats a beat older than CLAIM_STALE_MS as a dead claimant. The beat comes every 1 s (the module's
// poll), so one minute is sixty missed polls, long enough for a busy engine and short against a ten-minute wait.
export const CLAIMS_DIR = "claims";
export const CLAIM_BEAT_FILE = "beat";
export const CLAIM_STALE_MS = 60_000;
export const OPS = ["compact", "rename", "autocompact", "usage", "mode"] as const;
export type Op = (typeof OPS)[number];
export type Args = Record<string, unknown>;
export type Request = { id: string; op: Op; args: Args };
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
export type Response = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export function isOp(v: unknown): v is Op { return OPS.some((op) => op === v); }
export function idOfFile(name: string): string | undefined {
	if (!name.endsWith(REQUEST_SUFFIX)) return undefined;
	const id = name.slice(0, -REQUEST_SUFFIX.length);
	return ID_PATTERN.test(id) ? id : undefined;
}
export function parseRequest(fileId: string, text: string): Parsed<Request> {
	let body: unknown;
	try { body = JSON.parse(text); } catch { return { ok: false, error: "the request is not valid JSON" }; }
	if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "the request is not a JSON object" };
	if (!("id" in body) || body.id !== fileId) return { ok: false, error: "the request id differs from its file name" };
	if (!("op" in body) || !isOp(body.op)) return { ok: false, error: `unknown op: ${String("op" in body ? body.op : undefined)}` };
	const args = "args" in body ? body.args ?? {} : {};
	if (!isRecord(args)) return { ok: false, error: "args is not an object" };
	return { ok: true, value: { id: fileId, op: body.op, args } };
}
export function responseText(response: Response): string { return JSON.stringify(response); }
