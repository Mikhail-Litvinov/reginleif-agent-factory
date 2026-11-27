export type PermissionHookDependencies = {
	environment: () => Record<string, string | undefined>;
	transport: (url: string, init?: RequestInit) => Promise<Response>;
	clock: { now: () => number };
	sleep: (milliseconds: number) => Promise<void>;
	writeStdout: (line: string) => void;
	writeStderr: (line: string) => void;
};

// The hook limit in features/factory/feature.json for this hook; a test keeps both in step.
export const PERMISSION_HOOK_TIMEOUT_SECONDS = 60;
// The wait for a chief engineer's answer ends this long before the tool's own hook limit, so the hook answers itself.
const WAIT_MARGIN_MS = 10_000;
const POLL_INTERVAL_MS = 1_000;
const CALL_TIMEOUT_MS = 8_000;

type Decision = { decision: "allow" | "deny" | "ask"; reason: string };
type HookConfig = { baseUrl: string; token: string; runId?: string };
type Subject = { run_id: string } | { session_id: string };

class Unreachable extends Error {}
class Malformed extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const oneLine = (text: string): string => text.replace(/[\r\n\t]+/gu, " ").slice(0, 300);

const hookConfig = (environment: Record<string, string | undefined>): HookConfig | null => {
	const baseUrl = environment.AF_API_URL?.trim();
	const token = environment.AF_REGISTRY_TOKEN?.trim();
	if (!baseUrl || !token) return null;
	let parsed: URL;
	try { parsed = new URL(baseUrl); } catch { return null; }
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	const runId = environment.AF_TASK_RUN_ID?.trim();
	return { baseUrl: parsed.toString().replace(/\/$/u, ""), token, ...(runId ? { runId } : {}) };
};

const request = async (
	config: HookConfig,
	dependencies: PermissionHookDependencies,
	method: "GET" | "POST",
	path: string,
	body?: unknown,
): Promise<{ status: number; body: unknown }> => {
	let response: Response;
	try {
		response = await dependencies.transport(`${config.baseUrl}/${path}`, {
			method,
			headers: { Authorization: `Bearer ${config.token}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
		});
	} catch {
		throw new Unreachable("Factory API is unreachable");
	}
	if (response.status >= 500) throw new Unreachable(`Factory API is unavailable (${response.status})`);
	let parsed: unknown;
	try { parsed = await response.json(); } catch { throw new Malformed(`Factory API returned invalid JSON (${response.status})`); }
	return { status: response.status, body: parsed };
};

// The factory's own answer {allowed, source, reason?}: anything else is malformed and never allows.
const readCheck = (status: number, body: unknown): { allowed: boolean; source: string; reason?: string } => {
	if (status !== 200 || !isRecord(body) || typeof body.allowed !== "boolean" || !isString(body.source)) throw new Malformed(`Factory API returned an unreadable rights answer (${status})`);
	if (body.allowed && !["role", "record", "grant"].includes(body.source)) throw new Malformed("Factory API allowed without a role, record or grant");
	return { allowed: body.allowed, source: body.source, ...(typeof body.reason === "string" ? { reason: body.reason } : {}) };
};

const fromCheck = (answer: { allowed: boolean; source: string; reason?: string }): Decision | null => {
	if (answer.allowed) return { decision: "allow", reason: `Allowed by the Factory (${answer.source})` };
	if (answer.source === "refused") return { decision: "deny", reason: `Refused by the Factory: ${answer.reason ?? "no reason given"}` };
	if (answer.source === "none") return null;
	throw new Malformed("Factory API returned an unknown rights source");
};

const waitForRequest = async (
	config: HookConfig,
	dependencies: PermissionHookDependencies,
	id: string,
): Promise<Decision> => {
	const deadline = dependencies.clock.now() + PERMISSION_HOOK_TIMEOUT_SECONDS * 1000 - WAIT_MARGIN_MS;
	for (;;) {
		const { status, body } = await request(config, dependencies, "GET", `rights/requests/${encodeURIComponent(id)}`);
		if (status !== 200 || !isRecord(body)) throw new Malformed(`Factory API returned an unreadable request (${status})`);
		const state = body.state;
		if (state === "granted") return { decision: "allow", reason: "Allowed by the answer to the right request" };
		if (state === "refused") return { decision: "deny", reason: "The right request was refused" };
		if (state === "call_owner") return { decision: "ask", reason: "The Factory handed this request to the owner" };
		if (state !== "open") throw new Malformed("Factory API returned an unknown request state");
		if (dependencies.clock.now() + POLL_INTERVAL_MS >= deadline) return { decision: "deny", reason: `Request still waiting (request ${id}); ask again by this number` };
		await dependencies.sleep(POLL_INTERVAL_MS);
	}
};

const decide = async (config: HookConfig, dependencies: PermissionHookDependencies, payload: Record<string, unknown>, subject: Subject): Promise<Decision> => {
	const tool = payload.tool_name as string;
	const right = {
		action: "tool",
		target: tool,
		conditions: { tool_input: isRecord(payload.tool_input) ? payload.tool_input : {} },
	};
	const checked = await request(config, dependencies, "POST", "rights/check", { ...subject, ...right });
	const direct = fromCheck(readCheck(checked.status, checked.body));
	if (direct) return direct;
	const created = await request(config, dependencies, "POST", "rights/requests", {
		...subject,
		...right,
		reason: `A Claude session calls ${tool} and nothing in the registry covers it`,
		tried: "The permission hook asked the rights check; it found no role, record or grant",
	});
	if (created.status === 200) {
		const direct = fromCheck(readCheck(created.status, created.body));
		if (direct) return direct;
		throw new Malformed("Factory API answered a request with nothing found");
	}
	if (created.status !== 202 || !isRecord(created.body) || !isString(created.body.id)) throw new Malformed(`Factory API returned an unreadable request answer (${created.status})`);
	return waitForRequest(config, dependencies, created.body.id);
};

const emit = (decision: Decision, writeStdout: PermissionHookDependencies["writeStdout"]): void => {
	writeStdout(JSON.stringify({
		hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision.decision, permissionDecisionReason: decision.reason },
	}));
};

// Fails safe: whatever goes wrong, the answer is never "allow". An ordinary session gets its normal prompt;
// a Factory run (AF_TASK_RUN_ID set) has no prompt and is denied.
export const runPermissionHook = async (payload: Record<string, unknown>, dependencies: PermissionHookDependencies): Promise<number> => {
	const environment = dependencies.environment();
	const factoryRun = Boolean(environment.AF_TASK_RUN_ID?.trim());
	const fallback = (why: string): number => {
		const reason = `Factory permission hook: ${why}`;
		dependencies.writeStderr(oneLine(`${reason}; ${factoryRun ? "denied" : "showing the normal prompt"}`));
		emit({ decision: factoryRun ? "deny" : "ask", reason }, dependencies.writeStdout);
		return 0;
	};
	const config = hookConfig(environment);
	if (!config) return fallback("the Factory is not configured");
	if (!isString(payload.tool_name)) return fallback("the tool call is unreadable");
	let subject: Subject;
	if (config.runId) subject = { run_id: config.runId };
	else if (isString(payload.session_id)) subject = { session_id: payload.session_id };
	else return fallback("the session is unknown");
	try {
		emit(await decide(config, dependencies, payload, subject), dependencies.writeStdout);
		return 0;
	} catch (error) {
		if (error instanceof Unreachable) return fallback("the Factory is unreachable");
		if (error instanceof Malformed) return fallback(error.message);
		return fallback("unexpected error");
	}
};

export const runHookCommand = async (input: string): Promise<number> => {
	let payload: unknown;
	try { payload = JSON.parse(input) as unknown; } catch { payload = {}; }
	return runPermissionHook(isRecord(payload) ? payload : {}, {
		environment: () => process.env,
		transport: (url, init) => fetch(url, init),
		clock: { now: () => Date.now() },
		sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
		writeStdout: (line) => console.log(line),
		writeStderr: (line) => console.error(line),
	});
};

if (import.meta.main) {
	process.exitCode = await runHookCommand(await Bun.stdin.text());
}
