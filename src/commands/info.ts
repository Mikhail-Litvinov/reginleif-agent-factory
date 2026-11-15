import type { ClaudeLimits, ContextReading, Limit, Source, VolunteerReading } from "../info-text.js";
import type { Messages } from "../messages.js";
import type { RigState } from "../state.js";
import type { Result } from "../result.js";
import type { RuntimePorts } from "../ports.js";

import { readCodexLimits } from "../codex-rollout.js";
import { joinPath } from "../file-system.js";
import { formatInfo } from "../info-text.js";
import { messagesFor } from "../messages.js";
import { PROCESS_SUCCESS_EXIT_CODE } from "../ports.js";
import { err, ok } from "../result.js";
import { readRigState } from "./shared.js";

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MS_PER_SECOND = 1000;
const ACCOUNT_SCRIPT = "base/tools/account-allowlist.py";
const VOLUNTEER_TOOLS_DIRECTORY = "features/volunteers/tools";
const VOLUNTEER_SCRIPT = "volunteer-models.py";
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
	openrouter: "OpenRouter",
	requesty: "Requesty",
	groq: "Groq",
	zhipu: "Zhipu",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const numberOrUndefined = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const parseJson = (text: string): unknown => {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

type Usage = { at: number | null; limits: Limit[]; context: ContextReading };

const parseLimit = (value: unknown): Limit | null => {
	if (!isRecord(value) || typeof value.kind !== "string") return null;
	const percent = numberOrUndefined(value.percentUsed);
	if (percent === undefined) return null;
	const resetsAt = typeof value.resetsAt === "string" ? Date.parse(value.resetsAt) : Number.NaN;
	return { kind: value.kind, percent, resetsAt: Number.isFinite(resetsAt) ? resetsAt : null };
};

const parseUsage = (text: string): Usage | null => {
	const value = parseJson(text);
	if (!isRecord(value)) return null;
	const at = typeof value.at === "string" ? Date.parse(value.at) : Number.NaN;
	const limits = Array.isArray(value.rateLimits)
		? value.rateLimits.flatMap((entry: unknown) => {
			const limit = parseLimit(entry);
			return limit === null ? [] : [limit];
		})
		: [];
	const context = isRecord(value.context) ? value.context : {};
	const breakdown = isRecord(context.breakdown) ? context.breakdown : {};
	return {
		at: Number.isFinite(at) ? at : null,
		limits,
		context: {
			tokens: numberOrUndefined(context.tokens),
			totalTokens: numberOrUndefined(breakdown.totalTokens),
			autoCompactEnabled: breakdown.isAutoCompactEnabled === true,
			autoCompactThreshold: numberOrUndefined(breakdown.autoCompactThreshold),
		},
	};
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
	const result = await runtime.process.run(runtime.pythonCommand, ["-I", joinPath(state.paths.repo, ACCOUNT_SCRIPT), ...args]);
	if (!result.ok || result.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) return null;
	const parsed = parseJson(result.value.stdout.trim());
	return isRecord(parsed) ? parsed : null;
};

const accountOf = async (runtime: RuntimePorts, state: RigState, configDir: string): Promise<number | null> => {
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

// The hub's rule: the limits belong to the account, so the freshest reading among the sessions of the same account
// wins. An account that cannot be determined means only this session's own reading.
const freshestClaudeLimits = async (
	runtime: RuntimePorts,
	state: RigState,
	sessionId: string,
	configDir: string,
	own: Usage | null,
): Promise<ClaudeLimits | null> => {
	const candidates: Usage[] = own === null ? [] : [own];
	const account = await accountOf(runtime, state, configDir);
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
			if (accountByDirectory.get(otherDirectory) === account) candidates.push(usage);
		}
	}
	let best: Usage | null = null;
	for (const usage of candidates) {
		if (usage.limits.length === 0) continue;
		if (best === null || (usage.at ?? Number.NEGATIVE_INFINITY) > (best.at ?? Number.NEGATIVE_INFINITY)) best = usage;
	}
	return best === null ? null : { at: best.at, limits: best.limits };
};

const codexSource = async (runtime: RuntimePorts, messages: Messages): Promise<Source<{ at: number; limits: Limit[] }>> => {
	const reading = await readCodexLimits(runtime.fs, joinPath(runtime.home, ".codex"));
	return reading === null ? { kind: "error", reason: messages.info.noCodexRollout() } : { kind: "ok", value: reading };
};

const parseVolunteerOutput = (value: unknown, messages: Messages): Source<VolunteerReading> => {
	if (!isRecord(value)) return { kind: "error", reason: messages.info.scriptBadJson() };
	if (value.source === "none") {
		return { kind: "error", reason: typeof value.error === "string" && value.error !== "" ? value.error : messages.info.noSource() };
	}
	const at = typeof value.checked_at === "string" ? Date.parse(value.checked_at) : Number.NaN;
	const dayPercent = numberOrUndefined(value.day_percent);
	if (!Number.isFinite(at) || dayPercent === undefined) return { kind: "error", reason: messages.info.scriptBadJson() };
	const resetIn = numberOrUndefined(value.reset_in_s);
	const providers: VolunteerReading["providers"] = [];
	if (isRecord(value.providers)) {
		for (const [key, entry] of Object.entries(value.providers)) {
			if (!isRecord(entry)) continue;
			const used = numberOrUndefined(entry.used);
			const cap = numberOrUndefined(entry.cap);
			if (used !== undefined && cap !== undefined) providers.push({ name: PROVIDER_NAMES[key] ?? key, used, cap });
		}
	}
	return { kind: "ok", value: { at, dayPercent, resetsAt: resetIn === undefined ? null : at + resetIn * MS_PER_SECOND, providers } };
};

const volunteerSource = async (runtime: RuntimePorts, state: RigState, messages: Messages): Promise<Source<VolunteerReading>> => {
	const toolsDirectory = joinPath(state.paths.repo, VOLUNTEER_TOOLS_DIRECTORY);
	let present = false;
	try {
		present = (await runtime.fs.listDirectory(toolsDirectory)).some((entry) => entry.name === VOLUNTEER_SCRIPT);
	} catch {
		present = false;
	}
	if (!present) return { kind: "error", reason: messages.info.scriptMissing() };
	const result = await runtime.process.run(runtime.pythonCommand, ["-I", joinPath(toolsDirectory, VOLUNTEER_SCRIPT), "limits", "--json"]);
	if (!result.ok) return { kind: "error", reason: result.error };
	if (result.value.exitCode !== PROCESS_SUCCESS_EXIT_CODE) {
		return { kind: "error", reason: messages.info.scriptExit(result.value.exitCode, result.value.stderr.trim()) };
	}
	const parsed = parseJson(result.value.stdout);
	return parseVolunteerOutput(parsed, messages);
};

// `rig info --session <id>`: the finished text of the hub's /info, in rig's language. Every source is read on its own
// and a failing one only turns its block into a "no data" line; only an unknown session fails the command.
export const infoCommand = async (runtime: RuntimePorts, sessionId: string, writeLine: (line: string) => void): Promise<Result<void>> => {
	const messages = messagesFor(runtime.language);
	if (!SAFE_SESSION_ID.test(sessionId) || sessionId.includes("..")) return err(messages.info.badSession(sessionId));
	const stateResult = await readRigState(runtime);
	if (!stateResult.ok) return stateResult;
	const state = stateResult.value;
	const recordText = await readOptionalText(runtime, joinPath(sessionsDirectory(runtime), `${sessionId}.json`));
	if (recordText === null) return err(messages.info.unknownSession(sessionId));
	const record = parseJson(recordText);
	if (!isRecord(record)) return err(messages.info.unknownSession(sessionId));
	const configDir = typeof record.config_dir === "string" ? record.config_dir : "";
	const usageText = await readOptionalText(runtime, joinPath(sessionsDirectory(runtime), sessionId, "usage.json"));
	const own = usageText === null ? null : parseUsage(usageText);
	const claude = await freshestClaudeLimits(runtime, state, sessionId, configDir, own);
	const codex = await categoryShown(runtime, state, "codex", configDir) ? await codexSource(runtime, messages) : null;
	const volunteers = await categoryShown(runtime, state, "volunteers", configDir) ? await volunteerSource(runtime, state, messages) : null;
	writeLine(formatInfo({ claude, codex, volunteers, context: own === null ? null : own.context }, runtime.clock.now().getTime(), messages));
	return ok(undefined);
};
