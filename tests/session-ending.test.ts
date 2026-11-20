import type { RuntimePorts } from "../src/ports.js";
import type { SessionRecord } from "../src/session-core.js";

import { describe, expect, test } from "bun:test";

import { runCli } from "../src/cli.js";
import { cleanupSession } from "../src/commands/session-cleanup.js";
import { modeCommand } from "../src/commands/session-run.js";
import { stopSession } from "../src/commands/session-stop.js";
import { apiFail, apiOk, SESSION_IO } from "../src/output.js";
import { err, ok } from "../src/result.js";
import { withSessionEnding } from "../src/session-ending.js";
import { createMemoryRuntime, FAKE_OWNER_CREATED } from "./fakes/memory-runtime.js";

const ID = "11111111-1111-1111-1111-111111111111";
const ROOT = "/home/test/.agent-rig";
const DIRECTORY = `${ROOT}/sessions/${ID}`;
const MARKER = `${DIRECTORY}/ending.json`;
const TRANSCRIPT = `/transcripts/${ID}.jsonl`;
// Invented identities for the session's two process trees and independent rig callers.
const CLAUDE_PID = 42;
const WINDOW_PID = 43;
const OTHER_OWNER_PID = 11;
const THIRD_OWNER_PID = 12;
const LAUNCHED_PID = 44;
const CLAUDE_CREATED = "claude-creation";
const OTHER_OWNER_CREATED = "other-rig-creation";
const THIRD_OWNER_CREATED = "third-rig-creation";
const LAUNCHED_CREATED = "resumed-claude-creation";
// The incident's usage, above rig's 120,000-token stop threshold; a successful compact shrinks it.
const TOKENS_BEFORE = 164_000;
const TOKENS_AFTER = 80_000;
const SKILLS = '{"type":"attachment","attachment":{"type":"invoked_skills","skills":[{"name":"sample","content":"invented"}]}}\n';
const SESSION: SessionRecord = { id: ID, cwd: "/work", transcriptPath: TRANSCRIPT, startedAt: "start", processes: [CLAUDE_PID, WINDOW_PID].map((pid) => ({ pid, pidCreated: CLAUDE_CREATED, startedAt: "start" })) };
const code = (result: { ok: true } | { ok: false; error: { code: string } }): string => result.ok ? "ok" : result.error.code;
const gate = () => {
	let open = () => {};
	const promise = new Promise<void>((resolve) => { open = resolve; });
	return { promise, open };
};

const setup = () => {
	const h = createMemoryRuntime();
	h.fs.seed(`${ROOT}/sessions/${ID}.json`, JSON.stringify({ session_id: ID, cwd: SESSION.cwd, transcript_path: TRANSCRIPT, started_at: "start", config_dir: "" }));
	h.fs.seed(`${DIRECTORY}/usage.json`, "{}");
	for (const process of SESSION.processes) h.fs.seed(`${DIRECTORY}/processes/${process.pid}.json`, JSON.stringify({ pid: process.pid, pid_created: process.pidCreated, started_at: process.startedAt }));
	h.fs.seed(TRANSCRIPT, SKILLS);
	h.fs.seed(`${ROOT}/state.json`, JSON.stringify({ mode: "dev", paths: { repo: "/repo", hub: "/hub" }, features: {}, records: {}, badPairs: [], pendingHubRestart: null }));
	h.fs.directories.add("/work");
	h.fs.seed("/usr/bin/tmux", "");
	const identities: Record<string, string | null> = {
		[String(h.runtime.lock.process.pid)]: FAKE_OWNER_CREATED,
		[String(OTHER_OWNER_PID)]: OTHER_OWNER_CREATED,
		[String(THIRD_OWNER_PID)]: THIRD_OWNER_CREATED,
		[String(CLAUDE_PID)]: CLAUDE_CREATED,
		[String(WINDOW_PID)]: CLAUDE_CREATED,
	};
	h.runtime.process.createdAt = async () => ok({ ...identities });
	const killed: number[] = [];
	const markersAtKill: unknown[] = [];
	h.runtime.process.killTree = async (pid) => {
		const marker = h.fs.files.get(MARKER);
		if (marker !== undefined) markersAtKill.push(JSON.parse(marker));
		killed.push(pid);
		identities[String(pid)] = null;
		// The exit hook removes the corresponding process record.
		h.fs.files.delete(`${DIRECTORY}/processes/${pid}.json`);
		return ok(undefined);
	};
	const requests: string[] = [];
	const rename = h.fs.rename.bind(h.fs);
	h.fs.rename = async (from, to) => {
		if (to.startsWith(`${DIRECTORY}/requests/`) && to.endsWith(".json")) {
			const request: unknown = JSON.parse(await h.fs.readText(from));
			if (typeof request === "object" && request !== null && "op" in request && typeof request.op === "string") requests.push(request.op);
		}
		await rename(from, to);
	};
	let now = 0;
	const advance = async (ms: number) => { now += ms; };
	h.runtime.clock.now = () => new Date(now);
	h.runtime.clock.sleep = advance;
	const caller = (pid = OTHER_OWNER_PID): RuntimePorts => ({ ...h.runtime, clock: { ...h.runtime.clock, sleep: advance }, lock: { ...h.runtime.lock, process: { ...h.runtime.lock.process, pid } } });
	const response = (id: string, result: unknown) => h.fs.seed(`${DIRECTORY}/responses/${id}.json`, JSON.stringify({ id, ok: true, result }));
	const pause = () => {
		const waiting = gate();
		const resume = gate();
		h.runtime.clock.sleep = async (ms) => { waiting.open(); await resume.promise; await advance(ms); };
		return { waiting: waiting.promise, resume: resume.open };
	};
	return { ...h, identities, killed, markersAtKill, requests, caller, response, pause };
};

describe("session ending ownership", () => {
	for (const operation of ["stop", "cleanup", "mode"] as const) {
		test(`a second stop kills both process trees during ${operation}, without usage or compaction`, async () => {
			const h = setup();
			if (operation !== "cleanup") h.response("event-1", { context: { tokens: TOKENS_BEFORE } });
			const paused = h.pause();
			const first = operation === "stop" ? stopSession(h.runtime, SESSION, () => {}) : operation === "cleanup" ? cleanupSession(h.runtime, SESSION, () => {}) : modeCommand(h.runtime, [ID, "auto"], () => {});
			try {
				await paused.waiting;
				const before = [...h.requests];
				let sleeps = 0;
				const second = h.caller();
				const advance = second.clock.sleep;
				second.clock.sleep = async (ms) => { sleeps += 1; await advance(ms); };
				const result = await stopSession(second, SESSION, () => {});
				expect(result).toEqual(apiOk({ session: ID, stopped: true, compacted: null }));
				expect(h.requests).toEqual(before);
				expect(h.killed).toEqual([CLAUDE_PID, WINDOW_PID]);
				expect(sleeps).toBe(0);
				expect(h.markersAtKill[0]).toMatchObject({ pid: OTHER_OWNER_PID, pidCreated: OTHER_OWNER_CREATED, takenOver: true });
			} finally { paused.resume(); }
			const result = await first;
			expect(code(result)).toBe(operation === "cleanup" ? "session-ended" : operation === "mode" ? "session-ending" : "ok");
			if (operation === "stop") expect(result).toEqual(apiOk({ session: ID, stopped: false, reason: "not-running" } as const));
			expect(await h.fs.readText(TRANSCRIPT)).toBe(SKILLS);
			expect((await h.fs.listDirectory("/transcripts")).map((entry) => entry.name)).toEqual([`${ID}.jsonl`]);
			expect(h.fs.operations.some((operation) => operation.includes("launch-stderr"))).toBe(false);
			expect(await h.fs.stat(MARKER)).toBeNull();
		});
	}

	test("a takeover after mode's stop but before spawn still prevents relaunch", async () => {
		const h = setup();
		h.response("event-1", { context: { tokens: TOKENS_AFTER } });
		const entered = gate();
		const resume = gate();
		const ensure = h.fs.ensureDirectory.bind(h.fs);
		h.fs.ensureDirectory = async (path) => {
			if (path.endsWith("/launch-stderr")) { entered.open(); await resume.promise; }
			await ensure(path);
		};
		let launches = 0;
		h.runtime.process.spawnDetached = async () => { launches += 1; return ok({ exited: false, exitCode: null, stderr: "" }); };
		const first = modeCommand(h.runtime, [ID, "auto"], () => {});
		try {
			await entered.promise;
			expect(await stopSession(h.caller(), SESSION, () => {})).toEqual(apiOk({ session: ID, stopped: false, reason: "not-running" }));
		} finally { resume.open(); }
		expect(code(await first)).toBe("session-ending");
		expect(launches).toBe(0);
		expect(await h.fs.stat(MARKER)).toBeNull();
	});

	for (const launchFails of [false, true]) test(`a takeover after spawn stops a later registration when launch ${launchFails ? "fails" : "succeeds"}`, async () => {
		const h = setup();
		h.response("event-1", { context: { tokens: TOKENS_AFTER } });
		const entered = gate();
		const resume = gate();
		h.runtime.process.spawnDetached = async () => {
			entered.open();
			await resume.promise;
			h.identities[String(LAUNCHED_PID)] = LAUNCHED_CREATED;
			h.fs.seed(`${DIRECTORY}/processes/${LAUNCHED_PID}.json`, JSON.stringify({ pid: LAUNCHED_PID, pid_created: LAUNCHED_CREATED, started_at: "resumed" }));
			return launchFails ? err("launch failed") : ok({ exited: false, exitCode: null, stderr: "", pid: LAUNCHED_PID });
		};
		const first = modeCommand(h.runtime, [ID, "auto"], () => {});
		try {
			await entered.promise;
			expect(await stopSession(h.caller(), SESSION, () => {})).toEqual(apiOk({ session: ID, stopped: false, reason: "not-running" }));
		} finally { resume.open(); }
		expect(code(await first)).toBe("session-ending");
		expect(h.identities[String(LAUNCHED_PID)]).toBeNull();
	});

	test("a stop waits for an authorized transcript edit to finish", async () => {
		const h = setup();
		h.response("event-1", { tokensBefore: TOKENS_BEFORE, tokensAfter: TOKENS_AFTER });
		const entered = gate();
		const resume = gate();
		const waiting = gate();
		const retry = gate();
		const readRange = h.fs.readRange.bind(h.fs);
		h.fs.readRange = async (path, offset, length) => {
			if (path === TRANSCRIPT) { entered.open(); await resume.promise; }
			return readRange(path, offset, length);
		};
		const first = cleanupSession(h.runtime, SESSION, () => {});
		let stopping: Promise<Awaited<ReturnType<typeof stopSession>>> | undefined;
		try {
			await entered.promise;
			const second = h.caller();
			second.lock.clock = { ...second.lock.clock, sleep: async () => { waiting.open(); await retry.promise; } };
			stopping = stopSession(second, SESSION, () => {});
			const state = await Promise.race([waiting.promise.then(() => "waiting"), stopping.then(() => "finished")]);
			expect(state).toBe("waiting");
			expect(JSON.parse(await h.fs.readText(MARKER))).toMatchObject({ takenOver: false });
			expect(await h.fs.readText(TRANSCRIPT)).toBe(SKILLS);
			resume.open();
			expect(code(await first)).toBe("ok");
		} finally { resume.open(); retry.open(); }
		expect(await stopping).toEqual(apiOk({ session: ID, stopped: false, reason: "not-running" }));
		expect(await h.fs.readText(TRANSCRIPT)).not.toBe(SKILLS);
	});

	test("a stop waiting for process exit leaves cleanup, mode and another stop responsive", async () => {
		const h = setup();
		const entered = gate();
		const resumeOwner = gate();
		const owner = withSessionEnding(h.runtime, ID, async () => { entered.open(); await resumeOwner.promise; return apiOk(null); });
		await entered.promise;
		const waiting = gate();
		const resumeStop = gate();
		const second = h.caller();
		const kill = h.runtime.process.killTree;
		h.runtime.process.killTree = async () => ok(undefined);
		second.clock.sleep = async () => { waiting.open(); await resumeStop.promise; };
		const stopping = stopSession(second, SESSION, () => {});
		try {
			await waiting.promise;
			resumeOwner.open();
			expect((await owner).ok).toBe(true);
			expect(JSON.parse(await h.fs.readText(MARKER))).toMatchObject({ pid: OTHER_OWNER_PID, takenOver: true });
			expect(code(await cleanupSession(h.caller(THIRD_OWNER_PID), SESSION, () => {}))).toBe("session-ending");
			expect(code(await modeCommand(h.caller(THIRD_OWNER_PID), [ID, "auto"], () => {}))).toBe("session-ending");
			h.runtime.process.killTree = kill;
			expect(await stopSession(h.caller(THIRD_OWNER_PID), SESSION, () => {})).toEqual(apiOk({ session: ID, stopped: true, compacted: null }));
			expect(h.requests).toEqual([]);
		} finally { resumeOwner.open(); resumeStop.open(); }
		expect(code(await stopping)).toBe("ok");
		expect(await h.fs.stat(MARKER)).toBeNull();
	});

	test("mode holds ownership through a successful relaunch and then releases it", async () => {
		const h = setup();
		h.response("event-1", { context: { tokens: TOKENS_AFTER } });
		h.runtime.process.spawnDetached = async () => {
			expect(JSON.parse(await h.fs.readText(MARKER))).toMatchObject({ pid: h.runtime.lock.process.pid, takenOver: false });
			h.identities[String(LAUNCHED_PID)] = LAUNCHED_CREATED;
			h.fs.seed(`${DIRECTORY}/processes/${LAUNCHED_PID}.json`, JSON.stringify({ pid: LAUNCHED_PID, pid_created: LAUNCHED_CREATED, started_at: "resumed" }));
			return ok({ exited: false, exitCode: null, stderr: "", pid: LAUNCHED_PID });
		};
		expect(await modeCommand(h.runtime, [ID, "auto"], () => {})).toEqual(apiOk({ session: ID, mode: "auto", pid: LAUNCHED_PID }));
		expect(await h.fs.stat(MARKER)).toBeNull();
	});

	test("a failed interrupting kill cannot release the still-compacting owner's marker", async () => {
		const h = setup();
		h.response("event-1", { context: { tokens: TOKENS_BEFORE } });
		const paused = h.pause();
		const first = stopSession(h.runtime, SESSION, () => {});
		try {
			await paused.waiting;
			h.runtime.process.killTree = async () => err("kill failed");
			expect(code(await stopSession(h.caller(), SESSION, () => {}))).toBe("session-io");
			expect(JSON.parse(await h.fs.readText(MARKER))).toMatchObject({ pid: h.runtime.lock.process.pid, takenOver: true });
			expect(code(await cleanupSession(h.caller(), SESSION, () => {}))).toBe("session-ending");
			expect(h.requests).toEqual(["usage", "compact"]);
		} finally {
			h.fs.seed(`${DIRECTORY}/responses/event-2.json`, JSON.stringify({ id: "event-2", ok: false, error: "compact abandoned" }));
			paused.resume();
		}
		expect(code(await first)).toBe("session-io");
		expect(await h.fs.stat(MARKER)).toBeNull();
	});

	test("cleanup leaves the transcript intact even if a compact reply arrives after takeover", async () => {
		const h = setup();
		const paused = h.pause();
		const first = cleanupSession(h.runtime, SESSION, () => {});
		try {
			await paused.waiting;
			await stopSession(h.caller(), SESSION, () => {});
			h.response("event-1", { tokensBefore: TOKENS_BEFORE, tokensAfter: TOKENS_AFTER });
		} finally { paused.resume(); }
		expect(code(await first)).toBe("session-ended");
		expect(await h.fs.readText(TRANSCRIPT)).toBe(SKILLS);
		expect((await h.fs.listDirectory("/transcripts")).map((entry) => entry.name)).toEqual([`${ID}.jsonl`]);
		expect(await h.fs.stat(MARKER)).toBeNull();
	});

	test("cleanup and mode entry points reject a live marker with one JSON error", async () => {
		const h = setup();
		const entered = gate();
		const resume = gate();
		const first = withSessionEnding(h.runtime, ID, async () => { entered.open(); await resume.promise; return apiOk(null); });
		try {
			await entered.promise;
			for (const args of [["cleanup", ID], ["mode", ID, "auto"], ["mode", ID, "plan"]]) {
				if (args.at(-1) === "plan") h.fs.seed(TRANSCRIPT, JSON.stringify({ type: "permission-mode", permissionMode: "plan" }));
				const lines: string[] = [];
				expect(await runCli(["session", ...args], (line) => lines.push(line), h.caller())).toBe(1);
				expect(lines).toHaveLength(1);
				expect(JSON.parse(lines.join(""))).toMatchObject({ error: { code: "session-ending" } });
			}
			expect(h.requests).toEqual([]);
			expect(h.killed).toEqual([]);
		} finally { resume.open(); }
		expect((await first).ok).toBe(true);
	});

	for (const identity of [null, "reused-pid-creation"]) {
		test(`takes over a stale marker when its owner's identity is ${identity}`, async () => {
			const h = setup();
			h.identities[String(OTHER_OWNER_PID)] = identity;
			h.fs.seed(MARKER, JSON.stringify({ pid: OTHER_OWNER_PID, pidCreated: OTHER_OWNER_CREATED, token: "stale", takenOver: false }));
			h.response("event-1", { context: { tokens: TOKENS_AFTER } });
			expect(await stopSession(h.runtime, SESSION, () => {})).toEqual(apiOk({ session: ID, stopped: true, compacted: null }));
			expect(h.requests).toEqual(["usage"]);
			expect(await h.fs.stat(MARKER)).toBeNull();
		});
	}

	test("two stale-marker contenders cannot delete the new owner's marker", async () => {
		const h = setup();
		h.identities[String(OTHER_OWNER_PID)] = null;
		h.fs.seed(MARKER, JSON.stringify({ pid: OTHER_OWNER_PID, pidCreated: OTHER_OWNER_CREATED, token: "stale", takenOver: false }));
		const resume = gate();
		let owners = 0;
		const action = async () => { owners += 1; await resume.promise; return apiOk(null); };
		const first = withSessionEnding(h.runtime, ID, action);
		const second = withSessionEnding(h.caller(THIRD_OWNER_PID), ID, action);
		try {
			const rejected = await Promise.race([first, second]);
			expect(code(rejected)).toBe("session-ending");
			expect(owners).toBe(1);
		} finally { resume.open(); }
		await Promise.all([first, second]);
		expect(await h.fs.stat(MARKER)).toBeNull();
	});

	test("releases ownership after successful cleanup and failed compaction", async () => {
		for (const success of [true, false]) {
			const h = setup();
			if (success) h.response("event-1", { tokensBefore: TOKENS_BEFORE, tokensAfter: TOKENS_AFTER });
			else h.fs.seed(`${DIRECTORY}/responses/event-1.json`, JSON.stringify({ id: "event-1", ok: false, error: "compact failed" }));
			expect(code(await cleanupSession(h.runtime, SESSION, () => {}))).toBe(success ? "ok" : "session-module-error");
			expect(await h.fs.stat(MARKER)).toBeNull();
			expect(code(await withSessionEnding(h.caller(), ID, async () => apiOk(null)))).toBe("ok");
		}
	});

	test("releases ownership after an IO failure and a failed kill", async () => {
		for (const thrown of [true, false]) {
			const h = setup();
			const result = await withSessionEnding(h.runtime, ID, async () => {
				if (thrown) throw new Error("disk failure");
				return apiFail(SESSION_IO, "disk failure");
			});
			expect(code(result)).toBe("session-io");
			expect(await h.fs.stat(MARKER)).toBeNull();
		}
		const h = setup();
		h.response("event-1", { context: { tokens: TOKENS_AFTER } });
		h.runtime.process.killTree = async () => err("kill failed");
		expect(code(await stopSession(h.runtime, SESSION, () => {}))).toBe("session-io");
		expect(await h.fs.stat(MARKER)).toBeNull();
	});
});
