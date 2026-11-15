import type { RigState } from "../../src/state.js";

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
		await rm(home, { recursive: true, force: true });
	}
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
