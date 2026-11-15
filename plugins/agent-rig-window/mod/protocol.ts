// The shapes and the pure parts of the files rig and the window exchange under ~/.agent-rig/sessions/<id>/.
// See docs/superpowers/specs/rig-sessions-design.md. Nothing here touches the engine.
import type { SessionContextUsage, SessionCost, SessionRateLimit } from "claude-code";

// A request id becomes a file name, so it is a short run of safe characters and nothing else.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const REQUEST_SUFFIX = ".json";
export const OPS = ["compact", "rename", "usage", "mode"] as const;

export type Op = (typeof OPS)[number];
export type Args = Record<string, unknown>;
export type Request = { id: string; op: Op; args: Args };
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

// The part of the engine's SessionUsage a snapshot keeps (the hub reads the same fields for /info).
export type Usage = {
  context: SessionContextUsage;
  rateLimits: SessionRateLimit[];
  cost?: SessionCost;
};

// usage.json: `rateLimits` is the last session.measure reading, as the hub reads it.
export type UsageSnapshot = {
  at: string;
  context: SessionContextUsage;
  rateLimits: SessionRateLimit[];
  cost?: SessionCost;
};

export type Response = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };

export function isOp(v: unknown): v is Op {
  return OPS.some(op => op === v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// The id a request file name carries, or undefined when the name is not a request file with a safe id.
export function idOfFile(name: string): string | undefined {
  if (!name.endsWith(REQUEST_SUFFIX)) return undefined;
  const id = name.slice(0, -REQUEST_SUFFIX.length);
  return ID_PATTERN.test(id) ? id : undefined;
}

// The text of request file `<fileId>.json`. The file name is the id answered to; a body id that differs is an error.
export function parseRequest(fileId: string, text: string): Parsed<Request> {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: "the request is not valid JSON" };
  }
  if (!isRecord(body)) return { ok: false, error: "the request is not a JSON object" };
  if (body.id !== fileId) return { ok: false, error: "the request id differs from its file name" };
  if (!isOp(body.op)) return { ok: false, error: `unknown op: ${String(body.op)}` };
  const args = body.args ?? {};
  if (!isRecord(args)) return { ok: false, error: "args is not an object" };
  return { ok: true, value: { id: fileId, op: body.op, args } };
}

export function responseText(response: Response): string {
  return JSON.stringify(response);
}

// The shell-free commands that replace a file atomically and delete one: the engine's $.fs has neither.
export function moveCommand(isWindows: boolean, from: string, to: string): string[] {
  return isWindows ? ["cmd", "/c", "move", "/Y", toWindows(from), toWindows(to)] : ["mv", "-f", from, to];
}

export function removeCommand(isWindows: boolean, path: string): string[] {
  return isWindows ? ["cmd", "/c", "del", "/F", "/Q", toWindows(path)] : ["rm", "-f", path];
}

function toWindows(path: string): string {
  return path.replaceAll("/", "\\");
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
