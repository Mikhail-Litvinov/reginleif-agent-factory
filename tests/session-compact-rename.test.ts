import type { SessionRecord } from "../src/session-core.js";

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.js";
import { compactSession } from "../src/commands/session-compact.js";
import { renameSession } from "../src/commands/session-rename.js";
import { SESSION_ENDED, SESSION_MODULE_ERROR, SESSION_NO_MODULE } from "../src/output.js";
import { COMPACT_TIMEOUT_MS, SESSION_TIMEOUTS } from "../src/session-core.js";
import { ok } from "../src/result.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";

const ROOT = "/home/test/.agent-rig/sessions";
const CREATED = "2026-01-01T00:00:00.000000Z";
const record: SessionRecord = { id: "abc", cwd: "/work", transcriptPath: "/transcript", pid: 42, pidCreated: CREATED, startedAt: "2026-01-01T00:00:00Z", endedAt: null };
const raw = { session_id: record.id, cwd: record.cwd, transcript_path: record.transcriptPath, pid: record.pid, pid_created: record.pidCreated, started_at: record.startedAt, ended_at: null };

const setup = (response: unknown) => {
	const harness = createMemoryRuntime();
	harness.fs.seed(`${ROOT}/abc.json`, JSON.stringify(raw));
	harness.fs.directories.add(`${ROOT}/abc`);
	harness.fs.seed(`${ROOT}/abc/responses/event-1.json`, JSON.stringify({ id: "event-1", ok: true, result: response }));
	harness.runtime.process.createdAt = async (pids) => ok(Object.fromEntries(pids.map((pid) => [String(pid), CREATED])));
	return harness;
};

const errorCode = (result: { ok: true } | { ok: false; error: { code: string } }): string => result.ok ? "ok" : result.error.code;

describe("session compact and rename", () => {
	test("rejects non-finite compact counts", async () => {
		const harness = setup(null);
		harness.fs.seed(`${ROOT}/abc/responses/event-1.json`, '{"id":"event-1","ok":true,"result":{"tokensBefore":1e999,"tokensAfter":1}}');
		expect(errorCode(await compactSession(harness.runtime, ["abc"], () => {}))).toBe("session-bad-response");
	});
	test("compact returns raw token counts and forwards instructions with the compact timeout", async () => {
		const harness = setup({ tokensBefore: 100, tokensAfter: 40 });
		let request: string | undefined;
		const writeText = harness.fs.writeText.bind(harness.fs);
		harness.fs.writeText = async (path, value) => {
			if (path.endsWith(".tmp")) request = value;
			await writeText(path, value);
		};
		const result = await compactSession(harness.runtime, ["abc", "--instructions", "keep decisions", "and constraints"], () => {});
		expect(result).toEqual({ ok: true, value: { session: "abc", tokensBefore: 100, tokensAfter: 40 } });
		expect(SESSION_TIMEOUTS.compact).toBe(COMPACT_TIMEOUT_MS);
		expect(JSON.parse(request ?? "null")).toMatchObject({ op: "compact", args: { instructions: "keep decisions and constraints" } });
		expect(harness.fs.files.has(`${ROOT}/abc/requests/event-1.json`)).toBe(false);
	});

	test("compact reports a hook skip as success data", async () => {
		const harness = setup({ skip: "vetoed" });
		expect(await compactSession(harness.runtime, ["abc"], () => {})).toEqual({ ok: true, value: { session: "abc", skip: "vetoed" } });
	});

	test("both operations report module errors", async () => {
		for (const run of [
			(runtime: ReturnType<typeof setup>["runtime"]) => compactSession(runtime, ["abc"], () => {}),
			(runtime: ReturnType<typeof setup>["runtime"]) => renameSession(runtime, ["abc", "new name"], () => {}),
		]) {
			const harness = setup(null);
			harness.fs.seed(`${ROOT}/abc/responses/event-1.json`, JSON.stringify({ id: "event-1", ok: false, error: "module failed" }));
			expect(errorCode(await run(harness.runtime))).toBe(SESSION_MODULE_ERROR);
		}
	});

	test("both operations reject an ended session before requesting the module", async () => {
		for (const run of [
			(runtime: ReturnType<typeof setup>["runtime"]) => compactSession(runtime, ["abc"], () => {}),
			(runtime: ReturnType<typeof setup>["runtime"]) => renameSession(runtime, ["abc", "new name"], () => {}),
		]) {
			const harness = setup(null);
			harness.runtime.process.createdAt = async () => ok({ "42": "different" });
			expect(errorCode(await run(harness.runtime))).toBe(SESSION_ENDED);
		}
	});

	test("both operations report a missing module through the core", async () => {
		for (const run of [
			(runtime: ReturnType<typeof setup>["runtime"]) => compactSession(runtime, ["abc"], () => {}),
			(runtime: ReturnType<typeof setup>["runtime"]) => renameSession(runtime, ["abc", "new name"], () => {}),
		]) {
			const harness = setup(null);
			harness.fs.directories.delete(`${ROOT}/abc`);
			expect(errorCode(await run(harness.runtime))).toBe(SESSION_NO_MODULE);
		}
	});

	test("rename joins arguments and returns the module name", async () => {
		const harness = setup({ name: "new name" });
		let request: string | undefined;
		const writeText = harness.fs.writeText.bind(harness.fs);
		harness.fs.writeText = async (path, value) => {
			if (path.endsWith(".tmp")) request = value;
			await writeText(path, value);
		};
		expect(await renameSession(harness.runtime, ["abc", "new", "name"], () => {})).toEqual({ ok: true, value: { session: "abc", name: "new name" } });
		expect(JSON.parse(request ?? "null")).toMatchObject({ op: "rename", args: { name: "new name" } });
	});

	test("rename rejects an empty trimmed name", async () => {
		const harness = setup(null);
		expect(errorCode(await renameSession(harness.runtime, ["abc", "  "], () => {}))).toBe("usage");
	});

	test("both CLI subcommands keep success and failure output to one JSON object", async () => {
		for (const [args, response] of [
			[["session", "compact", "abc"], { tokensBefore: 100, tokensAfter: 40 }],
			[["session", "rename", "abc", "new name"], { name: "new name" }],
		] as const) {
			const harness = setup(response);
			const output: string[] = [];
			const code = await runCli([...args], (line) => output.push(line), harness.runtime);
			expect(code).toBe(0);
			expect(output).toHaveLength(1);
			expect(JSON.parse(output[0])).toEqual({ session: "abc", ...response });
		}
		const harness = setup(null);
		const output: string[] = [];
		const code = await runCli(["session", "rename", "abc"], (line) => output.push(line), harness.runtime);
		expect(code).toBe(1);
		expect(output).toHaveLength(1);
		expect(JSON.parse(output[0])).toHaveProperty("error.code", "usage");
	});
});
