import { describe, expect, test } from "bun:test";

import { EXEC_LOG_CHUNK_BYTES, EXEC_MAX_RUNS, EXEC_STALE_MS, listExecs, runExecRunner, startExec, statusExec, stopExec } from "../src/exec-core.js";
import { apiOk } from "../src/output.js";
import { err, ok } from "../src/result.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";

const HOME = "/home/test";
const ROOT = `${HOME}/.agent-rig/exec`;
const NOW = "2026-10-30T00:00:00.000Z";
const PID = 100;
const seed = (platform: Parameters<typeof createMemoryRuntime>[0] = "linux") => {
	const h = createMemoryRuntime(platform);
	h.fs.seed(`${HOME}/.agent-rig/state.json`, JSON.stringify({ mode: "dev", paths: { repo: "/repo", hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null }));
	h.fs.directories.add("/work");
	h.runtime.lock.process.pid = PID;
	h.runtime.process.createdAt = async () => ok({ [PID]: "born" });
	return h;
};

describe("exec core", () => {
	test("start writes a record and spawns a runner; status pages bytes and reads exit", async () => {
		const h = seed();
		let argv: readonly string[] = [];
		h.runtime.process.spawnDetached = async (command) => { argv = command; return ok({ exited: false, exitCode: null, stderr: "", pid: PID }); };
		const started = await startExec(h.runtime, "bash", "/work", "echo hi");
		expect(started.ok).toBe(true);
		expect(argv.slice(-2)).toEqual(["exec-runner", "event-1"]);
		expect(h.fs.files.get(`${ROOT}/event-1/record.json`)).toContain("echo hi");
		h.fs.seed(`${ROOT}/event-1/log`, "x".repeat(EXEC_LOG_CHUNK_BYTES + 2));
		const first = await statusExec(h.runtime, "event-1", 0);
		expect(first.ok && first.value).toMatchObject({ state: "running", log: { from: 0, to: EXEC_LOG_CHUNK_BYTES, size: EXEC_LOG_CHUNK_BYTES + 2 } });
		const second = await statusExec(h.runtime, "event-1", EXEC_LOG_CHUNK_BYTES);
		expect(second.ok && second.value).toMatchObject({ log: { from: EXEC_LOG_CHUNK_BYTES, to: EXEC_LOG_CHUNK_BYTES + 2, text: "xx" } });
		h.fs.seed(`${ROOT}/event-1/exit.json`, JSON.stringify({ kind: "exit", code: 3, at: NOW }));
		const ended = await statusExec(h.runtime, "event-1", 0);
		expect(ended.ok && ended.value).toMatchObject({ state: "ended", end: { kind: "exit", code: 3 } });
	});

	test("stop verifies process identity, kills its tree, and reports stopped", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "echo hi");
		h.fs.seed(`${ROOT}/event-1/identity.json`, JSON.stringify({ pid: PID, pidCreated: "born" }));
		const killed: number[] = [];
		h.runtime.process.killGroup = async (pid) => { killed.push(pid); return ok(undefined); };
		expect((await stopExec(h.runtime, "event-1")).ok).toBe(true);
		expect(killed).toEqual([PID]);
		const state = await statusExec(h.runtime, "event-1", 0);
		expect(state.ok && state.value).toMatchObject({ state: "ended", end: { kind: "stopped" } });
	});

	test("stop on POSIX kills the runner's process group, on Windows its process tree", async () => {
		for (const platform of ["linux", "darwin", "windows"] as const) {
			const h = seed(platform);
			await startExec(h.runtime, "bash", "/work", "echo hi");
			h.fs.seed(`${ROOT}/event-1/identity.json`, JSON.stringify({ pid: PID, pidCreated: "born" }));
			const calls: string[] = [];
			h.runtime.process.killTree = async (pid) => { calls.push(`tree:${pid}`); return ok(undefined); };
			h.runtime.process.killGroup = async (pid) => { calls.push(`group:${pid}`); return ok(undefined); };
			expect((await stopExec(h.runtime, "event-1")).ok).toBe(true);
			expect(calls).toEqual([platform === "windows" ? `tree:${PID}` : `group:${PID}`]);
		}
	});

	test("paging never splits a UTF-8 character between responses", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "echo hi");
		h.fs.seed(`${ROOT}/event-1/log`, `${"x".repeat(EXEC_LOG_CHUNK_BYTES - 1)}\u20ac`);
		const first = await statusExec(h.runtime, "event-1", 0);
		expect(first.ok && first.value).toMatchObject({ log: { to: EXEC_LOG_CHUNK_BYTES - 1, text: "x".repeat(EXEC_LOG_CHUNK_BYTES - 1) } });
		const second = await statusExec(h.runtime, "event-1", EXEC_LOG_CHUNK_BYTES - 1);
		expect(second.ok && second.value).toMatchObject({ log: { text: "\u20ac", to: EXEC_LOG_CHUNK_BYTES + 2 } });
	});

	test("a reused PID is never killed", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "echo hi");
		h.fs.seed(`${ROOT}/event-1/identity.json`, JSON.stringify({ pid: PID, pidCreated: "born" }));
		h.runtime.process.createdAt = async () => ok({ [PID]: "different" });
		let killed = false;
		h.runtime.process.killGroup = async () => { killed = true; return ok(undefined); };
		await stopExec(h.runtime, "event-1");
		expect(killed).toBe(false);
		const state = await statusExec(h.runtime, "event-1", 0);
		expect(state.ok && state.value).toMatchObject({ state: "ended", end: { kind: "lost" } });
	});

	test("stale heartbeat is lost and unsafe ids are refused", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "echo hi");
		h.runtime.clock.now = () => new Date(Date.parse(NOW) + EXEC_STALE_MS);
		const state = await statusExec(h.runtime, "event-1", 0);
		expect(state.ok && state.value).toMatchObject({ state: "ended", end: { kind: "lost" } });
		expect((await statusExec(h.runtime, "../bad", 0)).ok).toBe(false);
		expect((await stopExec(h.runtime, "../bad")).ok).toBe(false);
	});

	test("a stop before the runner's identity is held: no kill, and the runner ends the run stopped without launching a shell", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "echo hi");
		let killed = false;
		h.runtime.process.killGroup = async () => { killed = true; return ok(undefined); };
		h.runtime.process.killTree = async () => { killed = true; return ok(undefined); };
		expect(await stopExec(h.runtime, "event-1")).toMatchObject({ ok: true, value: { id: "event-1", stopping: true } });
		expect(killed).toBe(false);
		expect(h.fs.files.has(`${ROOT}/event-1/stop-request`)).toBe(true);
		let built = false;
		let launched = false;
		h.runtime.process.runStreaming = async () => { launched = true; return ok(0); };
		expect(await runExecRunner(h.runtime, "event-1", async () => { built = true; return apiOk({ argv: ["fake"], env: {}, files: [] }); })).toBe(0);
		expect(built).toBe(false);
		expect(launched).toBe(false);
		expect(await statusExec(h.runtime, "event-1", 0)).toMatchObject({ ok: true, value: { state: "ended", end: { kind: "stopped" } } });
	});

	test("a stop request for a runner that never starts ends lost by the stale heartbeat", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "echo hi");
		expect(await stopExec(h.runtime, "event-1")).toMatchObject({ ok: true, value: { stopping: true } });
		h.runtime.clock.now = () => new Date(Date.parse(NOW) + EXEC_STALE_MS);
		expect(await statusExec(h.runtime, "event-1", 0)).toMatchObject({ ok: true, value: { state: "ended", end: { kind: "lost" } } });
	});

	test("a stop whose identity appears while the request is written is still honoured by a kill", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "echo hi");
		const writeText = h.fs.writeText.bind(h.fs);
		h.fs.writeText = async (path, value) => {
			// The runner writes its identity right after the stop found none, then checks for the request.
			if (path.endsWith("/stop-request")) h.fs.seed(`${ROOT}/event-1/identity.json`, JSON.stringify({ pid: PID, pidCreated: "born" }));
			return writeText(path, value);
		};
		const killed: number[] = [];
		h.runtime.process.killGroup = async (pid) => { killed.push(pid); return ok(undefined); };
		expect(await stopExec(h.runtime, "event-1")).toMatchObject({ ok: true, value: { id: "event-1", stopping: true } });
		expect(killed).toEqual([PID]);
		expect(await statusExec(h.runtime, "event-1", 0)).toMatchObject({ ok: true, value: { state: "ended", end: { kind: "stopped" } } });
	});

	test("retention removes oldest ended runs, and disabled Windows shells are refused", async () => {
		const h = seed();
		for (let index = 0; index < EXEC_MAX_RUNS + 1; index += 1) {
			const id = `old-${index}`;
			h.fs.seed(`${ROOT}/${id}/record.json`, JSON.stringify({ id, shell: "bash", cwd: "/work", text: "", startedAt: new Date(Date.parse(NOW) - (index + 1) * 1000).toISOString() }));
			h.fs.seed(`${ROOT}/${id}/exit.json`, JSON.stringify({ kind: "exit", code: 0, at: NOW }));
		}
		await startExec(h.runtime, "bash", "/work", "echo hi");
		const list = await listExecs(h.runtime);
		expect(list.ok && list.value.runs.length).toBe(EXEC_MAX_RUNS);
		expect(h.fs.directories.has(`${ROOT}/old-${EXEC_MAX_RUNS}`)).toBe(false);
		const windows = seed();
		windows.runtime.platform = "windows";
		expect((await startExec(windows.runtime, "pwsh", "/work", "echo hi")).ok).toBe(false);
		expect((await startExec(windows.runtime, "cmd", "/work", "echo hi")).ok).toBe(false);
	});

	test("runner uses the injected builder and records output and exit", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "echo hi");
		h.runtime.process.runStreaming = async (_argv, _cwd, _env, append) => { await append(new TextEncoder().encode("one\ntwo\n")); return ok(3); };
		expect(await runExecRunner(h.runtime, "event-1", async () => apiOk({ argv: ["fake"], env: {}, files: [] }))).toBe(0);
		const state = await statusExec(h.runtime, "event-1", 0);
		expect(state.ok && state.value).toMatchObject({ end: { kind: "exit", code: 3 }, log: { text: "one\ntwo\n" } });
	});

	test("exec never uses the rig lock and requests a hidden runner", async () => {
		const h = seed();
		let lockCalls = 0;
		const writeExclusive = h.fs.writeExclusive.bind(h.fs);
		h.fs.writeExclusive = async (path, value) => { if (path.endsWith("/rig.lock")) lockCalls += 1; return writeExclusive(path, value); };
		let hidden = false;
		h.runtime.process.spawnDetached = async (_command, _grace, _limit, _path, options) => { hidden = options?.windowsHide === true; return ok({ exited: false, exitCode: null, stderr: "", pid: PID }); };
		await startExec(h.runtime, "bash", "/work", "echo hi");
		await listExecs(h.runtime);
		await statusExec(h.runtime, "event-1", 0);
		await runExecRunner(h.runtime, "event-1", async () => apiOk({ argv: ["fake"], env: {}, files: [] }));
		await stopExec(h.runtime, "event-1");
		expect(lockCalls).toBe(0);
		expect(hidden).toBe(true);
	});

	test("record is published after the initial log and heartbeat", async () => {
		const h = seed();
		const writeExclusive = h.fs.writeExclusive.bind(h.fs);
		let complete = false;
		h.fs.writeExclusive = async (path, value) => {
			if (path.endsWith("/record.json")) complete = h.fs.files.has(`${ROOT}/event-1/log`) && h.fs.files.has(`${ROOT}/event-1/heartbeat`);
			return writeExclusive(path, value);
		};
		await startExec(h.runtime, "bash", "/work", "echo hi");
		expect(complete).toBe(true);
	});

	test("runner records identity before launch and a child closing during stop ends stopped", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "echo hi");
		expect(h.fs.files.has(`${ROOT}/event-1/identity.json`)).toBe(false);
		let closeChild: () => void = () => {};
		let launched: () => void = () => {};
		const ready = new Promise<void>((resolve) => { launched = resolve; });
		h.runtime.process.runStreaming = async () => {
			expect(h.fs.files.get(`${ROOT}/event-1/identity.json`)).toBe(JSON.stringify({ pid: PID, pidCreated: "born" }));
			launched();
			await new Promise<void>((resolve) => { closeChild = resolve; });
			return ok(0);
		};
		const runner = runExecRunner(h.runtime, "event-1", async () => apiOk({ argv: ["fake"], env: {}, files: [] }));
		await ready;
		h.runtime.process.killGroup = async () => {
			closeChild();
			await runner;
			return ok(undefined);
		};
		expect((await stopExec(h.runtime, "event-1"))).toMatchObject({ ok: true, value: { state: "ended" } });
		expect((await statusExec(h.runtime, "event-1", 0))).toMatchObject({ ok: true, value: { end: { kind: "stopped" } } });
		const other = seed();
		await startExec(other.runtime, "bash", "/work", "echo hi");
		other.fs.seed(`${ROOT}/event-1/identity.json`, JSON.stringify({ pid: PID, pidCreated: "born" }));
		await stopExec(other.runtime, "event-1");
		await runExecRunner(other.runtime, "event-1", async () => apiOk({ argv: ["fake"], env: {}, files: [] }));
		expect((await statusExec(other.runtime, "event-1", 0))).toMatchObject({ ok: true, value: { end: { kind: "stopped" } } });
	});

	test("a failed kill removes the stop request and leaves the run running", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "echo hi");
		h.fs.seed(`${ROOT}/event-1/identity.json`, JSON.stringify({ pid: PID, pidCreated: "born" }));
		h.runtime.process.killGroup = async () => err("kill failed");
		expect(await stopExec(h.runtime, "event-1")).toMatchObject({ ok: false });
		expect(h.fs.files.has(`${ROOT}/event-1/stop-request`)).toBe(false);
		expect(await statusExec(h.runtime, "event-1", 0)).toMatchObject({ ok: true, value: { state: "running" } });
		await runExecRunner(h.runtime, "event-1", async () => apiOk({ argv: ["fake"], env: {}, files: [] }));
		expect(await statusExec(h.runtime, "event-1", 0)).toMatchObject({ ok: true, value: { end: { kind: "exit" } } });
	});

	test("broken entries do not prevent listing or starting and invalid records are pruned", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "echo hi");
		await h.fs.ensureDirectory(`${ROOT}/missing`);
		h.fs.seed(`${ROOT}/invalid/record.json`, "{");
		for (const id of ["no-heartbeat", "bad-end"]) {
			h.fs.seed(`${ROOT}/${id}/record.json`, JSON.stringify({ id, shell: "bash", cwd: "/work", text: "", startedAt: NOW }));
		}
		h.fs.seed(`${ROOT}/bad-end/heartbeat`, NOW);
		h.fs.seed(`${ROOT}/bad-end/exit.json`, "{");
		const listed = await listExecs(h.runtime);
		expect(listed.ok && listed.value.runs).toHaveLength(3);
		if (listed.ok) for (const id of ["no-heartbeat", "bad-end"]) expect(listed.value.runs.find((run) => run.id === id)).toMatchObject({ state: "ended", end: { kind: "lost", reason: expect.any(String) } });
		expect((await statusExec(h.runtime, "invalid", 0)).ok).toBe(false);
		expect((await stopExec(h.runtime, "missing")).ok).toBe(false);
		expect((await startExec(h.runtime, "bash", "/work", "echo hi")).ok).toBe(true);
		expect(h.fs.directories.has(`${ROOT}/missing`)).toBe(false);
		expect(h.fs.directories.has(`${ROOT}/invalid`)).toBe(false);
	});

	test("invalid heartbeat and unreadable end are reported as lost", async () => {
		const h = seed();
		for (const id of ["invalid-beat", "unreadable-end"]) {
			h.fs.seed(`${ROOT}/${id}/record.json`, JSON.stringify({ id, shell: "bash", cwd: "/work", text: "", startedAt: NOW }));
			h.fs.seed(`${ROOT}/${id}/heartbeat`, id === "invalid-beat" ? "invalid" : NOW);
		}
		h.fs.seed(`${ROOT}/unreadable-end/exit.json`, "{}");
		const readText = h.fs.readText.bind(h.fs);
		h.fs.readText = async (path) => { if (path.endsWith("/unreadable-end/exit.json")) throw new Error("unreadable"); return readText(path); };
		const listed = await listExecs(h.runtime);
		if (!listed.ok) throw new Error("list failed");
		for (const id of ["invalid-beat", "unreadable-end"]) expect(listed.value.runs.find((run) => run.id === id)).toMatchObject({ state: "ended", end: { kind: "lost", reason: expect.any(String) } });
	});
});
