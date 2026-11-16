import type { SessionRecord } from "../src/session-core.js";

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.js";
import { apiOk } from "../src/output.js";
import { lookupSession, listSessions, requestSession, sessionLive, SESSION_POLL_MS } from "../src/session-core.js";
import { ok } from "../src/result.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";

const ROOT = "/home/test/.agent-rig/sessions";
const CREATED = "2026-01-01T00:00:00.000000Z";
const record: SessionRecord = { id: "abc", cwd: "/work", transcriptPath: "/transcript", startedAt: "2026-01-01T00:00:00Z", processes: [{ pid: 42, pidCreated: CREATED, startedAt: "2026-01-01T00:00:00Z" }] };
const raw = { session_id: record.id, cwd: record.cwd, transcript_path: record.transcriptPath, started_at: record.startedAt };
const processFile = { pid: 42, pid_created: CREATED, started_at: record.startedAt, source: "startup", config_dir: "" };

const setup = () => {
	const h = createMemoryRuntime();
	h.fs.seed(`${ROOT}/abc.json`, JSON.stringify(raw));
	h.fs.seed(`${ROOT}/abc/usage.json`, "{}");
	h.fs.seed(`${ROOT}/abc/processes/42.json`, JSON.stringify(processFile));
	h.runtime.process.createdAt = async (pids) => ok(Object.fromEntries(pids.map((pid) => [String(pid), CREATED])));
	let now = 0;
	h.runtime.clock.now = () => new Date(now);
	h.runtime.clock.sleep = async (ms) => { now += ms; };
	return h;
};

describe("session core", () => {
	test("rejects unsafe and unknown ids before accessing their paths", async () => {
		const h = setup();
		for (const id of ["../abc", "a/b", "a.b", "x".repeat(65)]) {
			const answer = await lookupSession(h.runtime, id);
			expect(answer.ok ? "ok" : answer.error.code).toBe("session-bad-id");
		}
		expect(h.fs.textReads).toEqual([]);
		const missing = await lookupSession(h.runtime, "missing");
		expect(missing.ok ? "ok" : missing.error.code).toBe("session-unknown");
	});
	test("ended and reused processes are not live", async () => {
		const h = setup();
		expect(await sessionLive(h.runtime, { ...record, processes: [] })).toEqual(apiOk(false));
		h.runtime.process.createdAt = async () => ok({ "42": "different" });
		expect(await sessionLive(h.runtime, record)).toEqual(apiOk(false));
	});
	test("requires the module directory", async () => {
		const h = setup();
		h.fs.files.delete(`${ROOT}/abc/usage.json`);
		const answer = await requestSession(h.runtime, record, "usage", {}, SESSION_POLL_MS);
		expect(answer.ok ? "ok" : answer.error.code).toBe("session-no-module");
	});
	test("reads and removes success and error responses", async () => {
		for (const response of [{ id: "event-1", ok: true, result: { value: 1 } }, { id: "event-1", ok: false, error: "module failed" }]) {
			const h = setup();
			h.fs.seed(`${ROOT}/abc/responses/event-1.json`, JSON.stringify(response));
			const answer = await requestSession(h.runtime, record, "usage", {}, SESSION_POLL_MS);
			expect(answer.ok).toBe(response.ok);
			if (!answer.ok) expect(answer.error.message).toBe("module failed");
			expect(h.fs.files.has(`${ROOT}/abc/responses/event-1.json`)).toBe(false);
		}
	});
	test("tolerates one partial response and reports waiting", async () => {
		const h = setup();
		const path = `${ROOT}/abc/responses/event-1.json`;
		h.fs.seed(path, "{");
		let now = 0;
		h.runtime.clock.now = () => new Date(now);
		h.runtime.clock.sleep = async (ms) => { now += ms; h.fs.seed(path, JSON.stringify({ id: "event-1", ok: true, result: 7 })); };
		expect(await requestSession(h.runtime, record, "usage", {}, SESSION_POLL_MS * 3)).toEqual(apiOk(7));
	});
	test("timeout and process exit remove the published request", async () => {
		for (const exits of [false, true]) {
			const h = setup();
			let now = 0;
			h.runtime.clock.now = () => new Date(now);
			const calls: number[] = [];
			h.runtime.process.createdAt = async () => { calls.push(now); return ok({ "42": exits && now > 0 ? null : CREATED }); };
			h.runtime.clock.sleep = async (ms) => { now += ms; };
			const events: string[] = [];
			const answer = await requestSession(h.runtime, record, "usage", {}, SESSION_POLL_MS * 3, (event) => events.push(event.code));
			expect(answer.ok ? "ok" : answer.error.code).toBe(exits ? "session-ended" : "session-timeout");
			expect(calls).toEqual([0, SESSION_POLL_MS * 3]);
			expect(h.fs.files.has(`${ROOT}/abc/requests/event-1.json`)).toBe(false);
			if (!exits) expect(events).toEqual(["session-waiting"]);
		}
	});
	test("removed process files stop waiting without another process query", async () => {
		const h = setup();
		let calls = 0;
		h.runtime.process.createdAt = async () => { calls++; return ok({ "42": CREATED }); };
		h.runtime.clock.sleep = async () => { h.fs.files.delete(`${ROOT}/abc/processes/42.json`); };
		const answer = await requestSession(h.runtime, record, "usage", {}, SESSION_POLL_MS * 3);
		expect(answer.ok ? "ok" : answer.error.code).toBe("session-ended");
		expect(calls).toBe(1);
	});
	test("list batches distinct live pids and isolates invalid records", async () => {
		const h = setup();
		h.fs.seed(`${ROOT}/second.json`, JSON.stringify({ ...raw, session_id: "second" }));
		h.fs.seed(`${ROOT}/second/processes/43.json`, JSON.stringify({ ...processFile, pid: 43 }));
		h.fs.seed(`${ROOT}/broken.json`, "{");
		const calls: number[][] = [];
		h.runtime.process.createdAt = async (pids) => { calls.push([...pids]); return ok({ "42": CREATED, "43": CREATED }); };
		const result = await listSessions(h.runtime);
		expect(calls).toHaveLength(1);
		expect(new Set(calls[0])).toEqual(new Set([42, 43]));
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.sessions).toHaveLength(3);
			expect(result.value.sessions.find((entry) => entry.id === "broken")).toEqual({ id: "broken", error: { code: "session-invalid", message: expect.any(String) } });
			expect(result.value.sessions.filter((entry) => "live" in entry && entry.live)).toHaveLength(2);
		}
	});
	test("list returns raw fields in newest order and CLI emits one object", async () => {
		const h = setup();
		h.fs.seed(`${ROOT}/older.json`, JSON.stringify({ ...raw, session_id: "older", started_at: "2025-01-01T00:00:00Z" }));
		const result = await listSessions(h.runtime);
		expect(result).toEqual(apiOk({ sessions: [{ id: "abc", cwd: "/work", transcriptPath: "/transcript", pid: 42, processes: [{ pid: 42, startedAt: record.startedAt }], startedAt: record.startedAt, live: true, module: true }, { id: "older", cwd: "/work", transcriptPath: "/transcript", pid: null, processes: [], startedAt: "2025-01-01T00:00:00Z", live: false, module: false }] }));
		const output: string[] = [];
		expect(await runCli(["session", "list"], (line) => output.push(line), h.runtime)).toBe(0);
		expect(output).toHaveLength(1);
		expect(JSON.parse(output[0])).toEqual(result.ok ? result.value : null);
	});
});
