import type { ApiResult, JsonValue, ProgressEvent } from "../output.js";
import type { RuntimePorts } from "../ports.js";

import { listSessions } from "../session-core.js";
import { lookupSessionForCommand } from "../session-core.js";
import { apiFail, ERROR_CODE_USAGE } from "../output.js";
import { messagesFor } from "../messages.js";
import { cleanupSession } from "./session-cleanup.js";
import { compactSession } from "./session-compact.js";
import { renameSession } from "./session-rename.js";
import { stopSession } from "./session-stop.js";
import { modeCommand, runCommand } from "./session-run.js";

// A subcommand gets every argument after its name and parses them itself (ids, names, flags).
export type SessionHandler = (runtime: RuntimePorts, args: readonly string[], progress: (event: ProgressEvent) => void) => Promise<ApiResult<JsonValue>>;
export const SESSION_COMMANDS: Record<string, SessionHandler> = { list: (runtime) => listSessions(runtime), stop: async (runtime, args, progress) => {
	if (args.length !== 1) return apiFail(ERROR_CODE_USAGE, messagesFor(runtime.language).session.usageStop());
	const session = await lookupSessionForCommand(runtime, args[0], false);
	return session.ok ? stopSession(runtime, session.value, progress) : session;
}, cleanup: async (runtime, args, progress) => {
	if (args.length !== 1) return apiFail(ERROR_CODE_USAGE, messagesFor(runtime.language).session.usageCleanup());
	const session = await lookupSessionForCommand(runtime, args[0], true);
	return session.ok ? cleanupSession(runtime, session.value, progress) : session;
}, compact: compactSession, rename: renameSession, run: runCommand, mode: modeCommand };
export const isSessionCommand = (name: string): boolean => Object.hasOwn(SESSION_COMMANDS, name);
export const runSessionCommand = (runtime: RuntimePorts, name: string, args: readonly string[], progress: (event: ProgressEvent) => void): Promise<ApiResult<JsonValue>> => SESSION_COMMANDS[name](runtime, args, progress);
