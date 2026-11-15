import type { BlockError, ClaudeLimit, ClaudeReading, CodexReading, ContextReading, InfoData, VolunteerProvider, VolunteerReading } from "../info-data.js";
import type { Messages } from "../messages.js";
import type { ApiResult } from "../output.js";
import type { RigState } from "../state.js";
import type { RuntimePorts } from "../ports.js";

import { readCodexLimits } from "../codex-rollout.js";
import { joinPath, toSlashPath } from "../file-system.js";
import { isoOrNull } from "../info-data.js";
import { messagesFor } from "../messages.js";
import { apiFail, apiOk } from "../output.js";
import { PROCESS_SUCCESS_EXIT_CODE } from "../ports.js";
import { readRigState } from "./shared.js";

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MS_PER_SECOND = 1000;
// A python helper that hangs must not hang `rig info`; the hub gave the volunteer script the same 5 s (volunteerLimitsTimeoutMs).
const HELPER_TIMEOUT_MS = 5 * MS_PER_SECOND;
const CODEX_HOME_VARIABLE = "CODEX_HOME";
const ACCOUNT_SCRIPT = "base/tools/account-allowlist.py";
const VOLUNTEER_TOOLS_DIRECTORY = "features/volunteers/tools";
const VOLUNTEER_SCRIPT = "volunteer-models.py";

// Failure codes of `rig info`: a command-level failure fails the whole command, a block-level one fills only its block.
export const INFO_ERROR_BAD_SESSION = "bad-session";
export const INFO_ERROR_UNKNOWN_SESSION = "unknown-session";
export const INFO_ERROR_STATE_UNREADABLE = "state-unreadable";
const BLOCK_NO_DATA = "no-data";
const BLOCK_NO_ROLLOUT = "no-rollout";
const BLOCK_SCRIPT_MISSING = "script-missing";
const BLOCK_SCRIPT_FAILED = "script-failed";
const BLOCK_BAD_OUTPUT = "bad-output";
const BLOCK_NO_SOURCE = "no-source";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const numberOrUndefined = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const numberOrNull = (value: unknown): number | null => numberOrUndefined(value) ?? null;

const parseJson = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

const blockError = (code: string, message: string): BlockError => ({ error: { code, message } });

const isoText = (value: unknown): string | null => {
	if (typeof value !== "string") return null;
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) ? isoOrNull(milliseconds) : null;
};

// One usage.json, as the output carries it.
type Usage = { at: string | null; limits: ClaudeLimit[]; context: ContextReading | null };

const parseLimit = (value: unknown): ClaudeLimit | null => {
	if (!isRecord(value) || typeof value.kind !== "string") return null;
	const percentUsed = numberOrUndefined(value.percentUsed);
	if (percentUsed === undefined) return null;
	return { kind: value.kind, percentUsed, resetsAt: isoText(value.resetsAt) };
};

// `tokens` is the exact count; without it the breakdown's total is an estimate.
const parseContext = (value: Record<string, unknown>, at: string | null): ContextReading | null => {
	const context = isRecord(value.context) ? value.context : {};
	const breakdown = isRecord(context.breakdown) ? context.breakdown : {};
	const exact = numberOrUndefined(context.tokens);
	const tokens = exact ?? numberOrUndefined(breakdown.totalTokens);
	if (tokens === undefined) return null;
	const threshold = numberOrUndefined(breakdown.autoCompactThreshold);
	return {
		at,
		tokens,
		window: numberOrNull(context.window),
		...(threshold === undefined ? {} : { threshold }),
		...(typeof breakdown.isAutoCompactEnabled === "boolean" ? { autocompact: breakdown.isAutoCompactEnabled } : {}),
		...(exact === undefined ? { estimated: true as const } : {}),
	};
};

const parseUsage = (text: string): Usage | null => {
	const value = parseJson(text);
	if (!isRecord(value)) return null;
	const at = isoText(value.at);
	const limits = Array.isArray(value.rateLimits)
		? value.rateLimits.flatMap((entry: unknown) => {
			const limit = parseLimit(entry);
			return limit === null ? [] : [limit];
		})
		: [];
	return { at, limits, context: parseContext(value, at) };
};

const readOptionalText = async (runtime: RuntimePorts, path: string): Promise<string | null> => {
	try {
		return await runtime.fs.readText(path);
	} catch {
		return null;
	}
};

// Runs a subcommand of the shared allowlist tool and returns its one JSON line; null on any failure.
const runAllowlistTool = async (runtime: RuntimePorts, state: RigState, args: readonly string[]): Promise<Record<string, unknown> | null> => {
	const result = await runtime.process.run(runtime.pythonCommand, ["-I", joinPath(state.paths.repo, ACCOUNT_SCRIPT), ...args], { timeoutMs: HELPER_TIMEOUT_MS });
	if (!result.ok || result.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) return null;
	const parsed = parseJson(result.value.stdout.trim());
	return isRecord(parsed) ? parsed : null;
};

export const accountOf = async (runtime: RuntimePorts, state: RigState, configDir: string): Promise<number | null> => {
	const answer = await runAllowlistTool(runtime, state, ["account", "--config-dir", configDir]);
	const account = answer?.account;
	return typeof account === "number" ? account : null;
};

// The feature must be on in rig state and the allowlist must accept this session's account. A check that cannot run hides the block.
const categoryShown = async (runtime: RuntimePorts, state: RigState, category: "codex" | "volunteers", configDir: string): Promise<boolean> => {
	if (state.features[category] !== true) return false;
	const answer = await runAllowlistTool(runtime, state, ["check", category, "--config-dir", configDir]);
	return answer?.allowed === true;
};

const sessionsDirectory = (runtime: RuntimePorts): string => joinPath(runtime.home, ".agent-rig", "sessions");

const sessionIdsWithRecords = async (runtime: RuntimePorts): Promise<string[]> => {
	try {
		const entries = await runtime.fs.listDirectory(sessionsDirectory(runtime));
		return entries
			.filter((entry) => !entry.directory && entry.name.endsWith(".json"))
			.map((entry) => entry.name.slice(0, -".json".length))
			.filter((id) => SAFE_SESSION_ID.test(id) && !id.includes(".."));
	} catch {
		return [];
	}
};

const readingTime = (usage: Usage): number => usage.at === null ? Number.NEGATIVE_INFINITY : Date.parse(usage.at);

// The limits belong to the account, so the freshest reading among the sessions of the same account wins. An account
// that cannot be determined means only this session's own reading.
const freshestClaudeLimits = async (
	runtime: RuntimePorts,
	state: RigState,
	sessionId: string,
	configDir: string,
	account: number | null,
	own: Usage | null,
): Promise<ClaudeReading | null> => {
	const candidates: Array<{ sessionId: string; usage: Usage }> = own === null ? [] : [{ sessionId, usage: own }];
	if (account !== null) {
		const accountByDirectory = new Map<string, number | null>([[configDir, account]]);
		for (const id of await sessionIdsWithRecords(runtime)) {
			if (id === sessionId) continue;
			const usageText = await readOptionalText(runtime, joinPath(sessionsDirectory(runtime), id, "usage.json"));
			const usage = usageText === null ? null : parseUsage(usageText);
			if (usage === null || usage.limits.length === 0) continue;
			const recordText = await readOptionalText(runtime, joinPath(sessionsDirectory(runtime), `${id}.json`));
			const record = recordText === null ? undefined : parseJson(recordText);
			const otherDirectory = isRecord(record) && typeof record.config_dir === "string" ? record.config_dir : "";
			if (!accountByDirectory.has(otherDirectory)) accountByDirectory.set(otherDirectory, await accountOf(runtime, state, otherDirectory));
			if (accountByDirectory.get(otherDirectory) === account) candidates.push({ sessionId: id, usage });
		}
	}
	let best: { sessionId: string; usage: Usage } | null = null;
	for (const candidate of candidates) {
		if (candidate.usage.limits.length === 0) continue;
		if (best === null || readingTime(candidate.usage) > readingTime(best.usage)) best = candidate;
	}
	return best === null ? null : { at: best.usage.at, sessionId: best.sessionId, limits: best.usage.limits };
};

const codexBlock = async (runtime: RuntimePorts, messages: Messages): Promise<CodexReading | BlockError> => {
	const codexHome = runtime.environment.get(CODEX_HOME_VARIABLE);
	const reading = await readCodexLimits(runtime.fs, codexHome === undefined || codexHome === "" ? joinPath(runtime.home, ".codex") : toSlashPath(codexHome));
	return reading === null ? blockError(BLOCK_NO_ROLLOUT, messages.info.noCodexRollout()) : reading;
};

const parseProviders = (value: unknown): Record<string, VolunteerProvider> => {
	const providers: Record<string, VolunteerProvider> = {};
	if (!isRecord(value)) return providers;
	for (const [name, entry] of Object.entries(value)) {
		if (!isRecord(entry)) continue;
		const used = numberOrUndefined(entry.used);
		if (used !== undefined) providers[name] = { used, cap: numberOrNull(entry.cap) };
	}
	return providers;
};

const parseVolunteerOutput = (value: unknown, messages: Messages): VolunteerReading | BlockError => {
	if (!isRecord(value)) return blockError(BLOCK_BAD_OUTPUT, messages.info.scriptBadJson());
	if (value.source === "none") {
		return blockError(BLOCK_NO_SOURCE, typeof value.error === "string" && value.error !== "" ? value.error : messages.info.noSource());
	}
	const at = isoText(value.checked_at);
	const dayPercent = numberOrUndefined(value.day_percent);
	if (at === null || dayPercent === undefined || typeof value.source !== "string") return blockError(BLOCK_BAD_OUTPUT, messages.info.scriptBadJson());
	const resetIn = numberOrUndefined(value.reset_in_s);
	return {
		at,
		source: value.source,
		dayPercent,
		used: numberOrNull(value.used),
		cap: numberOrNull(value.cap),
		resetsAt: resetIn === undefined ? null : isoOrNull(Date.parse(at) + resetIn * MS_PER_SECOND),
		providers: parseProviders(value.providers),
	};
};

const volunteerBlock = async (runtime: RuntimePorts, state: RigState, messages: Messages): Promise<VolunteerReading | BlockError> => {
	const toolsDirectory = joinPath(state.paths.repo, VOLUNTEER_TOOLS_DIRECTORY);
	let present = false;
	try {
		present = (await runtime.fs.listDirectory(toolsDirectory)).some((entry) => entry.name === VOLUNTEER_SCRIPT);
	} catch {
		present = false;
	}
	if (!present) return blockError(BLOCK_SCRIPT_MISSING, messages.info.scriptMissing());
	const result = await runtime.process.run(runtime.pythonCommand, ["-I", joinPath(toolsDirectory, VOLUNTEER_SCRIPT), "limits", "--json"], { timeoutMs: HELPER_TIMEOUT_MS });
	if (!result.ok) return blockError(BLOCK_SCRIPT_FAILED, result.error);
	if (result.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) {
		return blockError(BLOCK_SCRIPT_FAILED, messages.info.scriptExit(result.value.exitCode, result.value.stderr.trim()));
	}
	return parseVolunteerOutput(parseJson(result.value.stdout), messages);
};

// `rig info --session <id>`: the raw readings behind the hub's /info. Every source is read on its own and a failing one
// only fills its block with an error; only a bad or unknown session, or unreadable rig state, fails the command.
export const infoCommand = async (runtime: RuntimePorts, sessionId: string): Promise<ApiResult<InfoData>> => {
	const messages = messagesFor(runtime.language);
	if (!SAFE_SESSION_ID.test(sessionId) || sessionId.includes("..")) return apiFail(INFO_ERROR_BAD_SESSION, messages.info.badSession(sessionId));
	const stateResult = await readRigState(runtime);
	if (!stateResult.ok) return apiFail(INFO_ERROR_STATE_UNREADABLE, stateResult.error);
	const state = stateResult.value;
	const recordText = await readOptionalText(runtime, joinPath(sessionsDirectory(runtime), `${sessionId}.json`));
	const record = recordText === null ? undefined : parseJson(recordText);
	if (!isRecord(record)) return apiFail(INFO_ERROR_UNKNOWN_SESSION, messages.info.unknownSession(sessionId));
	const configDir = typeof record.config_dir === "string" ? record.config_dir : "";
	const usageText = await readOptionalText(runtime, joinPath(sessionsDirectory(runtime), sessionId, "usage.json"));
	const own = usageText === null ? null : parseUsage(usageText);
	const account = await accountOf(runtime, state, configDir);
	const claude = await freshestClaudeLimits(runtime, state, sessionId, configDir, account, own);
	const codex = await categoryShown(runtime, state, "codex", configDir) ? await codexBlock(runtime, messages) : null;
	const volunteers = await categoryShown(runtime, state, "volunteers", configDir) ? await volunteerBlock(runtime, state, messages) : null;
	return apiOk({
		session: sessionId,
		account,
		claude: claude ?? blockError(BLOCK_NO_DATA, messages.info.claudeNoData()),
		...(codex === null ? {} : { codex }),
		...(volunteers === null ? {} : { volunteers }),
		context: own?.context ?? blockError(BLOCK_NO_DATA, messages.info.noContextData()),
	});
};
