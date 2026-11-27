import { describe, expect, test } from "bun:test";
import { runCli } from "../src/cli.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";

type Request = { url: string; method: string; headers: Record<string, string>; body?: string };

const setup = () => {
	const harness = createMemoryRuntime();
	harness.environment.set("RIG_FACTORY_URL", "https://factory.example/api");
	harness.environment.set("RIG_FACTORY_TOKEN", "afk_prefix_secret");
	const requests: Request[] = [];
	let response: { status: number; body: unknown } = { status: 200, body: { id: "result" } };
	harness.runtime.http = {
		request: async (url, init) => {
			requests.push({ url, method: init.method, headers: init.headers, body: init.body });
			return { status: response.status, json: async () => response.body };
		},
	};
	return { harness, requests, refuse: (code: string) => { response = { status: 409, body: { code, detail: "refused" } }; } };
};

const run = async (harness: ReturnType<typeof createMemoryRuntime>, args: string[]) => {
	const output: string[] = [];
	const code = await runCli(args, (line) => output.push(line), harness.runtime);
	return { code, output: output.map((line) => JSON.parse(line) as Record<string, unknown>) };
};

describe("rig factory registry commands", () => {
	test("find opens an inquiry and prints the server result", async () => {
		const { harness, requests } = setup();
		const result = await run(harness, ["factory", "registry", "find", "Need a deployment pattern", "operations", "--project-id", "project-1"]);
		expect(result.code).toBe(0);
		expect(requests[0]).toMatchObject({ url: "https://factory.example/api/registry/inquiries", method: "POST", headers: { Authorization: "Bearer afk_prefix_secret" } });
		expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ problem: "Need a deployment pattern", category: "operations", project_id: "project-1" });
		expect(result.output[0]).toEqual({ id: "result" });
	});

	test("find maps a server refusal to a nonzero command result and preserves its problem code", async () => {
		const { harness, refuse } = setup();
		refuse("unavailable");
		const result = await run(harness, ["factory", "registry", "find", "Problem", "operations"]);
		expect(result.code).not.toBe(0);
		expect(result.output[0]).toMatchObject({ error: { code: "unavailable" } });
	});

	test("verdict posts a valid verdict and its optional difference", async () => {
		const { harness, requests } = setup();
		await run(harness, ["factory", "registry", "verdict", "inquiry-1", "record-1", "outdated", "--difference", "The policy changed"]);
		expect(requests[0]).toMatchObject({ url: "https://factory.example/api/registry/inquiries/inquiry-1/verdicts", method: "POST" });
		expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({ record_id: "record-1", verdict: "outdated", difference: "The policy changed" });
	});

	test("verdict refusal keeps the documented problem code", async () => {
		const { harness, refuse } = setup();
		refuse("not_found");
		const result = await run(harness, ["factory", "registry", "verdict", "inquiry-1", "record-1", "applies"]);
		expect(result.code).not.toBe(0);
		expect(result.output[0]).toMatchObject({ error: { code: "not_found" } });
	});

	test("propose sends a draft record payload", async () => {
		const { harness, requests } = setup();
		const payload = JSON.stringify({ kind: "decision", scope_type: "project", project_id: "project-1", category: "operations", problem: "Issue", decision: "Use the supported path" });
		await run(harness, ["factory", "registry", "propose", payload]);
		expect(requests[0]).toMatchObject({ url: "https://factory.example/api/registry/records", method: "POST" });
		expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual(JSON.parse(payload));
	});

	test("propose refusal keeps the documented problem code", async () => {
		const { harness, refuse } = setup();
		refuse("evidence_missing");
		const payload = JSON.stringify({ kind: "decision", scope_type: "global", category: "operations", problem: "Issue", decision: "Answer" });
		const result = await run(harness, ["factory", "registry", "propose", payload]);
		expect(result.code).not.toBe(0);
		expect(result.output[0]).toMatchObject({ error: { code: "evidence_missing" } });
	});

	test("import reads JSON record data and submits a draft", async () => {
		const { harness, requests } = setup();
		const payload = { kind: "decision", scope_type: "global", category: "operations", problem: "Imported", decision: "Imported decision" };
		await harness.fs.writeText("/repo/import.json", JSON.stringify(payload));
		await run(harness, ["factory", "registry", "import", "/repo/import.json"]);
		expect(requests[0]).toMatchObject({ url: "https://factory.example/api/registry/records", method: "POST" });
		expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual(payload);
	});

	test("import refusal keeps the documented problem code", async () => {
		const { harness, refuse } = setup();
		refuse("forbidden");
		await harness.fs.writeText("/repo/import.json", JSON.stringify({ kind: "decision", scope_type: "global", category: "operations", problem: "Imported", decision: "Answer" }));
		const result = await run(harness, ["factory", "registry", "import", "/repo/import.json"]);
		expect(result.code).not.toBe(0);
		expect(result.output[0]).toMatchObject({ error: { code: "forbidden" } });
	});

	test("invalid find arguments are rejected before a request is sent", async () => {
		const { harness, requests } = setup();
		const result = await run(harness, ["factory", "registry", "find", "Problem"]);
		expect(result.code).not.toBe(0);
		expect(result.output[0]).toMatchObject({ error: { code: "usage" } });
		expect(requests).toHaveLength(0);
	});

	test("invalid verdict arguments are rejected before a request is sent", async () => {
		const { harness, requests } = setup();
		const result = await run(harness, ["factory", "registry", "verdict", "inquiry-1", "record-1", "conflict"]);
		expect(result.code).not.toBe(0);
		expect(result.output[0]).toMatchObject({ error: { code: "usage" } });
		expect(requests).toHaveLength(0);
	});

	test("invalid propose data is rejected before a request is sent", async () => {
		const { harness, requests } = setup();
		const result = await run(harness, ["factory", "registry", "propose", "not-json"]);
		expect(result.code).not.toBe(0);
		expect(result.output[0]).toMatchObject({ error: { code: "usage" } });
		expect(requests).toHaveLength(0);
	});

	test("invalid import data is rejected before a request is sent", async () => {
		const { harness, requests } = setup();
		await harness.fs.writeText("/repo/import.json", "{}");
		const result = await run(harness, ["factory", "registry", "import", "/repo/import.json"]);
		expect(result.code).not.toBe(0);
		expect(result.output[0]).toMatchObject({ error: { code: "registry_import_input" } });
		expect(requests).toHaveLength(0);
	});
});
