import type { SessionRecord } from "../src/session-core.js";

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.js";
import { expandLaunch, modeCommand, runSession, transcriptMode } from "../src/commands/session-run.js";
import { messagesFor } from "../src/messages.js";
import { apiFail, apiOk } from "../src/output.js";
import { ok } from "../src/result.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";

const ID = "11111111-1111-1111-1111-111111111111";
const ROOT = "/home/test/.agent-rig";
const CREATED = "2026-01-01";
// The two-second failure-detection grace documented for session launches.
const LAUNCH_GRACE_MS = 2000;
const session: SessionRecord = { id: ID, cwd: "/work", transcriptPath: "/transcript", pid: 42, pidCreated: CREATED, startedAt: CREATED, endedAt: CREATED };
const raw = { session_id: ID, cwd: session.cwd, transcript_path: session.transcriptPath, pid: session.pid, pid_created: session.pidCreated, started_at: CREATED, ended_at: CREATED, config_dir: "/cfg/1-test" };
const config = { command: ["terminal", "{cwd}", "{account}", "{session}", "{mode}"], timeoutSec: 2 };
const code = (result: { ok: true } | { ok: false; error: { code: string } }): string => result.ok ? "ok" : result.error.code;
const setup = () => {
	const h = createMemoryRuntime();
	h.fs.directories.add("/work");
	h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify(raw));
	h.fs.seed(`${ROOT}/launch.json`, JSON.stringify(config));
	let now = 0;
	h.runtime.clock.now = () => new Date(now);
	h.runtime.clock.sleep = async (ms) => { now += ms; };
	return h;
};

describe("session run and mode", () => {
	test("looks up the account without collecting limit information", async () => {
		const h = setup();
		h.fs.seed(`${ROOT}/state.json`, JSON.stringify({ mode: "dev", paths: { repo: "/repo", hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null }));
		const calls: string[][] = [];
		h.runtime.process.run = async (_command, args) => { calls.push([...args]); return ok({ stdout: '{"account":12}', stderr: "", exitCode: 0 }); };
		await runSession(h.runtime, session, "plan", null, async () => apiOk(null));
		expect(calls.length).toBe(1);
		expect(calls[0]).toContain("account");
		expect(h.fs.textReads.some((path) => path.endsWith("/usage.json"))).toBe(false);
	});
	test("uses catalogue errors in both languages", async () => {
		for (const language of ["en", "ru"] as const) {
			const h = setup();
			h.runtime.language = language;
			const result = await expandLaunch(h.runtime, config, session, "1", "unknown");
			expect(result.ok ? "ok" : result.error.message).toBe(messagesFor(language).session.launchMode());
		}
	});
	test("expands placeholders and rejects unsafe inputs", async () => {
		const h = setup();
		expect(await expandLaunch(h.runtime, config, session, "12", "plan")).toEqual(apiOk(["terminal", "/work", "12", ID, "--permission-mode", "plan"]));
		const cases: Array<[string, string, string[]]> = [["bad&", "plan", config.command], ["1", "unknown", config.command], ["1", "plan", ["terminal"]]];
		for (const [account, mode, command] of cases) {
			expect(code(await expandLaunch(h.runtime, { ...config, command }, session, account, mode))).toBe("launch-invalid");
		}
		const windows = createMemoryRuntime("windows");
		for (const character of ['"', "%", "&", "|", "<", ">", "^"]) expect(code(await expandLaunch(windows.runtime, config, { ...session, cwd: `C:/bad${character}dir` }, "1", "plan"))).toBe("launch-invalid");
	});
	test("reads last transcript mode including default and malformed records", async () => {
		const h = setup();
		h.fs.seed("/transcript", `${JSON.stringify({ type: "permission-mode", permissionMode: "plan" })}\ninvalid\n${JSON.stringify({ type: "permission-mode", permissionMode: "default" })}\n`);
		expect(await transcriptMode(h.runtime, "/transcript")).toBe("manual");
		expect(await modeCommand(h.runtime, [ID, "manual"], () => {})).toEqual(apiOk({ session: ID, mode: "manual", changed: false }));
	});
	test("reports missing and invalid configuration, spawn failure and timeout", async () => {
		const h = setup();
		for (const value of [null, "{", JSON.stringify({ command: [], timeoutSec: -1 })]) {
			if (value === null) h.fs.files.delete(`${ROOT}/launch.json`); else h.fs.seed(`${ROOT}/launch.json`, value);
			expect(code(await runSession(h.runtime, session, "plan", "1"))).toBe("launch-not-configured");
		}
		h.fs.seed(`${ROOT}/launch.json`, JSON.stringify(config));
		expect(code(await runSession(h.runtime, session, "plan", "1", async () => apiFail("launch-failed", "stderr")))).toBe("launch-failed");
		expect(code(await runSession(h.runtime, session, "plan", "1", async () => apiOk(null)))).toBe("launch-timeout");
	});
	test("reports stderr from detached launch failure", async () => {
		const h = setup();
		h.fs.seed(`${ROOT}/launch.json`, JSON.stringify(config));
		h.runtime.process.spawnDetached = async () => ({ ok: false, error: "launch error" });
		const result = await runSession(h.runtime, session, "plan", "1");
		expect(result.ok ? "ok" : result.error.message).toContain("launch error");
	});
	test("retries stderr cleanup on a later launch after a child releases its file", async () => {
		const h = setup();
		const directory = `${ROOT}/launch-stderr`;
		const originalRemove = h.fs.remove.bind(h.fs);
		let locked = "";
		let now = 0;
		h.runtime.clock.now = () => new Date(now);
		h.runtime.process.createdAt = async () => ok({ "43": CREATED });
		h.fs.remove = async (path) => { if (path === locked) throw new Error("file is open"); await originalRemove(path); };
		h.runtime.process.spawnDetached = async (_command, _grace, _limit, path) => {
			h.fs.seed(path, "stderr");
			locked = path;
			h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify({ ...raw, pid: 43, ended_at: null }));
			return ok({ exited: false, exitCode: null, stderr: "" });
		};
		expect(code(await runSession(h.runtime, session, "plan", "1"))).toBe("ok");
		expect((await h.fs.listDirectory(directory)).length).toBe(1);
		const previous = locked;
		locked = "";
		now += LAUNCH_GRACE_MS;
		expect(code(await runSession(h.runtime, session, "plan", "1"))).toBe("ok");
		expect(h.fs.files.has(previous)).toBe(false);
		expect((await h.fs.listDirectory(directory)).length).toBe(1);
	});
	test("removes an unlocked stderr file and preserves a concurrent launch's diagnostic window", async () => {
		const h = setup();
		const directory = `${ROOT}/launch-stderr`;
		const concurrent = `${directory}/0-other.log`;
		h.fs.seed(concurrent, "diagnostic");
		h.runtime.process.createdAt = async () => ok({ "43": CREATED });
		h.runtime.process.spawnDetached = async (_command, _grace, _limit, path) => {
			h.fs.seed(path, "stderr");
			h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify({ ...raw, pid: 43, ended_at: null }));
			return ok({ exited: false, exitCode: null, stderr: "" });
		};
		expect(code(await runSession(h.runtime, session, "plan", "1"))).toBe("ok");
		expect((await h.fs.listDirectory(directory)).map((entry) => entry.name)).toEqual(["0-other.log"]);
	});
	test("rejects a live session and accepts a newly recorded process", async () => {
		const h = setup();
		h.runtime.process.createdAt = async () => ok({ "42": CREATED, "43": CREATED });
		expect(code(await runSession(h.runtime, { ...session, endedAt: null }, "plan", "1"))).toBe("session-running");
		const answer = await runSession(h.runtime, session, "plan", "1", async () => { h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify({ ...raw, pid: 43, ended_at: null })); return apiOk(null); });
		expect(answer).toEqual(apiOk({ session: ID, pid: 43, mode: "plan", account: 1 }));
	});
	test("CLI writes one JSON object on a mode success and run failure", async () => {
		const h = setup();
		h.fs.seed("/transcript", JSON.stringify({ type: "permission-mode", permissionMode: "plan" }));
		for (const args of [["session", "mode", ID, "plan"], ["session", "run", "missing"]]) {
			const output: string[] = [];
			await runCli(args, (line) => output.push(line), h.runtime);
			expect(output).toHaveLength(1);
			expect(typeof JSON.parse(output[0])).toBe("object");
		}
	});
});
