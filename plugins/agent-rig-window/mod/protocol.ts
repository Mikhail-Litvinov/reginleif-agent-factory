// The shapes and the pure parts of the files rig and the window exchange under ~/.agent-rig/sessions/<id>/.
// See docs/superpowers/specs/rig-sessions-design.md. Nothing here touches the engine.
import type { SessionContextUsage, SessionCost, SessionRateLimit } from "claude-code";

export * from "./queue-protocol.js";

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
