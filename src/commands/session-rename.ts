import type { ApiResult, JsonValue, ProgressEvent } from "../output.js";
import type { RuntimePorts } from "../ports.js";

import { apiFail, apiOk, ERROR_CODE_USAGE, SESSION_BAD_RESPONSE } from "../output.js";
import { messagesFor } from "../messages.js";
import { lookupSessionForCommand, requestSession, SESSION_TIMEOUTS } from "../session-core.js";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const renameSession = async (runtime: RuntimePorts, args: readonly string[], progress: (event: ProgressEvent) => void): Promise<ApiResult<JsonValue>> => {
	const usage = messagesFor(runtime.language).session.usageRename();
	const id = args[0];
	const name = args.slice(1).join(" ");
	if (id === undefined || name.trim() === "") return apiFail(ERROR_CODE_USAGE, usage);
	const session = await lookupSessionForCommand(runtime, id, true);
	if (!session.ok) return session;
	const result = await requestSession(runtime, session.value, "rename", { name }, SESSION_TIMEOUTS.rename, progress);
	if (!result.ok) return result;
	if (!isObject(result.value) || typeof result.value.name !== "string") return apiFail(SESSION_BAD_RESPONSE, messagesFor(runtime.language).session.badResponse());
	return apiOk({ session: id, name: result.value.name });
};
