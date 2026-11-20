import type { LockDependencies, LockHandle } from "../src/lock.js";
import type { Result } from "../src/result.js";

import { describe, expect, test } from "bun:test";
import { acquireLock, tryAcquireLock } from "../src/lock.js";
import { err, ok } from "../src/result.js";
import { MemoryFileSystem } from "./fakes/memory-runtime.js";
import { messagesFor } from "../src/messages";

const TEST_MESSAGES = messagesFor("en");

const HOME = "/home/test";
const LOCK_PATH = "/home/test/.agent-rig/rig.lock";
const POLL_INTERVAL_MS = 1;
const DEAD_PID = 55;
const DEAD_START = 100;
const FIRST_PID = 11;
const FIRST_START = 101;
const SECOND_PID = 22;
const SECOND_START = 202;
const UNKNOWN_ANSWERS_BEFORE_DEAD = 2;
const HOLD_TURNS = 5;
const STALE_TOKEN = `legacy-${DEAD_PID}-${DEAD_START}`;
const CLAIM_PATH = `${LOCK_PATH}.recover-${STALE_TOKEN}.0`;
const WAIT_POLLS_BEFORE_RELEASE = 3;
// The lock permits one initial failed read and three retries, matching identity probes.
const READ_FAILURE_LIMIT = 4;
const RETRIES_BEFORE_FAILURE = READ_FAILURE_LIMIT - 1;
const ignoreNotice = (): void => undefined;

// Runs a callback right before the first destructive step on the lock file, so a test can place another process exactly
// between "this process decided the lock is stale" and "this process removes it".
class InterleavingFileSystem extends MemoryFileSystem {
	interleave: (() => Promise<void>) | null = null;
	beforeClaim: (() => Promise<void>) | null = null;

	override async writeExclusive(path: string, value: string): Promise<Result<boolean>> {
		if (path === CLAIM_PATH && this.beforeClaim !== null) {
			const run = this.beforeClaim;
			this.beforeClaim = null;
			await run();
		}
		return super.writeExclusive(path, value);
	}

	override async rename(from: string, to: string): Promise<void> {
		await this.fire(to);
		return super.rename(from, to);
	}

	override async remove(path: string): Promise<void> {
		await this.fire(path);
		return super.remove(path);
	}

	private async fire(path: string): Promise<void> {
		if (path !== LOCK_PATH || this.interleave === null) return;
		const run = this.interleave;
		this.interleave = null;
		await run();
	}
}

const dependenciesFor = (
	fs: MemoryFileSystem,
	pid: number,
	startTime: number,
	ownerStartTime: (pid: number) => Promise<Result<number | null>>,
	sleep: () => Promise<void> = async () => undefined,
	now: () => number = () => 0,
): LockDependencies => ({
	fs,
	home: HOME,
	process: { pid, startTime, ownerStartTime },
	clock: { sleep, now },
	messages: TEST_MESSAGES,
	pollIntervalMs: POLL_INTERVAL_MS,
});

const liveOwners = (alive: Map<number, number>) => async (pid: number): Promise<Result<number | null>> => ok(alive.get(pid) ?? null);

describe("lock takeover of a stale lock", () => {
	test("a delayed stale observer does not replace a newly acquired lock", async () => {
		const fs = new InterleavingFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		const alive = new Map([[FIRST_PID, FIRST_START], [SECOND_PID, SECOND_START]]);
		const captured: { second: Result<LockHandle> | null } = { second: null };
		fs.beforeClaim = async () => {
			captured.second = await acquireLock(dependenciesFor(fs, SECOND_PID, SECOND_START, liveOwners(alive)), ignoreNotice);
		};
		const first = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(alive), async () => { throw new Error("lock held"); }), ignoreNotice);
		expect(captured.second?.ok).toBe(true);
		expect(first.ok).toBe(false);
		expect(fs.files.get(LOCK_PATH)).toContain(`"pid":${SECOND_PID}`);
	});

	test("a delayed stale takeover cannot remove a newer owner's lock", async () => {
		const fs = new InterleavingFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		const alive = new Map([[FIRST_PID, FIRST_START], [SECOND_PID, SECOND_START]]);
		const captured: { second: Result<LockHandle> | null } = { second: null };
		fs.interleave = async () => {
			captured.second = await acquireLock(dependenciesFor(fs, SECOND_PID, SECOND_START, liveOwners(alive), async () => { throw new Error("claim held"); }), ignoreNotice);
		};
		const first = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(alive)), ignoreNotice);
		expect(captured.second?.ok).toBe(false);
		expect(first.ok).toBe(true);
		expect(fs.files.get(LOCK_PATH)).toContain(`"pid":${FIRST_PID}`);
	});

	test("two waiters on one stale lock produce exactly one owner at a time", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		const alive = new Map([[FIRST_PID, FIRST_START], [SECOND_PID, SECOND_START]]);
		let holders = 0;
		let maxHolders = 0;
		let acquiredCount = 0;
		const yieldTurn = (): Promise<void> => Promise.resolve();
		const contender = async (pid: number, startTime: number): Promise<void> => {
			const result = await acquireLock(dependenciesFor(fs, pid, startTime, liveOwners(alive), yieldTurn), ignoreNotice);
			if (!result.ok) throw new Error(result.error);
			holders += 1;
			acquiredCount += 1;
			maxHolders = Math.max(maxHolders, holders);
			for (let turn = 0; turn < HOLD_TURNS; turn += 1) await yieldTurn();
			holders -= 1;
			await result.value.release();
		};

		await Promise.all([contender(FIRST_PID, FIRST_START), contender(SECOND_PID, SECOND_START)]);

		expect(acquiredCount).toBe(2);
		expect(maxHolders).toBe(1);
		expect(fs.files.has(LOCK_PATH)).toBe(false);
		expect([...fs.files.keys()].some((path) => path.includes(".recover-"))).toBe(false);
	});

	test("a claim left by a killed recoverer does not block recovery", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		fs.seed(CLAIM_PATH, JSON.stringify({ pid: SECOND_PID, startTime: SECOND_START }));
		const result = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(new Map())), ignoreNotice);

		expect(result.ok).toBe(true);
		expect(fs.files.has(CLAIM_PATH)).toBe(false);
	});

	test("a live recoverer makes the waiter wait until it dies", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		fs.seed(CLAIM_PATH, JSON.stringify({ pid: SECOND_PID, startTime: SECOND_START }));
		const alive = new Map([[SECOND_PID, SECOND_START]]);
		let sleeps = 0;
		const result = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(alive), async () => { sleeps += 1; alive.clear(); }), ignoreNotice);
		expect(result.ok).toBe(true);
		// One wait for the live recoverer, then one yield while advancing past its dead claim.
		expect(sleeps).toBe(2);
	});

	test("a takeover is not blocked by a live lock and leaves no helper files", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		const result = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(new Map())), ignoreNotice);
		expect(result.ok).toBe(true);
		expect([...fs.files.keys()].sort()).toEqual([LOCK_PATH]);
	});
});

describe("lock when the owner cannot be inspected", () => {
	test("persistent recoverer probe failures report the recoverer and end acquisition", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		fs.seed(CLAIM_PATH, JSON.stringify({ pid: SECOND_PID, startTime: SECOND_START }));
		let failures = 0;
		const notices: Array<{ pid: number; error: string } | undefined> = [];
		const result = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, async (pid) => {
			if (pid === DEAD_PID) return ok(null);
			failures += 1;
			if (failures > 4) throw new Error("probe limit exceeded");
			return err("recoverer probe failed");
		}, async () => { if (failures >= 4) throw new Error("probe limit exceeded"); }), (problem) => { notices.push(problem); });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("recoverer probe failed");
		expect(failures).toBe(4);
		expect(notices).toContainEqual({ pid: SECOND_PID, error: "recoverer probe failed" });
	});

	test("persistent probe failures report the problem and return an error", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		let probes = 0;
		const notices: Array<{ pid: number; error: string } | undefined> = [];
		const result = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, async () => {
			probes += 1;
			if (probes > 4) throw new Error("probe limit exceeded");
			return err("probe failed");
		}, async () => { if (probes >= 4) throw new Error("probe limit exceeded"); }), (problem) => { notices.push(problem); });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("probe failed");
		expect(probes).toBe(4);
		expect(notices).toContainEqual({ pid: DEAD_PID, error: "probe failed" });
		expect(fs.files.has(LOCK_PATH)).toBe(true);
	});

	test("a successful probe resets the consecutive failure count", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		let probes = 0;
		const result = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, async () => {
			probes += 1;
			if (probes === 4) return ok(DEAD_START);
			if (probes >= 8) return ok(null);
			return err("probe failed");
		}), ignoreNotice);
		expect(result.ok).toBe(true);
		expect(probes).toBeGreaterThanOrEqual(8);
	});
	test("an unknown answer counts as running: the lock is kept and the caller waits", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		let questions = 0;
		let sleeps = 0;
		const result = await acquireLock(dependenciesFor(
			fs,
			FIRST_PID,
			FIRST_START,
			async () => {
				questions += 1;
				return questions <= UNKNOWN_ANSWERS_BEFORE_DEAD ? err("powershell failed") : ok(null);
			},
			async () => { sleeps += 1; expect(fs.files.get(LOCK_PATH)).toContain(`"pid":${DEAD_PID}`); },
		), ignoreNotice);
		expect(result.ok).toBe(true);
		expect(sleeps).toBe(UNKNOWN_ANSWERS_BEFORE_DEAD);
	});

	test("a throwing inspector also counts as running", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		const result = await tryAcquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, async () => { throw new Error("boom"); }));
		expect(result).toEqual(ok(null));
		expect(fs.files.has(LOCK_PATH)).toBe(true);
	});
});

describe("lock when waiting is not wanted", () => {
	test("a dead recovery claim reports busy without sleeping or advancing", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		fs.seed(CLAIM_PATH, JSON.stringify({ pid: SECOND_PID, startTime: SECOND_START }));
		const result = await tryAcquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(new Map()), async () => { throw new Error("must not wait"); }));
		expect(result).toEqual(ok(null));
		expect(fs.files.has(`${LOCK_PATH}.recover-${STALE_TOKEN}.1`)).toBe(false);
	});

	test("cleanup preserves another contender's unfinished claim files", async () => {
		const fs = new MemoryFileSystem();
		const temporary = `${CLAIM_PATH}.another-uuid.tmp`;
		fs.seed(temporary, "in progress");
		fs.seed(CLAIM_PATH, "finished");
		const result = await tryAcquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(new Map())));
		expect(result.ok && result.value !== null).toBe(true);
		expect(fs.files.has(temporary)).toBe(true);
		expect(fs.files.has(CLAIM_PATH)).toBe(false);
		if (result.ok && result.value !== null) await result.value.release();
		expect(fs.files.has(temporary)).toBe(true);
	});
	test("tryAcquireLock returns null at once while a live owner holds the lock", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: SECOND_PID, startTime: SECOND_START }));
		const result = await tryAcquireLock(dependenciesFor(
			fs,
			FIRST_PID,
			FIRST_START,
			liveOwners(new Map([[SECOND_PID, SECOND_START]])),
			async () => { throw new Error("must not wait"); },
		));
		expect(result).toEqual(ok(null));
	});

	test("tryAcquireLock reports busy when the lock vanishes between its create and read, without retrying", async () => {
		const fs = new MemoryFileSystem();
		let creates = 0;
		fs.writeExclusive = async () => { creates += 1; return ok(false); };
		fs.readText = async () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); };
		const result = await tryAcquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(new Map()), async () => { throw new Error("must not wait"); }));
		expect(result).toEqual(ok(null));
		expect(creates).toBe(1);
	});

	test("tryAcquireLock takes a free lock", async () => {
		const fs = new MemoryFileSystem();
		const result = await tryAcquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(new Map())));
		expect(result.ok && result.value !== null).toBe(true);
	});
});

describe("lock file creation failure", () => {
	test("a failed exclusive write becomes an error result, not an exception", async () => {
		const fs = new MemoryFileSystem();
		fs.writeExclusive = async () => err("disk full");
		const result = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(new Map())), ignoreNotice);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("disk full");
	});
});

describe("lock file read failure", () => {
	for (const failure of ["malformed claim", "atomic replace"]) {
		for (const persistent of [false, true]) {
			test(`${failure} ${persistent ? "exhausts the budget" : "recovers within the budget"}`, async () => {
				const fs = new MemoryFileSystem();
				fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
				if (failure === "malformed claim") fs.seed(CLAIM_PATH, "invalid");
				let failures = 0;
				let sleeps = 0;
				const rename = fs.rename.bind(fs);
				fs.rename = async (from, to) => {
					if (failure === "atomic replace" && (persistent || failures < RETRIES_BEFORE_FAILURE)) {
						failures += 1;
						throw new Error("sharing violation");
					}
					return rename(from, to);
				};
				const result = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(new Map()), async () => {
					sleeps += 1;
					if (failure === "malformed claim") {
						failures += 1;
						if (!persistent && failures === RETRIES_BEFORE_FAILURE) fs.files.delete(CLAIM_PATH);
					}
				}), ignoreNotice);
				expect(result.ok).toBe(!persistent);
				expect(sleeps).toBe(RETRIES_BEFORE_FAILURE);
				if (failure === "atomic replace") expect(failures).toBe(persistent ? READ_FAILURE_LIMIT : RETRIES_BEFORE_FAILURE);
			});
		}
	}
	test("persistent read errors end acquisition after the probe limit with sleeps between attempts", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		let reads = 0;
		const intervals: number[] = [];
		const writeExclusive = fs.writeExclusive.bind(fs);
		fs.writeExclusive = async (path, value) => reads > READ_FAILURE_LIMIT ? err("read limit exceeded") : writeExclusive(path, value);
		fs.readText = async () => {
			reads += 1;
			if (reads > READ_FAILURE_LIMIT) throw new Error("read limit exceeded");
			throw new Error("sharing violation");
		};
		const dependencies = dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(new Map()));
		dependencies.clock.sleep = async (milliseconds) => { intervals.push(milliseconds); };
		const result = await acquireLock(dependencies, ignoreNotice);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("sharing violation");
		expect(reads).toBe(READ_FAILURE_LIMIT);
		expect(intervals).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
	});

	test("a vanished lock retries immediately without consuming the failure budget", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		let reads = 0;
		const intervals: number[] = [];
		fs.readText = async () => {
			reads += 1;
			if (reads <= RETRIES_BEFORE_FAILURE) throw new Error("sharing violation");
			if (reads === READ_FAILURE_LIMIT) {
				fs.files.delete(LOCK_PATH);
				return await MemoryFileSystem.prototype.readText.call(fs, LOCK_PATH);
			}
			throw new Error("unexpected read");
		};
		const dependencies = dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(new Map()));
		dependencies.clock.sleep = async (milliseconds) => { intervals.push(milliseconds); };
		const result = await acquireLock(dependencies, ignoreNotice);
		expect(result.ok).toBe(true);
		expect(reads).toBe(READ_FAILURE_LIMIT);
		expect(intervals).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS, POLL_INTERVAL_MS, 0]);
	});

	for (const failedPath of [LOCK_PATH, CLAIM_PATH]) {
		test(`persistent recovery reads fail for ${failedPath}`, async () => {
			const fs = new MemoryFileSystem();
			fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
			if (failedPath === CLAIM_PATH) fs.seed(CLAIM_PATH, JSON.stringify({ pid: SECOND_PID, startTime: SECOND_START }));
			const readText = fs.readText.bind(fs);
			let failures = 0;
			let sleeps = 0;
			fs.readText = async (path) => {
				if (path === failedPath && (path === CLAIM_PATH || fs.files.has(CLAIM_PATH))) {
					failures += 1;
					throw new Error("recovery read failed");
				}
				return readText(path);
			};
			const writeExclusive = fs.writeExclusive.bind(fs);
			fs.writeExclusive = async (path, value) => failures > READ_FAILURE_LIMIT ? err("read limit exceeded") : writeExclusive(path, value);
			const result = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(new Map()), async () => { sleeps += 1; }), ignoreNotice);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain("recovery read failed");
			expect(failures).toBe(READ_FAILURE_LIMIT);
			expect(sleeps).toBe(RETRIES_BEFORE_FAILURE);
		});
	}
});

describe("lock wait notice", () => {
	test("probe errors identify the owner while the waiter continues waiting", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: SECOND_PID, startTime: SECOND_START }));
		const notices: Array<{ pid: number; error: string } | undefined> = [];
		let polls = 0;
		const result = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, async () => err("probe failed"), async () => {
			polls += 1;
			if (polls === WAIT_POLLS_BEFORE_RELEASE) fs.files.delete(LOCK_PATH);
		}), (problem) => { notices.push(problem); });
		expect(result.ok).toBe(true);
		expect(polls).toBe(WAIT_POLLS_BEFORE_RELEASE);
		expect(notices).toContainEqual({ pid: SECOND_PID, error: "probe failed" });
	});
	test("a busy lock calls the notice once, before the first wait, however many polls pass", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: SECOND_PID, startTime: SECOND_START }));
		const timeline: string[] = [];
		let polls = 0;
		const result = await acquireLock(dependenciesFor(
			fs,
			FIRST_PID,
			FIRST_START,
			liveOwners(new Map([[SECOND_PID, SECOND_START]])),
			async () => {
				timeline.push("wait");
				polls += 1;
				if (polls === WAIT_POLLS_BEFORE_RELEASE) fs.files.delete(LOCK_PATH);
			},
		), () => { timeline.push("notice"); });

		expect(result.ok).toBe(true);
		expect(timeline).toEqual(["notice", "wait", "wait", "wait"]);
	});

	test("a free lock does not call the notice", async () => {
		const fs = new MemoryFileSystem();
		let notices = 0;
		const result = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(new Map())), () => { notices += 1; });
		expect(result.ok).toBe(true);
		expect(notices).toBe(0);
	});

	test("a stale lock taken over at once does not call the notice", async () => {
		const fs = new MemoryFileSystem();
		fs.seed(LOCK_PATH, JSON.stringify({ pid: DEAD_PID, startTime: DEAD_START }));
		let notices = 0;
		const result = await acquireLock(dependenciesFor(fs, FIRST_PID, FIRST_START, liveOwners(new Map())), () => { notices += 1; });
		expect(result.ok).toBe(true);
		expect(notices).toBe(0);
	});
});
