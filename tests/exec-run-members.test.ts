import { describe, expect, test } from "bun:test";

import { countGroupMembers } from "../src/commands/run-members.js";
import { EXEC_RUN_POLL_MS, runExecRunner, startExec, statusExec, stopCameAfterEmpty, stopExec } from "../src/exec-core.js";
import { apiOk } from "../src/output.js";
import { err, ok } from "../src/result.js";
import { createMemoryRuntime, streamed } from "./fakes/memory-runtime.js";

const HOME = "/home/test";
const ROOT = `${HOME}/.agent-rig/exec`;
const RUN = `${ROOT}/event-1`;
const PID = 100;
const COMMAND_CODE = 7;
const BASE_TIME_MS = Date.parse("2026-10-30T00:00:00.000Z");
const TICK_MS = 1_000;
// How many polls the background process stays alive in the first scenario.
const BUSY_POLLS = 2;

const seed = () => {
	const h = createMemoryRuntime("linux");
	h.fs.seed(`${HOME}/.agent-rig/state.json`, JSON.stringify({ mode: "dev", paths: { repo: "/repo", hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null }));
	h.fs.directories.add("/work");
	h.runtime.lock.process.pid = PID;
	h.runtime.process.createdAt = async () => ok({ [PID]: "born" });
	return h;
};
const build = async () => apiOk({ argv: ["fake"], env: {}, files: [] });
// A clock whose every reading is one tick later than the previous one, so "before" and "after" are decided by order.
const advancingClock = (h: ReturnType<typeof seed>): void => {
	let tick = 0;
	h.runtime.clock.nowText = () => new Date(BASE_TIME_MS + tick++ * TICK_MS).toISOString();
};

describe("a run is one unit of all its processes", () => {
	test("a command that exits with a background process alive keeps the run running, then ends with the command's code", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "sleep 3 & echo started");
		const states: string[] = [];
		const order: string[] = [];
		const sleeps: number[] = [];
		let polls = 0;
		h.runtime.process.runStreaming = async () => ok({ code: COMMAND_CODE, finishOutput: async () => { order.push("output-finished"); return ok(undefined); } });
		h.runtime.process.runMembers = async () => {
			polls += 1;
			const status = await statusExec(h.runtime, "event-1", 0);
			const value = status.ok ? status.value : null;
			states.push(typeof value === "object" && value !== null && !Array.isArray(value) ? String(value.state) : "?");
			order.push(`members-${polls <= BUSY_POLLS ? "busy" : "empty"}`);
			return ok(polls <= BUSY_POLLS ? 1 : 0);
		};
		h.runtime.clock.sleep = async (ms) => { sleeps.push(ms); };
		expect(await runExecRunner(h.runtime, "event-1", build)).toBe(0);
		expect(states).toEqual(["running", "running", "running"]);
		expect(sleeps).toEqual(Array.from({ length: BUSY_POLLS }, () => EXEC_RUN_POLL_MS));
		expect(order).toEqual(["members-busy", "members-busy", "members-empty", "output-finished"]);
		expect(await statusExec(h.runtime, "event-1", 0)).toMatchObject({ ok: true, value: { state: "ended", end: { kind: "exit", code: COMMAND_CODE } } });
	});

	test("a stop of such a run kills everything and ends stopped", async () => {
		const h = seed();
		advancingClock(h);
		await startExec(h.runtime, "bash", "/work", "sleep 99 & echo started");
		let killed = false;
		let live = true;
		let enteredWait: () => void = () => {};
		const waiting = new Promise<void>((resolve) => { enteredWait = resolve; });
		h.runtime.process.runStreaming = async () => streamed(0);
		h.runtime.process.runMembers = async () => { enteredWait(); return ok(killed && !live ? 0 : 1); };
		const runner = runExecRunner(h.runtime, "event-1", build);
		await waiting;
		const groups: number[] = [];
		h.runtime.process.killGroup = async (pid) => {
			groups.push(pid);
			killed = true;
			live = false;
			await runner;
			return ok(undefined);
		};
		expect(await stopExec(h.runtime, "event-1")).toMatchObject({ ok: true, value: { state: "ended" } });
		expect(groups).toEqual([PID]);
		expect(await statusExec(h.runtime, "event-1", 0)).toMatchObject({ ok: true, value: { state: "ended", end: { kind: "stopped", code: null } } });
	});

	test("a stop request written after the run had emptied ends with the real code and kills nothing", async () => {
		const h = seed();
		advancingClock(h);
		await startExec(h.runtime, "bash", "/work", "echo hi");
		const killed: number[] = [];
		h.runtime.process.killGroup = async (pid) => { killed.push(pid); return ok(undefined); };
		let stopReply: unknown = null;
		h.runtime.process.runMembers = async () => ok(0);
		h.runtime.process.runStreaming = async () => ok({
			code: COMMAND_CODE,
			// The runner has observed the empty run and has not recorded the end yet when the request arrives.
			finishOutput: async () => { stopReply = await stopExec(h.runtime, "event-1"); return ok(undefined); },
		});
		expect(await runExecRunner(h.runtime, "event-1", build)).toBe(0);
		expect(stopReply).toMatchObject({ ok: true, value: { stopping: true } });
		expect(killed).toEqual([]);
		expect(await statusExec(h.runtime, "event-1", 0)).toMatchObject({ ok: true, value: { state: "ended", end: { kind: "exit", code: COMMAND_CODE } } });
	});

	test("a stop request in the same tick as the empty run counts as a stop", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "echo hi");
		h.runtime.process.runMembers = async () => ok(0);
		h.runtime.process.runStreaming = async () => ok({ code: COMMAND_CODE, finishOutput: async () => { await stopExec(h.runtime, "event-1"); return ok(undefined); } });
		await runExecRunner(h.runtime, "event-1", build);
		expect(await statusExec(h.runtime, "event-1", 0)).toMatchObject({ ok: true, value: { end: { kind: "stopped", code: null } } });
	});

	test("a run that cannot be counted counts as empty", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "echo hi");
		h.runtime.process.runStreaming = async () => streamed(COMMAND_CODE);
		h.runtime.process.runMembers = async () => err("ps failed");
		expect(await runExecRunner(h.runtime, "event-1", build)).toBe(0);
		expect(await statusExec(h.runtime, "event-1", 0)).toMatchObject({ ok: true, value: { end: { kind: "exit", code: COMMAND_CODE } } });
		expect(h.fs.files.has(`${RUN}/run-empty`)).toBe(true);
	});
});

describe("a stop request against the time the run emptied", () => {
	const EMPTY = "2026-10-30T00:00:00.000Z";
	test.each([
		["the run emptied before the request", "2026-10-30T00:00:01.000Z", EMPTY, true],
		["the request came first", EMPTY, "2026-10-30T00:00:01.000Z", false],
		["the same instant", EMPTY, EMPTY, false],
		["the run never emptied", EMPTY, null, false],
		["the request time does not parse", "", EMPTY, false],
		["the empty time does not parse", EMPTY, "garbage", false],
	] as const)("%s", (_name, request, empty, expected) => {
		expect(stopCameAfterEmpty(request, empty)).toBe(expected);
	});
});

describe("counting the members of a POSIX run", () => {
	const TABLE = ["  100   100 Ss", "  101   100 S", "  102   100 Z", "  103   100 R+", "  200   200 S", "garbage", ""].join("\n");
	test("counts live group members other than the runner; zombies, other groups and unparsable rows are not members", () => {
		expect(countGroupMembers(TABLE, 100, 100)).toBe(2);
		expect(countGroupMembers(TABLE, 200, 100)).toBe(1);
		expect(countGroupMembers(TABLE, 300, 100)).toBe(0);
	});
});
