import type { ApiResult, JsonValue } from "../output.js";
import type { RuntimePorts } from "../ports.js";

import { listSessions } from "../session-core.js";

type SessionHandler = (runtime: RuntimePorts) => Promise<ApiResult<JsonValue>>;
export const SESSION_COMMANDS: Record<string, SessionHandler> = { list: listSessions };
export const isSessionCommand = (name: string): boolean => Object.hasOwn(SESSION_COMMANDS, name);
export const runSessionCommand = (runtime: RuntimePorts, name: string): Promise<ApiResult<JsonValue>> => SESSION_COMMANDS[name](runtime);
