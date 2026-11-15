import type { SessionRecord } from "../src/session-core.js";

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.js";
import { modeCommand, prepareLaunch, runSession, transcriptMode } from "../src/commands/session-run.js";
import { buildLaunchCommand } from "../src/launch-command.js";
import { messagesFor } from "../src/messages.js";
import { apiFail, apiOk } from "../src/output.js";
import { ok } from "../src/result.js";
import { baseManifest, createMemoryRuntime, seedFeature, seedHubManifest } from "./fakes/memory-runtime.js";

const ID = "11111111-1111-1111-1111-111111111111";
const ROOT = "/home/test/.agent-rig";
const CREATED = "2026-01-01";
// The two-second failure-detection grace documented for session launches.
const LAUNCH_GRACE_MS = 2000;
const session: SessionRecord = { id: ID, cwd: "/work", transcriptPath: "/transcript", pid: 42, pidCreated: CREATED, startedAt: CREATED, endedAt: CREATED };
const raw = { session_id: ID, cwd: session.cwd, transcript_path: session.transcriptPath, pid: session.pid, pid_created: session.pidCreated, started_at: CREATED, ended_at: CREATED, config_dir: "/cfg/1-test" };
const code = (result: { ok: true } | { ok: false; error: { code: string } }): string => result.ok ? "ok" : result.error.code;
const setup = () => {
	const h = createMemoryRuntime();
	h.fs.directories.add("/work");
	h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify(raw));
	h.fs.seed(`${ROOT}/state.json`, JSON.stringify({ mode: "dev", paths: { repo: "/repo", hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null }));
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
		h.runtime.process.run = async (_command, args) => { calls.push([...args]); return ok({ stdout: '{"accounts":{"/cfg/1-test":{"present":true,"account":12}},"categories":{}}', stderr: "", exitCode: 0 }); };
		await runSession(h.runtime, session, "plan", null, async () => apiOk(null));
		expect(calls.length).toBe(1);
		expect(calls[0]).toContain("batch");
		expect(calls[0]).toContain("/cfg/1-test");
		expect(h.fs.textReads.some((path) => path.endsWith("/usage.json"))).toBe(false);
	});
	test("account helper failures prevent launch", async () => {
		const h = setup();
		h.fs.seed(`${ROOT}/state.json`, JSON.stringify({ mode: "dev", paths: { repo: "/repo", hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null }));
		for (const output of [ok({ stdout: "", stderr: "broken", exitCode: 2 }), ok({ stdout: "garbage", stderr: "", exitCode: 0 })]) {
			h.runtime.process.run = async () => output;
			let launched = false;
			const result = await runSession(h.runtime, session, "plan", null, async () => { launched = true; return apiOk(null); });
			expect(code(result)).toBe("launch-invalid");
			expect(launched).toBe(false);
		}
	});
	test("uses catalogue errors in both languages", async () => {
		for (const language of ["en", "ru"] as const) {
			const h = setup();
			h.runtime.language = language;
			const result = await prepareLaunch(h.runtime, session, "1", "unknown", true);
			expect(result.ok ? "ok" : result.error.message).toBe(messagesFor(language).session.launchMode());
		}
	});
	test("builds commands for every platform and rejects unsafe inputs", async () => {
		const h = setup();
		const facts = { platform: "windows", cwd: "/work", session: ID, account: "12", mode: "plan", plugins: ["custom@market"], cswap: true, display: false, terminal: false, tmux: false } as const;
		expect(buildLaunchCommand({ ...facts, plugins: [...facts.plugins] })).toEqual(["cmd.exe", "/c", "start", "", "wt.exe", "-w", "new", "-d", "/work", "cmd.exe", "/c", `cswap.exe run 12 --share-history -- --channels plugin:custom@market --resume ${ID} --permission-mode plan & exit /b 0`]);
		expect(buildLaunchCommand({ ...facts, plugins: [], account: "", mode: null, cswap: false })).toEqual(["cmd.exe", "/c", "start", "", "wt.exe", "-w", "new", "-d", "/work", "cmd.exe", "/c", `claude --resume ${ID} & exit /b 0`]);
		expect(buildLaunchCommand({ ...facts, plugins: [], account: "", mode: null })).toContain(`cswap.exe run --share-history -- --resume ${ID} & exit /b 0`);
		expect(buildLaunchCommand({ ...facts, platform: "darwin", plugins: [], cwd: "/a b/c'd", cswap: false, mode: null })).toEqual(["osascript", "-e", "on run argv", "-e", 'tell application "Terminal" to do script (item 1 of argv)', "-e", "end run", "--", `cd -- '/a b/c'\\''d' && exec 'claude' '--resume' '${ID}'`]);
		expect(buildLaunchCommand({ ...facts, platform: "linux", plugins: [], display: true, terminal: true })).toEqual(["x-terminal-emulator", "-e", "sh", "-c", 'cd -- "$1" && shift && exec "$@"', "sh", "/work", "cswap", "run", "12", "--share-history", "--", "--resume", ID, "--permission-mode", "plan"]);
		expect(buildLaunchCommand({ ...facts, platform: "linux", plugins: [], tmux: true })).toEqual(["tmux", "new-session", "-d", "-c", "/work", "cswap", "run", "12", "--share-history", "--", "--resume", ID, "--permission-mode", "plan"]);
		expect(buildLaunchCommand({ ...facts, platform: "linux", plugins: [] })).toBeNull();
		for (const [account, mode] of [["bad&", "plan"], ["1", "unknown"]]) expect(code(await prepareLaunch(h.runtime, session, account, mode, true))).toBe("launch-invalid");
		const windows = createMemoryRuntime("windows");
		for (const character of ['"', "%", "&", "|", "<", ">", "^"]) expect(code(await prepareLaunch(windows.runtime, { ...session, cwd: `C:/bad${character}dir` }, "1", "plan", true))).toBe("launch-invalid");
		h.runtime.process.isAvailable = async () => false;
		expect(code(await prepareLaunch(h.runtime, session, "1", null, true))).toBe("launch-invalid");
		expect(code(await prepareLaunch(h.runtime, session, "", null, false))).toBe("launch-unavailable");
	});
	test("reads last transcript mode including default and malformed records", async () => {
		const h = setup();
		h.fs.seed("/transcript", `${JSON.stringify({ type: "permission-mode", permissionMode: "plan" })}\ninvalid\n${JSON.stringify({ type: "permission-mode", permissionMode: "default" })}\n`);
		expect(await transcriptMode(h.runtime, "/transcript")).toBe("manual");
		expect(await modeCommand(h.runtime, [ID, "manual"], () => {})).toEqual(apiOk({ session: ID, mode: "manual", changed: false }));
	});
	test("resolves channels from the enabled feature and hub marketplace manifests", async () => {
		const h = setup();
		h.fs.seed(`${ROOT}/state.json`, JSON.stringify({ mode: "dev", paths: { repo: "/repo", hub: "/hub" }, features: { telegram: true }, records: {}, badPairs: [], pendingHubRestart: null }));
		seedFeature(h.fs, "/repo", { ...baseManifest(), name: "telegram", plugins: ["test-channel"] });
		seedHubManifest(h.fs, "/hub", "test-market");
		const result = await prepareLaunch(h.runtime, session, "", null, false);
		expect(result.ok && result.value).toContain("plugin:test-channel@test-market");
	});
	test("selects display terminal or tmux from runtime facts", async () => {
		const h = setup();
		h.environment.set("WAYLAND_DISPLAY", "wayland-1");
		let result = await prepareLaunch(h.runtime, session, "", null, false);
		expect(result.ok && result.value[0]).toBe("x-terminal-emulator");
		h.unavailableCommands.add("x-terminal-emulator");
		result = await prepareLaunch(h.runtime, session, "", null, false);
		expect(result.ok && result.value[0]).toBe("tmux");
		h.unavailableCommands.add("tmux");
		expect(code(await prepareLaunch(h.runtime, session, "", null, false))).toBe("launch-unavailable");
		h.unavailableCommands.delete("tmux");
		h.unavailableCommands.add("cswap");
		result = await prepareLaunch(h.runtime, session, "12", null, false);
		expect(result.ok && result.value).toEqual(["tmux", "new-session", "-d", "-c", "/work", "claude", "--resume", ID]);
	});
	test("reports spawn failure and timeout", async () => {
		const h = setup();
		expect(code(await runSession(h.runtime, session, "plan", "1", async () => apiFail("launch-failed", "stderr")))).toBe("launch-failed");
		expect(code(await runSession(h.runtime, session, "plan", "1", async () => apiOk(null)))).toBe("launch-timeout");
	});
	test("reports stderr from detached launch failure", async () => {
		const h = setup();
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
