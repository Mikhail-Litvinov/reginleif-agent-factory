import type { ApiResult, JsonValue, ProgressEvent } from "../output.js";
import type { RuntimePorts } from "../ports.js";

import { apiFail, apiOk, ERROR_CODE_USAGE } from "../output.js";
import { messagesFor } from "../messages.js";
import { compactSessionCore, lookupSessionForCommand } from "../session-core.js";

export const compactSession = async (runtime: RuntimePorts, args: readonly string[], progress: (event: ProgressEvent) => void): Promise<ApiResult<JsonValue>> => {
	const usage = messagesFor(runtime.language).session.usageCompact();
	if (args.length !== 1 && (args.length < 3 || args[1] !== "--instructions")) return apiFail(ERROR_CODE_USAGE, usage);
	if (args.length > 1 && (args[1] !== "--instructions" || args.length < 3)) return apiFail(ERROR_CODE_USAGE, usage);
	const id = args[0];
	if (id === undefined) return apiFail(ERROR_CODE_USAGE, usage);
	const instructions = args.length > 1 ? args.slice(2).join(" ") : undefined;
	const session = await lookupSessionForCommand(runtime, id, true);
	if (!session.ok) return session;
	const result = await compactSessionCore(runtime, session.value, instructions, progress);
	if (!result.ok) return result;
	return apiOk({ session: id, ...result.value });
};
