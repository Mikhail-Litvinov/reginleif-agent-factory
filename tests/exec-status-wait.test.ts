import { describe, expect, test } from "bun:test";

import { runExecCommand } from "../src/commands/exec.js";
import { EXEC_STALE_MS, EXEC_WAIT_POLL_MS, statusExec } from "../src/exec-core.js";
import { ok } from "../src/result.js";
import { createMemoryRuntime } from "./fakes/memory-runtime.js";

const HOME = "/home/test";
const RUN = `${HOME}/.agent-rig/exec/event-1`;
const NOW = "2026-10-30T00:00:00.000Z";
const START = Date.parse(NOW);
const PID = 100;
const LONG_WAIT_MS = 60_000;
const UTF8_EURO_LEAD = 0xe2;
const UTF8_EURO_REST = [0x82, 0xac];

type Harness = ReturnType<typeof createMemoryRuntime>;

// A run whose shell is alive (fresh heartbeat, runner identity matching) and whose log holds `log`.
const seedRun = (log: string): Harness => {
	const h = createMemoryRuntime("linux");
	h.fs.seed(`${RUN}/record.json`, JSON.stringify({ id: "event-1", shell: "bash", cwd: "/work", text: "echo hi", startedAt: NOW }));
	h.fs.seed(`${RUN}/heartbeat`, NOW);
	h.fs.seed(`${RUN}/identity.json`, JSON.stringify({ pid: PID, pidCreated: "born" }));
	h.fs.seed(`${RUN}/log`, log);
	h.runtime.process.createdAt = async () => ok({ [PID]: "born" });
	return h;
};

// A fake clock that moves only through sleep. `onTick(n)` runs after the n-th sleep, before the next check, so a test
// can change the run in the middle of a wait. Returns the sleeps the code under test asked for.
const drive = (h: Harness, onTick: (tick: number) => void = () => undefined): { sleeps: number[] } => {
	let elapsed = 0;
	const sleeps: number[] = [];
	h.runtime.clock.now = () => new Date(START + elapsed);
	h.runtime.clock.sleep = async (milliseconds) => {
		sleeps.push(milliseconds);
		elapsed += milliseconds;
		onTick(sleeps.length);
	};
	return { sleeps };
};

const usage = { ok: false, error: { code: "usage" } };

describe("rig exec status --wait", () => {
	test("answers at once, with the plain status object, when the log already holds bytes past the offset", async () => {
		const h = seedRun("hello");
		const { sleeps } = drive(h);
		const waited = await statusExec(h.runtime, "event-1", 2, LONG_WAIT_MS);
		const plain = await statusExec(h.runtime, "event-1", 2);
		expect(sleeps).toEqual([]);
		expect(waited).toMatchObject({ ok: true, value: { state: "running", log: { from: 2, to: 5, size: 5, text: "llo" } } });
		expect(waited).toEqual(plain);
	});

	test("waits, polling at the named interval, and answers with the bytes that appear mid-wait", async () => {
		const h = seedRun("");
		const { sleeps } = drive(h, (tick) => { if (tick === 3) h.fs.seed(`${RUN}/log`, "abc"); });
		const waited = await statusExec(h.runtime, "event-1", 0, LONG_WAIT_MS);
		const plain = await statusExec(h.runtime, "event-1", 0);
		expect(sleeps).toEqual([EXEC_WAIT_POLL_MS, EXEC_WAIT_POLL_MS, EXEC_WAIT_POLL_MS]);
		expect(waited).toMatchObject({ ok: true, value: { state: "running", log: { from: 0, to: 3, size: 3, text: "abc" } } });
		expect(waited).toEqual(plain);
	});

	test("answers when the run ends mid-wait, with the same end as a plain status", async () => {
		const h = seedRun("");
		const { sleeps } = drive(h, (tick) => { if (tick === 2) h.fs.seed(`${RUN}/exit.json`, JSON.stringify({ kind: "exit", code: 0, at: NOW })); });
		const waited = await statusExec(h.runtime, "event-1", 0, LONG_WAIT_MS);
		const plain = await statusExec(h.runtime, "event-1", 0);
		expect(sleeps).toHaveLength(2);
		expect(waited).toMatchObject({ ok: true, value: { state: "ended", end: { kind: "exit", code: 0 } } });
		expect(waited).toEqual(plain);
	});

	test("answers when the runner dies mid-wait: the lost end is established from its identity and recorded", async () => {
		const h = seedRun("");
		// A stale heartbeat with a live runner keeps the run running; the runner's death then makes the end lost.
		h.fs.seed(`${RUN}/heartbeat`, new Date(START - EXEC_STALE_MS - 1000).toISOString());
		const { sleeps } = drive(h, (tick) => { if (tick === 2) h.runtime.process.createdAt = async () => ok({}); });
		const waited = await statusExec(h.runtime, "event-1", 0, LONG_WAIT_MS);
		expect(sleeps).toHaveLength(2);
		expect(waited).toMatchObject({ ok: true, value: { state: "ended", end: { kind: "lost", reason: "process-gone" } } });
		expect(JSON.parse(h.fs.files.get(`${RUN}/exit.json`) ?? "{}")).toMatchObject({ kind: "lost" });
	});

	test("after <ms> with no change it answers with the same object as a plain status, and cuts the last sleep to the time left", async () => {
		const h = seedRun("abc");
		const { sleeps } = drive(h);
		const waited = await statusExec(h.runtime, "event-1", 3, 1100);
		const plain = await statusExec(h.runtime, "event-1", 3);
		expect(sleeps).toEqual([EXEC_WAIT_POLL_MS, EXEC_WAIT_POLL_MS, EXEC_WAIT_POLL_MS, EXEC_WAIT_POLL_MS, 100]);
		expect(waited).toMatchObject({ ok: true, value: { state: "running", log: { from: 3, to: 3, size: 3, text: "" } } });
		expect(waited).toEqual(plain);
	});

	test("a zero wait answers at once and never sleeps", async () => {
		const h = seedRun("abc");
		const { sleeps } = drive(h);
		const waited = await statusExec(h.runtime, "event-1", 3, 0);
		expect(sleeps).toEqual([]);
		expect(waited).toEqual(await statusExec(h.runtime, "event-1", 3));
	});

	test("a partial UTF-8 character alone does not end the wait; its completion does", async () => {
		const h = seedRun("");
		h.fs.binaries.set(`${RUN}/log`, new Uint8Array([UTF8_EURO_LEAD]));
		const { sleeps } = drive(h, (tick) => { if (tick === 1) h.fs.binaries.set(`${RUN}/log`, new Uint8Array([UTF8_EURO_LEAD, ...UTF8_EURO_REST])); });
		const waited = await statusExec(h.runtime, "event-1", 0, LONG_WAIT_MS);
		expect(sleeps).toEqual([EXEC_WAIT_POLL_MS]);
		expect(waited).toMatchObject({ ok: true, value: { state: "running", log: { from: 0, to: 3, size: 3, text: "€" } } });
	});

	test("a call on an unknown run fails at once, without waiting", async () => {
		const h = seedRun("");
		const { sleeps } = drive(h);
		expect(await statusExec(h.runtime, "event-9", 0, LONG_WAIT_MS)).toMatchObject({ ok: false, error: { code: "exec-unknown" } });
		expect(sleeps).toEqual([]);
	});

	test("the CLI takes --from N --wait MS, and any other form of --wait is usage", async () => {
		const h = seedRun("");
		const { sleeps } = drive(h);
		expect(await runExecCommand(h.runtime, "status", ["event-1", "--from", "0", "--wait", "0007"])).toMatchObject({ ok: true, value: { state: "running" } });
		expect(sleeps).toEqual([7]);
		const bad: string[][] = [
			["event-1", "--wait", "5"],
			["event-1", "--from", "0", "--wait"],
			["event-1", "--from", "0", "--wait", "5", "extra"],
			["event-1", "--wait", "5", "--from", "0"],
			["event-1", "--from", "0", "--wait", "-1"],
			["event-1", "--from", "0", "--wait", "1.5"],
			["event-1", "--from", "0", "--wait", "1e3"],
			["event-1", "--from", "0", "--wait", "0x10"],
			["event-1", "--from", "0", "--wait", " 5"],
			["event-1", "--from", "0", "--wait", "5ms"],
			["event-1", "--from", "0", "--wait", ""],
			["event-1", "--from", "0", "--wait", "9007199254740993"],
		];
		for (const args of bad) expect(await runExecCommand(h.runtime, "status", args)).toMatchObject(usage);
		expect(sleeps).toEqual([7]);
	});
});
