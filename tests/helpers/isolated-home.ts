import type { RigState } from "../../src/state.js";

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// This file lives in tests/helpers, so the repository root is two levels up; the seeded state.json points at it.
const REPOSITORY_ROOT = join(import.meta.dir, "..", "..").replaceAll("\\", "/");

type SavedEnvironment = { USERPROFILE: string | undefined; HOME: string | undefined };

// Runs body with USERPROFILE and HOME pointed at a new temporary home that holds a state.json for this repository.
// Processes that body starts inherit the environment, so they use the same home. The temporary home is removed when
// body ends, also when it fails. The real home is not compared before and after: a live session (the hub) may start or
// prune its own runs there meanwhile; tests prove isolation positively by finding their run files under the temp home.
export const withIsolatedHome = async (prefix: string, body: (home: string) => Promise<void>): Promise<void> => {
	const saved: SavedEnvironment = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
	const home = await mkdtemp(join(tmpdir(), prefix));
	try {
		await seedState(home);
		process.env.USERPROFILE = home;
		process.env.HOME = home;
		await body(home);
	} finally {
		restoreVariable("USERPROFILE", saved.USERPROFILE);
		restoreVariable("HOME", saved.HOME);
		// A runner writes its end (exit.json) and only then exits, so a run that has ended may still hold files of its
		// directory open; removing the home before the runner is gone fails with EBUSY on Windows under load.
		const stillAlive = await waitRunnersGone(home);
		await rm(home, { recursive: true, force: true });
		if (stillAlive.length > 0) throw new Error(`Exec runner still alive after the test: pid ${stillAlive.join(", ")}`);
	}
};

// Upper bound for a runner to leave after its end is written: it only closes its files and exits (a process start can be starved under load).
export const RUNNER_GONE_BOUND_MS = 30_000;
const RUNNER_GONE_POLL_MS = 25;

const pidAlive = (pid: number): boolean => {
	try { process.kill(pid, 0); return true; } catch { return false; }
};

// The runner pids that the runs under home recorded in their identity.json (the runner writes it first, before launching the shell).
const runnerPids = async (home: string): Promise<number[]> => {
	const execDir = join(home, ".agent-rig", "exec");
	const pids: number[] = [];
	for (const entry of await readdir(execDir).catch(() => [] as string[])) {
		try {
			const identity = JSON.parse(await readFile(join(execDir, entry, "identity.json"), "utf8")) as { pid?: unknown };
			// A runner the test runs in-process records the test's own pid: it has finished when its promise resolved, and waiting for ourselves would never end.
			if (typeof identity.pid === "number" && Number.isInteger(identity.pid) && identity.pid > 0 && identity.pid !== process.pid) pids.push(identity.pid);
		} catch { /* no identity yet, or a run directory already removed by the test */ }
	}
	return pids;
};

// Waits until every runner recorded under home has exited; returns the pids still alive at the bound.
export const waitRunnersGone = async (home: string): Promise<number[]> => {
	const pids = await runnerPids(home);
	const deadline = Date.now() + RUNNER_GONE_BOUND_MS;
	let alive = pids.filter(pidAlive);
	while (alive.length > 0 && Date.now() < deadline) {
		await new Promise(resolve => setTimeout(resolve, RUNNER_GONE_POLL_MS));
		alive = alive.filter(pidAlive);
	}
	return alive;
};

const seedState = async (home: string): Promise<void> => {
	const state: RigState = {
		mode: "dev",
		paths: { repo: REPOSITORY_ROOT, hub: join(home, "hub").replaceAll("\\", "/") },
		features: {},
		records: {},
		badPairs: [],
		pendingHubRestart: null,
	};
	await mkdir(join(home, ".agent-rig"), { recursive: true });
	await writeFile(join(home, ".agent-rig", "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
};

const restoreVariable = (name: "USERPROFILE" | "HOME", value: string | undefined): void => {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
};
