import type { RuntimePorts } from "../ports.js";
import type { ApiResult, JsonValue } from "../output.js";

import { messagesFor } from "../messages.js";
import { apiFail, apiOk, ERROR_CODE_USAGE } from "../output.js";
import { errorText } from "../result.js";

export type RegistryAction = "find" | "verdict" | "propose" | "import";

type RegistryArgs = { action: RegistryAction; args: string[] };
type RecordPayload = Record<string, JsonValue>;

export const runRegistryCommand = async (runtime: RuntimePorts, { action, args }: RegistryArgs): Promise<ApiResult<JsonValue>> => {
	const messages = messagesFor(runtime.language).registry;
	const usage = (): ApiResult<never> => apiFail(ERROR_CODE_USAGE, messages.usage());
	const baseUrl = runtime.environment.get("RIG_FACTORY_URL")?.replace(/\/+$/u, "");
	const token = runtime.environment.get("RIG_FACTORY_TOKEN");
	if (!baseUrl || !token) return apiFail("registry_client_config", messages.clientConfig());

	let path: string;
	let body: RecordPayload;
	if (action === "find") {
		const parsed = parseFind(args);
		if (!parsed.ok) return usage();
		path = "/registry/inquiries";
		body = parsed.value;
	} else if (action === "verdict") {
		const parsed = parseVerdict(args);
		if (!parsed.ok) return usage();
		path = `/registry/inquiries/${encodeURIComponent(parsed.value.inquiryId)}/verdicts`;
		body = parsed.value.body;
	} else {
		let payloadText: string;
		if (action === "propose") {
			if (args.length !== 1) return usage();
			payloadText = args[0]!;
		} else {
			if (args.length !== 1 || args[0]!.trim().length === 0) return usage();
			try { payloadText = await runtime.fs.readText(args[0]!); }
			catch { return apiFail("registry_import_input", messages.importRead()); }
		}
		const record = parseRecord(payloadText);
		if (record === null) return action === "import" ? apiFail("registry_import_input", messages.importInput()) : usage();
		path = "/registry/records";
		body = record;
	}

	try {
		const response = await runtime.http.request(`${baseUrl}${path}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify(body),
		});
		const result: unknown = await response.json();
		if (response.status >= 200 && response.status < 300) return apiOk(asJson(result));
		const problem = problemFrom(result, response.status, messages.refused());
		return apiFail(problem.code, problem.message);
	} catch (error) {
		return apiFail("registry_unavailable", messages.unreachable(errorText(error)));
	}
};

const parseFind = (args: string[]): { ok: true; value: RecordPayload } | { ok: false } => {
	if (args.length < 2 || !args[0]!.trim() || !args[1]!.trim()) return { ok: false };
	const value: RecordPayload = { problem: args[0]!, category: args[1]! };
	const names = new Map([["--project-id", "project_id"], ["--action", "action"], ["--target", "target"], ["--reuse-intent", "reuse_intent"]]);
	const seen = new Set<string>();
	for (let index = 2; index < args.length; index += 2) {
		const flag = args[index]!;
		const field = names.get(flag);
		const content = args[index + 1];
		if (field === undefined || content === undefined || !content.trim() || seen.has(field)) return { ok: false };
		if (field === "reuse_intent" && content !== "standing" && content !== "once") return { ok: false };
		seen.add(field);
		value[field] = content;
	}
	return { ok: true, value };
};

const parseVerdict = (args: string[]): { ok: true; value: { inquiryId: string; body: RecordPayload } } | { ok: false } => {
	if (args.length < 3 || !args[0]!.trim() || !args[1]!.trim()) return { ok: false };
	const verdict = args[2]!;
	if (!["applies", "not_applicable", "outdated", "conflict"].includes(verdict)) return { ok: false };
	const body: RecordPayload = { record_id: args[1]!, verdict };
	const seen = new Set<string>();
	for (let index = 3; index < args.length; index += 2) {
		const flag = args[index]!;
		const content = args[index + 1];
		const field = flag === "--difference" ? "difference" : flag === "--conflicts-with" ? "conflicts_with" : undefined;
		if (field === undefined || content === undefined || !content.trim() || seen.has(field)) return { ok: false };
		seen.add(field);
		body[field] = content;
	}
	if (verdict !== "applies" && body.difference === undefined) return { ok: false };
	if (verdict === "conflict" && body.conflicts_with === undefined) return { ok: false };
	return { ok: true, value: { inquiryId: args[0]!, body } };
};

const parseRecord = (text: string): RecordPayload | null => {
	try {
		const value: unknown = JSON.parse(text);
		if (!isObject(value)) return null;
		for (const key of ["kind", "scope_type", "category", "problem", "decision"]) {
			if (typeof value[key] !== "string" || value[key].trim().length === 0) return null;
		}
		return value as RecordPayload;
	} catch { return null; }
};

const problemFrom = (value: unknown, status: number, refused: string): { code: string; message: string } => {
	if (isObject(value)) {
		const body = isObject(value.error) ? value.error : value;
		const code = typeof body.code === "string" ? body.code : `http-${status}`;
		const detail = typeof body.detail === "string" ? body.detail : typeof body.message === "string" ? body.message : refused;
		return { code, message: detail };
	}
	return { code: `http-${status}`, message: refused };
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const asJson = (value: unknown): JsonValue => value as JsonValue;
