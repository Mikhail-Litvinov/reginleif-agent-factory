import type { FileSystem } from "./file-system.js";
import type { Messages } from "./messages.js";
import type { Result } from "./result.js";

import { atomicWrite, joinPath } from "./file-system.js";
import { err, errorText, ok } from "./result.js";

// One initial probe and three retries allow transient process-query failures to clear without hanging callers indefinitely.
const MAX_CONSECUTIVE_PROBE_FAILURES = 4;
// Kept for callers checking the age of legacy takeover files during migration.
export const TAKEOVER_STALE_MS = 30_000;

export type LockOwner = { pid: number; startTime: number };
type LockRecord = LockOwner & { token: string };
export type LockDependencies = {
	fs: FileSystem;
	home: string;
	lockPath?: string;
	messages: Messages;
	process: {
		pid: number;
		startTime: number;
		// ok(number): start time of the running process; ok(null): no such process; err: could not find out.
		ownerStartTime(pid: number): Promise<Result<number | null>>;
	};
	clock: { sleep(milliseconds: number): Promise<void>; now(): number };
	pollIntervalMs: number;
};
export type LockHandle = { release(): Promise<Result<void>> };

const isMissing = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const parseOwner = (text: string): LockOwner | null => {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	if (!("pid" in value) || typeof value.pid !== "number" || !("startTime" in value) || typeof value.startTime !== "number") return null;
	return { pid: value.pid, startTime: value.startTime };
};

// Old lock files have no token; their identity supplies a stable, separate legacy token during migration.
const parseLock = (text: string): LockRecord | null => {
	const owner = parseOwner(text);
	if (owner === null) return null;
	let value: unknown;
	try { value = JSON.parse(text); } catch { return null; }
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	if ("token" in value && (typeof value.token !== "string" || !/^[a-zA-Z0-9-]+$/.test(value.token))) return null;
	const token = "token" in value && typeof value.token === "string" ? value.token : `legacy-${owner.pid}-${owner.startTime}`;
	return { ...owner, token };
};

// Unknown counts as running: taking a live lock is worse than waiting a little longer.
const ownerMayBeRunning = async (owner: LockOwner, dependencies: LockDependencies): Promise<Result<boolean>> => {
	if (!Number.isInteger(owner.pid) || !Number.isFinite(owner.startTime)) return ok(false);
	try {
		const start = await dependencies.process.ownerStartTime(owner.pid);
		if (!start.ok) return start;
		return ok(start.value === owner.startTime);
	} catch (error) {
		return err(dependencies.messages.failure.unexpectedFailure(errorText(error)));
	}
};

const cleanClaims = async (fs: FileSystem, lockPath: string, token: string): Promise<void> => {
	const separator = lockPath.lastIndexOf("/");
	const directory = separator < 0 ? "." : lockPath.slice(0, separator) || "/";
	const prefix = `${lockPath.slice(separator + 1)}.recover-`;
	for (const entry of await fs.listDirectory(directory)) {
		if (!entry.directory && entry.name === `${lockPath.slice(separator + 1)}.takeover`) {
			await fs.remove(joinPath(directory, entry.name)).catch(() => undefined);
		}
		if (!entry.directory && entry.name.startsWith(prefix) && !entry.name.startsWith(`${prefix}${token}.`)) {
			await fs.remove(joinPath(directory, entry.name)).catch(() => undefined);
		}
	}
};

const createHandle = (fs: FileSystem, lockPath: string, owner: LockRecord, messages: Messages): LockHandle => {
	let released = false;
	return {
		release: async () => {
			if (released) return ok(undefined);
			try {
				await cleanClaims(fs, lockPath, owner.token).catch(() => undefined);
				const current = parseLock(await fs.readText(lockPath));
				if (current?.token === owner.token) await fs.remove(lockPath);
				released = true;
				return ok(undefined);
			} catch (error) {
				return err(messages.failure.lockReleaseFailed(errorText(error)));
			}
		},
	};
};

type Recovery = { kind: "acquired" } | { kind: "wait" } | { kind: "read-failure"; cause: unknown } | { kind: "problem"; problem: LockProbeProblem };

// Each generation can advance only after every earlier recoverer is dead. The lock is replaced atomically, never removed.
const takeOverStale = async (fs: FileSystem, lockPath: string, stale: LockRecord, owner: LockRecord, dependencies: LockDependencies): Promise<Result<Recovery>> => {
	for (let generation = 0; ; generation += 1) {
		const path = `${lockPath}.recover-${stale.token}.${generation}`;
		const created = await fs.writeExclusive(path, `${JSON.stringify(owner)}\n`);
		if (!created.ok) return created;
		if (created.value) {
			let current: LockRecord | null;
			try { current = parseLock(await fs.readText(lockPath)); } catch (error) {
				await fs.remove(path).catch(() => undefined);
				return isMissing(error) ? ok({ kind: "wait" }) : ok({ kind: "read-failure", cause: error });
			}
			if (current?.token !== stale.token) {
				await fs.remove(path).catch(() => undefined);
				return ok({ kind: "wait" });
			}
			const replaced = await atomicWrite(fs, lockPath, `${JSON.stringify(owner)}\n`, dependencies.messages);
			if (!replaced.ok) {
				await fs.remove(path).catch(() => undefined);
				return replaced;
			}
			return ok({ kind: "acquired" });
		}
		let text: string;
		try { text = await fs.readText(path); } catch (error) {
			return isMissing(error) ? ok({ kind: "wait" }) : ok({ kind: "read-failure", cause: error });
		}
		const recoverer = parseOwner(text);
		if (recoverer === null) return err(dependencies.messages.failure.lockMalformed());
		const running = await ownerMayBeRunning(recoverer, dependencies);
		if (!running.ok) return ok({ kind: "problem", problem: { pid: recoverer.pid, error: running.error } });
		if (running.value) return ok({ kind: "wait" });
		await dependencies.clock.sleep(dependencies.pollIntervalMs);
	}
};

// onWait is null when the caller does not wait: then a live owner means ok(null) at once.
type LockProbeProblem = { pid: number; error: string };
const acquire = async (dependencies: LockDependencies, onWait: ((problem?: LockProbeProblem) => void) | null): Promise<Result<LockHandle | null>> => {
	const fs = dependencies.fs;
	const lockPath = dependencies.lockPath ?? joinPath(dependencies.home, ".agent-rig", "rig.lock");
	try {
		await fs.ensureDirectory(joinPath(dependencies.home, ".agent-rig"));
		const owner: LockRecord = { pid: dependencies.process.pid, startTime: dependencies.process.startTime, token: `new-${fs.uniqueSuffix()}` };
		let announced = false;
		let lastProblem = "";
		let consecutiveProbeFailures = 0;
		// Read and identity failures have separate budgets: a successful lock read cannot validate a claim read.
		let consecutiveReadFailures = 0;
		const readFailure = async (error: string): Promise<Result<void>> => {
			consecutiveReadFailures += 1;
			if (onWait === null || consecutiveReadFailures >= MAX_CONSECUTIVE_PROBE_FAILURES) return err(dependencies.messages.failure.lockAcquireFailed(error));
			if (!announced) { announced = true; onWait(); }
			await dependencies.clock.sleep(dependencies.pollIntervalMs);
			return ok(undefined);
		};
		const wait = async (problem?: LockProbeProblem): Promise<Result<void>> => {
			if (onWait === null) return ok(undefined);
			if (!announced) { announced = true; onWait(); }
			if (problem === undefined) {
				lastProblem = "";
				consecutiveProbeFailures = 0;
			} else {
				consecutiveProbeFailures += 1;
				const key = JSON.stringify(problem);
				if (key !== lastProblem) onWait(problem);
				lastProblem = key;
				if (consecutiveProbeFailures >= MAX_CONSECUTIVE_PROBE_FAILURES) return err(dependencies.messages.failure.lockAcquireFailed(dependencies.messages.lock.probeFailed(problem.pid, problem.error)));
			}
			await dependencies.clock.sleep(dependencies.pollIntervalMs);
			return ok(undefined);
		};
		const handle = async (): Promise<Result<LockHandle | null>> => {
			await cleanClaims(fs, lockPath, owner.token).catch(() => undefined);
			return ok(createHandle(fs, lockPath, owner, dependencies.messages));
		};
		while (true) {
			const created = await fs.writeExclusive(lockPath, `${JSON.stringify(owner)}\n`);
			if (!created.ok) return err(created.error);
			if (created.value) return await handle();
			let existingText: string;
			try {
				existingText = await fs.readText(lockPath);
			} catch (error) {
				if (isMissing(error)) {
					// The holder released between our create and read: a non-waiting caller reports busy rather than
					// retrying, so sustained contention cannot keep it from returning.
					if (onWait === null) return ok(null);
					await dependencies.clock.sleep(0);
					continue;
				}
				const waited = await readFailure(errorText(error));
				if (!waited.ok) return waited;
				continue;
			}
			const existing = parseLock(existingText);
			if (existing === null) return err(dependencies.messages.failure.lockMalformed());
			const running = await ownerMayBeRunning(existing, dependencies);
			if (!running.ok || running.value) {
				consecutiveReadFailures = 0;
				if (onWait === null) return ok(null);
				const waited = await wait(running.ok ? undefined : { pid: existing.pid, error: running.error });
				if (!waited.ok) return waited;
				continue;
			}
			const recovery = await takeOverStale(fs, lockPath, existing, owner, dependencies);
			if (!recovery.ok) return recovery;
			if (recovery.value.kind === "read-failure") {
				const waited = await readFailure(errorText(recovery.value.cause));
				if (!waited.ok) return waited;
				continue;
			}
			consecutiveReadFailures = 0;
			if (recovery.value.kind === "acquired") return await handle();
			if (onWait === null) return ok(null);
			const waited = await wait(recovery.value.kind === "problem" ? recovery.value.problem : undefined);
			if (!waited.ok) return waited;
		}
	} catch (error) {
		return err(dependencies.messages.failure.lockAcquireFailed(errorText(error)));
	}
};

// onWait runs at most once, right before the first wait, and only when a live owner holds the lock.
export const acquireLock = async (dependencies: LockDependencies, onWait: (problem?: LockProbeProblem) => void): Promise<Result<LockHandle>> => {
	const acquired = await acquire(dependencies, onWait);
	if (!acquired.ok) return acquired;
	return acquired.value === null ? err(dependencies.messages.failure.lockHeld()) : ok(acquired.value);
};

// Takes the lock only if it is free right now; ok(null) means another live process holds it.
export const tryAcquireLock = (dependencies: LockDependencies): Promise<Result<LockHandle | null>> => acquire(dependencies, null);
