import type { RuntimePorts } from "../ports.js";
import type { ApiResult, JsonValue } from "../output.js";

import { apiFail, apiOk } from "../output.js";

export type RegistryAction = "find" | "verdict" | "propose" | "import";
export const registryUsage = (): string => "Usage: rig factory registry find <problem> <category> [--project-id <id>] [--action <text>] [--target <text>] [--reuse-intent standing|once]; verdict <inquiry-id> <record-id> <verdict> [--difference <text>] [--conflicts-with <record-id>]; propose <record-json>; import <record-json-file>";

type RegistryArgs = { action: RegistryAction; values: string[] };
type RecordPayload = Record<string, JsonValue>;

export const runRegistryCommand = async (runtime: RuntimePorts, { action, values }: RegistryArgs): Promise<ApiResult<JsonValue>> => {
	const baseUrl = runtime.environment.get("RIG_FACTORY_URL")?.replace(/\/+$/u, "");
	const token = runtime.environment.get("RIG_FACTORY_TOKEN");
	if (!baseUrl || !token) return apiFail("registry_client_config", "Set RIG_FACTORY_URL and RIG_FACTORY_TOKEN in the process environment.");

	let path: string;
	let body: RecordPayload;
	if (action === "find") {
		const parsed = parseFind(values);
		if (!parsed.ok) return apiFail("usage", registryUsage());
		path = "/registry/inquiries";
		body = parsed.value;
	} else if (action === "verdict") {
		const parsed = parseVerdict(values);
		if (!parsed.ok) return apiFail("usage", registryUsage());
		path = `/registry/inquiries/${encodeURIComponent(parsed.value.inquiryId)}/verdicts`;
		body = parsed.value.body;
	} else {
		let payloadText: string;
		if (action === "propose") {
			if (values.length !== 1) return apiFail("usage", registryUsage());
			payloadText = values[0]!;
		} else {
			if (values.length !== 1 || values[0]!.trim().length === 0) return apiFail("usage", registryUsage());
			try { payloadText = await runtime.fs.readText(values[0]!); }
			catch { return apiFail("registry_import_input", "Could not read the import JSON file."); }
		}
		const record = parseRecord(payloadText);
		if (record === null) return apiFail(action === "import" ? "registry_import_input" : "usage", action === "import" ? "Import input must be a registry record JSON object." : registryUsage());
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
		const problem = problemFrom(result, response.status);
		return apiFail(problem.code, problem.message);
	} catch (error) {
		return apiFail("registry_unavailable", error instanceof Error ? error.message : "The registry API could not be reached.");
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

const problemFrom = (value: unknown, status: number): { code: string; message: string } => {
	if (isObject(value)) {
		const error = isObject(value.error) ? value.error : value;
		const code = typeof error.code === "string" ? error.code : `http-${status}`;
		const message = typeof error.detail === "string" ? error.detail : typeof error.message === "string" ? error.message : "The registry API refused the request.";
		return { code, message };
	}
	return { code: `http-${status}`, message: "The registry API refused the request." };
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const asJson = (value: unknown): JsonValue => value as JsonValue;
