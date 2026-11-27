import { describe, expect, test } from "bun:test";

import { runRegulationHook, type RegulationHookDependencies } from "../features/factory/hooks/regulation.js";

const environment = { AF_API_URL: "https://factory.invalid/api", AF_READER_TOKEN: "reader-secret", AF_PROJECT_ID: "project-1" };
const versionOne = { id: "v1", number: 1, clauses: ["clause-1"] };
const versionTwo = { id: "v2", number: 2, clauses: ["clause-1", "clause-2"] };

const setup = (handler: (url: URL) => Response | Promise<Response>) => {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const values = new Map<string, { id: string; number: number; seenAt: number }>();
	const dependencies: RegulationHookDependencies = {
		environment: () => environment,
		transport: async (input) => handler(new URL(input)),
		store: {
			read: async (sessionId) => values.get(sessionId) ?? null,
			write: async (sessionId, state) => { values.set(sessionId, state); },
		},
		clock: { now: () => 1_800_000_000_000 },
		writeStdout: (line) => stdout.push(line),
		writeStderr: (line) => stderr.push(line),
	};
	return { dependencies, stdout, stderr, values };
};

const json = (body: unknown, status = 200) => Response.json(body, { status });
const clause = (id: string, decision: string, projectId: string | null = null) => ({
	id,
	kind: "rule",
	status: "active",
	scope_type: projectId === null ? "global" : "project",
	project_id: projectId,
	category: "work",
	problem: `Apply ${id}`,
	decision,
});

describe("Factory regulation hooks", () => {
	test("registry without local credentials does nothing", async () => {
		const { dependencies, stdout, stderr } = setup(() => { throw new Error("transport must not run"); });
		dependencies.environment = () => ({});

		const exitCode = await runRegulationHook("SessionStart", { session_id: "session-1" }, dependencies);

		expect(exitCode).toBe(0);
		expect(stdout).toEqual([]);
		expect(stderr).toEqual([]);
	});

	test("a disabled registry is silent", async () => {
		const { dependencies, stdout, stderr } = setup(() => json({ code: "unavailable" }, 503));

		const exitCode = await runRegulationHook("SessionStart", { session_id: "session-1" }, dependencies);

		expect(exitCode).toBe(0);
		expect(stdout).toEqual([]);
		expect(stderr).toEqual([]);
	});

	test("session start prints the active clauses", async () => {
		const { dependencies, stdout, values } = setup((url) => {
			if (url.pathname === "/api/regulation/versions") return json({ items: [{ id: versionOne.id, number: versionOne.number }] });
			if (url.pathname.endsWith("/v1")) return json(versionOne);
			if (url.pathname.endsWith("/clause-1")) return json(clause("clause-1", "Keep the change small"));
			throw new Error(`unexpected route ${url.pathname}`);
		});

		const exitCode = await runRegulationHook("SessionStart", { session_id: "session-1" }, dependencies);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout[0]!).hookSpecificOutput.additionalContext).toContain("Keep the change small");
		expect(values.get("session-1")).toEqual({ id: "v1", number: 1, seenAt: 1_800_000_000_000 });
	});

	test("a version difference is shown once across prompt and tool hooks", async () => {
		const { dependencies, stdout } = setup((url) => {
			if (url.pathname === "/api/regulation/versions") return json({ items: [{ id: versionTwo.id, number: versionTwo.number }] });
			if (url.pathname.endsWith("/v2")) return json(versionTwo);
			if (url.pathname.endsWith("/v1/diff")) return json({ changes: [{
				clause_id: "clause-2",
				change: "removed",
				before: { clause: "clause-2", decision: "Use the new process" },
				after: null,
			}] });
			throw new Error(`unexpected route ${url.pathname}`);
		});
		await dependencies.store.write("session-1", { id: "v1", number: 1, seenAt: 0 });

		await runRegulationHook("UserPromptSubmit", { session_id: "session-1" }, dependencies);
		await runRegulationHook("PreToolUse", { session_id: "session-1" }, dependencies);

		expect(stdout).toHaveLength(1);
		const context = JSON.parse(stdout[0]!).hookSpecificOutput.additionalContext as string;
		expect(context).toContain("changed to version 2 (from version 1)");
		expect(context).toContain("Use the new process");
	});

	test("an API error fails open and reports one line", async () => {
		const { dependencies, stdout, stderr } = setup(() => { throw new Error("connection failed\nwith details"); });

		const exitCode = await runRegulationHook("PreToolUse", { session_id: "session-1" }, dependencies);

		expect(exitCode).toBe(0);
		expect(stdout).toEqual([]);
		expect(stderr).toHaveLength(1);
		expect(stderr[0]).toContain("failed open");
		expect(stderr[0]).not.toContain("\n");
	});
});
