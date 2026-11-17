import { describe, expect, test } from "bun:test";

import { countGroupMembers, groupMemberPids } from "../src/commands/run-members.js";
import { EXEC_RUN_POLL_MS, EXEC_STALE_MS, EXEC_STOP_GRACE_MS, runExecRunner, startExec, statusExec, stopExec } from "../src/exec-core.js";
import { apiOk } from "../src/output.js";
import { err, ok } from "../src/result.js";
import { createMemoryRuntime, streamed } from "./fakes/memory-runtime.js";

const HOME = "/home/test";
const ROOT = `${HOME}/.agent-rig/exec`;
const RUN = `${ROOT}/event-1`;
const PID = 100;
const COMMAND_CODE = 7;
const BASE_TIME_MS = Date.parse("2026-10-30T00:00:00.000Z");
// How many polls the background process stays alive in the first scenario, and how many polls the count fails in the retry one.
const BUSY_POLLS = 2;
const FAILING_POLLS = 3;

const seed = (platform: Parameters<typeof createMemoryRuntime>[0] = "linux") => {
	const h = createMemoryRuntime(platform);
	h.fs.seed(`${HOME}/.agent-rig/state.json`, JSON.stringify({ mode: "dev", paths: { repo: "/repo", hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null }));
	h.fs.directories.add("/work");
	h.runtime.lock.process.pid = PID;
	h.runtime.process.createdAt = async () => ok({ [PID]: "born" });
	return h;
};
const build = async () => apiOk({ argv: ["fake"], env: {}, files: [] });
// A clock the test moves by hand: both readings follow `time.ms`.
const movableClock = (h: ReturnType<typeof seed>): { ms: number } => {
	const time = { ms: BASE_TIME_MS };
	h.runtime.clock.now = () => new Date(time.ms);
	h.runtime.clock.nowText = () => new Date(time.ms).toISOString();
	return time;
};
const endOf = async (h: ReturnType<typeof seed>): Promise<unknown> => {
	const status = await statusExec(h.runtime, "event-1", 0);
	return status.ok && typeof status.value === "object" && status.value !== null && !Array.isArray(status.value) ? status.value.end : undefined;
};
// Every way a run can be killed: by the runner itself (members) and from outside (the runner's group or tree).
const recordKills = (h: ReturnType<typeof seed>): string[] => {
	const kills: string[] = [];
	h.runtime.process.killGroup = async (pid) => { kills.push(`group:${pid}`); h.runtime.process.createdAt = async () => ok({}); return ok(undefined); };
	h.runtime.process.killTree = async (pid) => { kills.push(`tree:${pid}`); h.runtime.process.createdAt = async () => ok({}); return ok(undefined); };
	return kills;
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
		expect(await endOf(h)).toMatchObject({ kind: "exit", code: COMMAND_CODE });
	});

	test("every poll sleep is cancelled once the runner has stopped waiting, so no timer is left to hold the runner process open", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "sleep 3 & echo started");
		let polls = 0;
		h.runtime.process.runMembers = async () => { polls += 1; return ok(polls <= BUSY_POLLS ? 1 : 0); };
		const signals: (AbortSignal | undefined)[] = [];
		h.runtime.clock.sleep = async (_ms, cancel) => { signals.push(cancel); };
		expect(await runExecRunner(h.runtime, "event-1", build)).toBe(0);
		expect(signals.length).toBeGreaterThan(0);
		for (const signal of signals) expect(signal?.aborted).toBe(true);
	});

	test("a stop request while the run is alive: the runner kills its members itself and records stopped; nothing is killed from outside", async () => {
		for (const platform of ["linux", "windows"] as const) {
			const h = seed(platform);
			await startExec(h.runtime, "bash", "/work", "sleep 99 & echo started");
			const outside = recordKills(h);
			let alive = true;
			let exitCommand: () => void = () => {};
			let membersKills = 0;
			h.runtime.process.runStreaming = () => new Promise((resolve) => { exitCommand = () => resolve(streamed(0)); });
			h.runtime.process.runMembers = async () => ok(alive ? 1 : 0);
			h.runtime.process.killRunMembers = async () => { membersKills += 1; alive = false; exitCommand(); return ok(undefined); };
			const replies: unknown[] = [];
			// The first poll finds no request; the request arrives while the runner sleeps.
			h.runtime.clock.sleep = async () => { replies.push(await stopExec(h.runtime, "event-1")); };
			expect(await runExecRunner(h.runtime, "event-1", build)).toBe(0);
			expect(replies[0]).toMatchObject({ ok: true, value: { id: "event-1", stopping: true } });
			expect(membersKills).toBe(1);
			expect(outside).toEqual([]);
			expect(await endOf(h)).toMatchObject({ kind: "stopped", code: null });
		}
	});

	test("a stop request that lands while the runner counts an empty run ends with the command's code and kills nothing", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "echo hi");
		const outside = recordKills(h);
		let membersKills = 0;
		h.runtime.process.killRunMembers = async () => { membersKills += 1; return ok(undefined); };
		let reply: unknown = null;
		h.runtime.process.runStreaming = async () => streamed(COMMAND_CODE);
		// The run empties and the request is written in the same moment the runner reads the count.
		h.runtime.process.runMembers = async () => { reply = await stopExec(h.runtime, "event-1"); return ok(0); };
		expect(await runExecRunner(h.runtime, "event-1", build)).toBe(0);
		expect(reply).toMatchObject({ ok: true, value: { stopping: true } });
		expect(membersKills).toBe(0);
		expect(outside).toEqual([]);
		expect(await endOf(h)).toMatchObject({ kind: "exit", code: COMMAND_CODE });
	});

	test("a request that was already there when the runner finds the run empty still ends with the command's code", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "echo hi");
		const outside = recordKills(h);
		let membersKills = 0;
		h.runtime.process.killRunMembers = async () => { membersKills += 1; return ok(undefined); };
		// The request is written in the same moment the command exits, so the runner finds both at its first poll and nothing is alive to kill.
		h.runtime.process.runStreaming = async () => { h.fs.seed(`${RUN}/stop-request`, new Date(BASE_TIME_MS).toISOString()); return streamed(COMMAND_CODE); };
		h.runtime.process.runMembers = async () => ok(0);
		expect(await runExecRunner(h.runtime, "event-1", build)).toBe(0);
		expect(membersKills).toBe(0);
		expect(outside).toEqual([]);
		expect(await endOf(h)).toMatchObject({ kind: "exit", code: COMMAND_CODE });
	});

	test("a request after the command exited with members alive kills them again until none is left, then records stopped", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "sleep 99 & echo started");
		let alive = 2;
		const kills: number[] = [];
		h.runtime.process.runStreaming = async () => streamed(COMMAND_CODE);
		h.runtime.process.runMembers = async () => ok(alive);
		// The first kill fails; the second leaves one member (a process started meanwhile); the third finishes.
		h.runtime.process.killRunMembers = async () => { kills.push(alive); if (kills.length === 1) return err("kill failed"); alive = kills.length === 2 ? 1 : 0; return ok(undefined); };
		let asked = false;
		h.runtime.clock.sleep = async () => { if (!asked) { asked = true; await stopExec(h.runtime, "event-1"); } };
		expect(await runExecRunner(h.runtime, "event-1", build)).toBe(0);
		expect(kills.length).toBe(3);
		expect(await endOf(h)).toMatchObject({ kind: "stopped", code: null });
	});

	test("a hung runner: a repeated stop after the grace kills from outside (group on POSIX, tree on Windows), not before", async () => {
		for (const platform of ["linux", "windows"] as const) {
			const h = seed(platform);
			await startExec(h.runtime, "bash", "/work", "echo hi");
			h.fs.seed(`${RUN}/identity.json`, JSON.stringify({ pid: PID, pidCreated: "born" }));
			const time = movableClock(h);
			const kills = recordKills(h);
			expect(await stopExec(h.runtime, "event-1")).toMatchObject({ ok: true, value: { id: "event-1", stopping: true } });
			const requestText = h.fs.files.get(`${RUN}/stop-request`);
			expect(requestText).toBe(new Date(BASE_TIME_MS).toISOString());
			time.ms += EXEC_STOP_GRACE_MS - 1;
			expect(await stopExec(h.runtime, "event-1")).toMatchObject({ ok: true, value: { stopping: true } });
			expect(kills).toEqual([]);
			// A repeated stop does not move the request's time, so the grace is counted from the first request.
			expect(h.fs.files.get(`${RUN}/stop-request`)).toBe(requestText);
			time.ms += 1;
			expect(await stopExec(h.runtime, "event-1")).toMatchObject({ ok: true, value: { stopping: true } });
			expect(kills).toEqual([platform === "windows" ? `tree:${PID}` : `group:${PID}`]);
			expect(await endOf(h)).toMatchObject({ kind: "stopped", code: null });
		}
	});

	test("a hung runner's outside kill never hits a reused pid: the run is lost instead", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "echo hi");
		h.fs.seed(`${RUN}/identity.json`, JSON.stringify({ pid: PID, pidCreated: "born" }));
		const time = movableClock(h);
		const kills = recordKills(h);
		await stopExec(h.runtime, "event-1");
		h.runtime.process.createdAt = async () => ok({ [PID]: "someone else" });
		time.ms += EXEC_STOP_GRACE_MS;
		expect(await stopExec(h.runtime, "event-1")).toMatchObject({ ok: true, value: { state: "ended" } });
		expect(kills).toEqual([]);
		expect(await endOf(h)).toMatchObject({ kind: "lost" });
	});

	test("a failed outside kill keeps the request and reports the failure", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "echo hi");
		h.fs.seed(`${RUN}/identity.json`, JSON.stringify({ pid: PID, pidCreated: "born" }));
		const time = movableClock(h);
		h.runtime.process.killGroup = async () => err("kill failed");
		await stopExec(h.runtime, "event-1");
		time.ms += EXEC_STOP_GRACE_MS;
		expect(await stopExec(h.runtime, "event-1")).toMatchObject({ ok: false });
		expect(h.fs.files.has(`${RUN}/stop-request`)).toBe(true);
		expect(await endOf(h)).toBeUndefined();
	});
});

describe("a check that fails is not an answer", () => {
	test("a member count that fails is retried on the next poll and never ends the run", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "echo hi");
		h.runtime.process.runStreaming = async () => streamed(COMMAND_CODE);
		let calls = 0;
		h.runtime.process.runMembers = async () => { calls += 1; return calls <= FAILING_POLLS ? err("ps failed") : ok(0); };
		let kills = 0;
		h.runtime.process.killRunMembers = async () => { kills += 1; return ok(undefined); };
		const endsSeen: unknown[] = [];
		h.runtime.clock.sleep = async () => { endsSeen.push(h.fs.files.has(`${RUN}/exit.json`)); };
		expect(await runExecRunner(h.runtime, "event-1", build)).toBe(0);
		expect(calls).toBe(FAILING_POLLS + 1);
		expect(endsSeen).toEqual([false, false, false]);
		expect(kills).toBe(0);
		expect(await endOf(h)).toMatchObject({ kind: "exit", code: COMMAND_CODE });
		expect(await endOf(h)).not.toHaveProperty("reason");
	});

	test("a count that keeps failing for the stale window kills the members and ends with the command's code and a reason", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "echo hi");
		const time = movableClock(h);
		h.runtime.process.runStreaming = async () => streamed(COMMAND_CODE);
		h.runtime.process.runMembers = async () => err("ps failed");
		let kills = 0;
		h.runtime.process.killRunMembers = async () => { kills += 1; return ok(undefined); };
		const sleeps: number[] = [];
		h.runtime.clock.sleep = async (ms) => { sleeps.push(ms); time.ms += ms; };
		expect(await runExecRunner(h.runtime, "event-1", build)).toBe(0);
		expect(sleeps.length).toBe(EXEC_STALE_MS / EXEC_RUN_POLL_MS);
		expect(kills).toBe(1);
		expect(await endOf(h)).toMatchObject({ kind: "exit", code: COMMAND_CODE, reason: "run-check-failed" });
	});

	test("a stop-request check that fails is retried the same way and never read as no request", async () => {
		const h = seed();
		await startExec(h.runtime, "bash", "/work", "sleep 99 & echo started");
		const alive = { value: 1 };
		const stat = h.fs.stat.bind(h.fs);
		let failing = false;
		let failures = 0;
		h.fs.stat = async (path) => {
			if (failing && path.endsWith("/stop-request") && failures < FAILING_POLLS) { failures += 1; throw new Error("stat failed"); }
			return stat(path);
		};
		// The command exits with a member alive and a request already written; only then do the request reads start failing.
		h.runtime.process.runStreaming = async () => { await stopExec(h.runtime, "event-1"); failing = true; return streamed(COMMAND_CODE); };
		h.runtime.process.runMembers = async () => ok(alive.value);
		const killsAtRead: number[] = [];
		let killed = 0;
		h.runtime.process.killRunMembers = async () => { killed += 1; alive.value = 0; return ok(undefined); };
		h.runtime.clock.sleep = async () => { killsAtRead.push(killed); };
		expect(await runExecRunner(h.runtime, "event-1", build)).toBe(0);
		expect(failures).toBe(FAILING_POLLS);
		// The unreadable request is neither read as "no request" (the run would end as exit) nor does it kill anything on its own.
		expect(killsAtRead.slice(0, FAILING_POLLS)).toEqual([0, 0, 0]);
		expect(killed).toBe(1);
		expect(await endOf(h)).toMatchObject({ kind: "stopped" });
	});
});

describe("counting the members of a POSIX run", () => {
	const TABLE = ["  100   100 Ss", "  101   100 S", "  102   100 Z", "  103   100 R+", "  200   200 S", "garbage", ""].join("\n");
	test("counts live group members other than the runner; zombies, other groups and unparsable rows are not members", () => {
		expect(countGroupMembers(TABLE, 100, 100)).toBe(2);
		expect(countGroupMembers(TABLE, 200, 100)).toBe(1);
		expect(countGroupMembers(TABLE, 300, 100)).toBe(0);
	});

	test("lists the same members by pid", () => {
		expect(groupMemberPids(TABLE, 100, 100)).toEqual([101, 103]);
		expect(groupMemberPids(TABLE, 300, 100)).toEqual([]);
	});
});
