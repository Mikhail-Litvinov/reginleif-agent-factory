import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type RegulationVersionState = { id: string; number: number; seenAt: number };
export type RegulationHookDependencies = {
	environment: () => Record<string, string | undefined>;
	transport: (url: string, init?: RequestInit) => Promise<Response>;
	store: {
		read: (sessionId: string) => Promise<RegulationVersionState | null>;
		write: (sessionId: string, state: RegulationVersionState) => Promise<void>;
	};
	clock: { now: () => number };
	writeStdout: (line: string) => void;
	writeStderr: (line: string) => void;
};

type HookEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse";
type HookPayload = { session_id?: unknown };
type ActiveVersion = { id: string; number: number };
type RegulationClause = Record<string, unknown>;
type RegulationChange = { clause_id?: unknown; change?: unknown; before?: unknown; after?: unknown };
type HookConfig = { baseUrl: string; token: string; projectId?: string };

class RegistryDisabled extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isVersion = (value: unknown): value is ActiveVersion => isRecord(value) && isString(value.id) && Number.isSafeInteger(value.number);
const isClauseId = (value: unknown): value is string => isString(value);
const errorLine = (error: unknown): string => {
	const message = error instanceof Error ? error.message : "unexpected error";
	return message.replace(/[\r\n\t]+/gu, " ").slice(0, 300) || "unexpected error";
};

const hookConfig = (environment: Record<string, string | undefined>): HookConfig | null => {
	const baseUrl = environment.AF_API_URL?.trim();
	const token = environment.AF_READER_TOKEN?.trim();
	if (!baseUrl || !token) return null;
	const parsed = new URL(baseUrl);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("AF_API_URL must use HTTP or HTTPS");
	return {
		baseUrl: parsed.toString().replace(/\/$/u, ""),
		token,
		...(environment.AF_PROJECT_ID?.trim() ? { projectId: environment.AF_PROJECT_ID.trim() } : {}),
	};
};

const requestJson = async (config: HookConfig, transport: RegulationHookDependencies["transport"], path: string): Promise<unknown> => {
	const url = `${config.baseUrl}/${path.replace(/^\//u, "")}`;
	const response = await transport(url, { headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json" } });
	let body: unknown;
	try { body = await response.json(); } catch { throw new Error(`Factory API returned invalid JSON (${response.status})`); }
	if (response.status === 503 && isRecord(body) && body.code === "unavailable") throw new RegistryDisabled();
	if (!response.ok) throw new Error(`Factory API request failed (${response.status})`);
	return body;
};

const activeVersion = async (config: HookConfig, transport: RegulationHookDependencies["transport"]): Promise<ActiveVersion | null> => {
	const response = await requestJson(config, transport, "regulation/versions?status=active&limit=1");
	if (!isRecord(response) || !Array.isArray(response.items)) throw new Error("Factory API returned an invalid regulation list");
	if (response.items.length === 0) return null;
	const version = response.items[0];
	if (!isVersion(version)) throw new Error("Factory API returned an invalid active regulation version");
	return version;
};

const versionDetail = async (config: HookConfig, transport: RegulationHookDependencies["transport"], versionId: string): Promise<{ clauses: unknown[] }> => {
	const response = await requestJson(config, transport, `regulation/versions/${encodeURIComponent(versionId)}`);
	if (!isRecord(response) || !Array.isArray(response.clauses)) throw new Error("Factory API returned invalid regulation clauses");
	return { clauses: response.clauses };
};

const clauseIds = (clauses: unknown[]): string[] => clauses.map((clause) => isRecord(clause) ? clause.record_id ?? clause.id : clause).filter(isClauseId);

const readClauses = async (
	config: HookConfig,
	transport: RegulationHookDependencies["transport"],
	versionId: string,
): Promise<RegulationClause[]> => {
	const details = await versionDetail(config, transport, versionId);
	const rows = await Promise.all(clauseIds(details.clauses).map(async (id) => {
		const response = await requestJson(config, transport, `registry/records/${encodeURIComponent(id)}`);
		if (!isRecord(response)) throw new Error("Factory API returned an invalid regulation clause");
		return response;
	}));
	return rows.filter((row) => row.scope_type === "global" || (config.projectId !== undefined && row.project_id === config.projectId));
};

const clauseText = (clause: RegulationClause): string => {
	const category = clause.category;
	const problem = clause.problem;
	const decision = clause.decision;
	const exceptions = clause.exceptions_text ?? clause.exceptionsText;
	const parts = [
		typeof category === "string" ? `[${category}]` : "",
		typeof problem === "string" ? problem : "",
		typeof decision === "string" ? decision : "",
		typeof exceptions === "string" && exceptions ? `Exceptions: ${exceptions}` : "",
	].filter(Boolean);
	return parts.join(" - ");
};

const sessionContext = async (
	config: HookConfig,
	transport: RegulationHookDependencies["transport"],
	version: ActiveVersion,
): Promise<string> => {
	const clauses = await readClauses(config, transport, version.id);
	return [
		`Active Factory regulation version ${version.number}:`,
		...(clauses.length > 0 ? clauses.map((clause) => `- ${clauseText(clause)}`) : ["- No active clauses apply to this session."]),
	].join("\n");
};

const changeValue = (value: unknown): RegulationClause | null => isRecord(value) ? value : null;

const differenceContext = async (
	config: HookConfig,
	transport: RegulationHookDependencies["transport"],
	previous: RegulationVersionState | null,
	current: ActiveVersion,
): Promise<string> => {
	if (!previous) {
		const clauses = await readClauses(config, transport, current.id);
		return [
			`Active Factory regulation version ${current.number}:`,
			...clauses.map((clause) => `- Added: ${clauseText(clause)}`),
		].join("\n");
	}
	const query = config.projectId === undefined ? "" : `?project_id=${encodeURIComponent(config.projectId)}`;
	const response = await requestJson(config, transport, `regulation/versions/${encodeURIComponent(previous.id)}/diff${query}`);
	if (!isRecord(response)) throw new Error("Factory API returned invalid regulation changes");
	// The route compares the active version to the requested historical version; invert each change for old-to-new delivery.
	const changes = response.changes as unknown[];
	const lines = changes.map((raw) => {
		if (!isRecord(raw)) throw new Error("Factory API returned an invalid regulation change");
		const before = changeValue(raw.before);
		const after = changeValue(raw.after);
		if (raw.change === "removed") return before ? `- Added: ${clauseText(before)}` : null;
		if (raw.change === "added") return after ? `- Removed: ${clauseText(after)}` : null;
		if (raw.change === "changed") return before || after ? `- Changed: ${clauseText(after ?? {})} -> ${clauseText(before ?? {})}` : null;
		throw new Error("Factory API returned an unknown regulation change");
	}).filter((line): line is string => line !== null);
	if (lines.length === 0) return "";
	return [`Factory regulation changed to version ${current.number} (from version ${previous.number}):`, ...lines].join("\n");
};

const emitContext = (event: HookEvent, context: string, writeStdout: RegulationHookDependencies["writeStdout"]): void => {
	if (!context) return;
	writeStdout(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: context } }));
};

export const runRegulationHook = async (
	event: HookEvent,
	payload: HookPayload,
	dependencies: RegulationHookDependencies,
): Promise<number> => {
	try {
		const config = hookConfig(dependencies.environment());
		if (!config || !isString(payload.session_id)) return 0;
		const current = await activeVersion(config, dependencies.transport);
		if (!current) return 0;
		if (event === "SessionStart") {
			const context = await sessionContext(config, dependencies.transport, current);
			await dependencies.store.write(payload.session_id, { ...current, seenAt: dependencies.clock.now() });
			emitContext(event, context, dependencies.writeStdout);
			return 0;
		}
		const previous = await dependencies.store.read(payload.session_id);
		if (previous?.id === current.id) return 0;
		const context = await differenceContext(config, dependencies.transport, previous, current);
		await dependencies.store.write(payload.session_id, { ...current, seenAt: dependencies.clock.now() });
		emitContext(event, context, dependencies.writeStdout);
		return 0;
	} catch (error) {
		if (error instanceof RegistryDisabled) return 0;
		dependencies.writeStderr(`Factory regulation hook failed open: ${errorLine(error)}`);
		return 0;
	}
};

const hookEvents = new Set<HookEvent>(["SessionStart", "UserPromptSubmit", "PreToolUse"]);
const homeDirectory = (environment: Record<string, string | undefined>): string => environment.USERPROFILE ?? environment.HOME ?? homedir();
const sessionFile = (sessionId: string, environment: Record<string, string | undefined>): string => {
	const configDirectory = environment.CLAUDE_CONFIG_DIR ?? join(homeDirectory(environment), ".agent-rig");
	const key = Buffer.from(sessionId, "utf8").toString("hex");
	return join(configDirectory, "regulation-seen", `${key}.json`);
};

const fileStore: RegulationHookDependencies["store"] = {
	async read(sessionId) {
		const environment = process.env;
		try {
			const value = JSON.parse(await readFile(sessionFile(sessionId, environment), "utf8")) as unknown;
			if (!isRecord(value) || !isString(value.id) || !Number.isSafeInteger(value.number) || typeof value.seenAt !== "number") return null;
			return value as RegulationVersionState;
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return null;
			if (error instanceof SyntaxError) return null;
			throw error;
		}
	},
	async write(sessionId, state) {
		const environment = process.env;
		const path = sessionFile(sessionId, environment);
		const directory = dirname(path);
		const temporary = `${path}.${randomUUID()}.tmp`;
		await mkdir(directory, { recursive: true });
		try {
			await writeFile(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
			await rename(temporary, path);
		} finally {
			try { await unlink(temporary); } catch (error) { if (!isRecord(error) || error.code !== "ENOENT") throw error; }
		}
	},
};

export const runHookCommand = async (eventName: string, input: string): Promise<number> => {
	if (!hookEvents.has(eventName as HookEvent)) return 0;
	let payload: unknown;
	try { payload = JSON.parse(input) as unknown; } catch { return 0; }
	if (!isRecord(payload)) return 0;
	return runRegulationHook(eventName as HookEvent, payload, {
		environment: () => process.env,
		transport: (url, init) => fetch(url, init),
		store: fileStore,
		clock: { now: () => Date.now() },
		writeStdout: (line) => console.log(line),
		writeStderr: (line) => console.error(line),
	});
};

if (import.meta.main) {
	const event = process.argv[2] ?? "";
	const input = await Bun.stdin.text();
	process.exitCode = await runHookCommand(event, input);
}
