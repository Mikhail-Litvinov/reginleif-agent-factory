import type { ApiResult, JsonValue, ProgressEvent } from "../output.js";
import type { RuntimePorts } from "../ports.js";

import { apiFail, apiOk, ERROR_CODE_USAGE, SESSION_BAD_RESPONSE } from "../output.js";
import { messagesFor } from "../messages.js";
import { lookupSessionForCommand, requestSession, SESSION_TIMEOUTS } from "../session-core.js";

const AUTO = "auto";
const DECIMAL_WINDOW = /^[1-9][0-9]*$/;
const ARGUMENT_COUNT = 2;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// A positive integer in decimal digits, or the literal "auto"; undefined for anything else (no "333k": the client converts).
const parseWindow = (text: string): number | typeof AUTO | undefined => {
	if (text === AUTO) return AUTO;
	if (!DECIMAL_WINDOW.test(text)) return undefined;
	const value = Number(text);
	return Number.isSafeInteger(value) ? value : undefined;
};

export const autocompactSession = async (runtime: RuntimePorts, args: readonly string[], progress: (event: ProgressEvent) => void): Promise<ApiResult<JsonValue>> => {
	const usage = messagesFor(runtime.language).session.usageAutocompact();
	const id = args[0];
	const requested = args.length === ARGUMENT_COUNT ? parseWindow(args[1]) : undefined;
	if (id === undefined || requested === undefined) return apiFail(ERROR_CODE_USAGE, usage);
	const session = await lookupSessionForCommand(runtime, id, true);
	if (!session.ok) return session;
	const result = await requestSession(runtime, session.value, "autocompact", { window: requested }, SESSION_TIMEOUTS.autocompact, progress);
	if (!result.ok) return result;
	const answer = result.value;
	if (!isObject(answer) || answer.window !== requested || (answer.text !== undefined && typeof answer.text !== "string")) return apiFail(SESSION_BAD_RESPONSE, messagesFor(runtime.language).session.badResponse());
	const value: Record<string, JsonValue> = { session: id, window: requested };
	if (answer.text !== undefined) value.text = answer.text;
	return apiOk(value);
};
