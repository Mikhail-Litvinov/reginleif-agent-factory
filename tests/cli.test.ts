import type { ProgressEvent } from "../src/output.js";

import { describe, expect, test } from "bun:test";
import { parseCommand, runCli } from "../src/cli.js";
import { ok } from "../src/result.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";
import { messagesFor } from "../src/messages";

const TEST_MESSAGES = messagesFor("en");

const LOCK_PATH = "/home/test/.agent-rig/rig.lock";
const HOLDER_PID = 4242;
const HOLDER_START = 777;
const OWN_PID = 1;
const OWN_START = 2;
const POLL_INTERVAL_MS = 1;
const RELEASE_AFTER_SLEEPS = 3;
const LOCK_WAITING_EVENT: ProgressEvent = { code: "lock-waiting" };

describe("CLI", () => {
	test("parses foundation and later-task command forms", () => {
		expect(parseCommand(["install", "--dev"])).toEqual({ ok: true, command: { name: "install", dev: true } });
		expect(parseCommand(["feature", "codex", "enable"])).toEqual({
			ok: true,
			command: { name: "feature-change", feature: "codex", action: "enable" },
		});
		expect(parseCommand(["update", "--pending"])).toEqual({ ok: true, command: { name: "update", pending: true } });
		expect(parseCommand(["unknown"]).ok).toBe(false);
		expect(parseCommand(["info", "--session", "abc"])).toEqual({ ok: true, command: { name: "info", session: "abc" } });
		expect(parseCommand(["info"]).ok).toBe(false);
		expect(parseCommand(["info", "--session"]).ok).toBe(false);
		expect(parseCommand(["info", "--session", "a", "b"]).ok).toBe(false);
	});

	test("parses the internal update-step command and rejects malformed forms", () => {
		expect(parseCommand(["update-step", "apply", "10", "20"])).toEqual({
			ok: true,
			command: { name: "update-step", step: "apply", owner: { pid: 10, startTime: 20 } },
		});
		expect(parseCommand(["update-step", "check", "10", "20"]).ok).toBe(true);
		expect(parseCommand(["update-step", "rollback", "10", "20"]).ok).toBe(false);
		expect(parseCommand(["update-step", "apply", "ten", "20"]).ok).toBe(false);
		expect(parseCommand(["update-step", "apply", "0", "20"]).ok).toBe(false);
		expect(parseCommand(["update-step", "apply", "10"]).ok).toBe(false);
	});

	test("apply without an installed rig fails with a clear message", async () => {
		const harness = createMemoryRuntime();
		const output: string[] = [];
		const exitCode = await runCli(["apply"], (line) => output.push(line), harness.runtime);
		expect(exitCode).toBe(1);
		const failure: unknown = JSON.parse(output[0] ?? "");
		expect(failure).toEqual({ error: { code: "apply-failed", message: expect.stringContaining("state.json") } });
	});

	test("apply behind a busy lock prints the wait line once, before it waits", async () => {
		const harness = createMemoryRuntime();
		harness.fs.seed(LOCK_PATH, JSON.stringify({ pid: HOLDER_PID, startTime: HOLDER_START }));
		let sleeps = 0;
		harness.runtime.lock = {
			fs: harness.fs,
			home: "/home/test",
			process: { pid: OWN_PID, startTime: OWN_START, ownerStartTime: async () => ok(HOLDER_START) },
			clock: {
				sleep: async () => {
					sleeps += 1;
					if (sleeps === RELEASE_AFTER_SLEEPS) harness.fs.files.delete(LOCK_PATH);
				},
				now: () => Date.now(),
			},
			messages: TEST_MESSAGES,
			pollIntervalMs: POLL_INTERVAL_MS,
		};
		const output: string[] = [];
		const events: ProgressEvent[] = [];

		await runCli(["apply"], (line) => output.push(line), harness.runtime, undefined, (event) => events.push(event));

		expect(sleeps).toBe(RELEASE_AFTER_SLEEPS);
		expect(events).toEqual([LOCK_WAITING_EVENT]);
		expect(output.join("\n")).not.toContain("waiting");
	});

	test("apply with a free lock reports no lock-waiting progress", async () => {
		const harness = createMemoryRuntime();
		const events: ProgressEvent[] = [];

		await runCli(["apply"], () => undefined, harness.runtime, undefined, (event) => events.push(event));

		expect(events).toEqual([]);
	});
});
