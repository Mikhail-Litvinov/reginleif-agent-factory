// Test helpers: every test stack has its own project name (af-test-<random>), its own secrets directory under the
// language temp directory and its own free port, and is removed by dispose() (call it from an after hook, which runs
// also when tests fail).
//
// Cleanup is registered BEFORE the resource it undoes is created (Cleanups.add, then create), so a failure at any step,
// even halfway through creating a resource, still removes everything that may exist. Removal is idempotent: removing a
// project that was never created is a no-op, so registering early is safe.
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecrets } from "../deploy/setup-secrets.ts";
import { findContainer, freePort, newRunId, ownedResources, removeOwned, run, stackArgs, stackEnv, startStack, waitHealthy, type RunResult } from "../deploy/lib.ts";

// A stack of undo actions, run last-registered first; one failing action does not stop the rest.
export class Cleanups {
	private readonly actions: Array<() => Promise<unknown>> = [];

	add(action: () => Promise<unknown>): void {
		this.actions.push(action);
	}

	async runAll(): Promise<void> {
		const errors: unknown[] = [];
		for (const action of this.actions.splice(0).reverse()) {
			try {
				await action();
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length > 0) throw new AggregateError(errors, "cleanup failed");
	}
}

export interface TestStack {
	readonly project: string;
	readonly runId: string;
	readonly secretsDir: string;
	readonly port: number;
	container: string;
	dispose(): Promise<void>;
	secret(name: string): Promise<string>;
}

export const newProject = (): string => `af-test-${randomBytes(4).toString("hex")}`;

// A secrets directory that cleanups removes (registered first, then created).
export const newSecretsDir = async (cleanups: Cleanups): Promise<string> => {
	let dir = "";
	cleanups.add(async () => {
		if (dir) await rm(dir, { recursive: true, force: true });
	});
	dir = await mkdtemp(join(tmpdir(), "af-test-secrets-"));
	createSecrets(dir);
	return dir;
};

// Registers the removal of everything that carries a new run id, then returns the project and the id; nothing exists yet,
// and removing nothing is fine. The removal fails (with docker's output) when a docker command fails or anything is left.
export const trackedProject = (cleanups: Cleanups): { project: string; runId: string } => {
	const project = newProject();
	const runId = newRunId();
	cleanups.add(() => removeOwned(runId));
	return { project, runId };
};

// Everything this run created that still exists, by its label. Throws when a listing fails (never reads as "empty").
export const leftovers = async (runId: string): Promise<string[]> => {
	const found = await ownedResources(runId);
	return [...found.containers.map((n) => `container ${n}`), ...found.volumes.map((n) => `volume ${n}`), ...found.networks.map((n) => `network ${n}`)];
};

// Creates the stack and waits until it is healthy. If anything fails on the way, what was created is removed.
export const createTestStack = async (): Promise<TestStack> => {
	const cleanups = new Cleanups();
	try {
		const secretsDir = await newSecretsDir(cleanups);
		const port = await freePort();
		const { project, runId } = trackedProject(cleanups);
		const stack: TestStack = {
			runId,
			project,
			secretsDir,
			port,
			container: "",
			dispose: () => cleanups.runAll(),
			secret: (name) => readFile(join(secretsDir, name), "utf8"),
		};
		stack.container = await startStack({ project, secretsDir, port, runId });
		return stack;
	} catch (error) {
		await cleanups.runAll().catch(() => {});
		throw error;
	}
};

// The stack that global-setup.ts started for the whole run, as it is passed to the test files.
export const SHARED_STACK_ENV = "AF_SHARED_STACK";
export interface SharedStackInfo {
	readonly project: string;
	readonly runId: string;
	readonly secretsDir: string;
	readonly port: number;
}

// The run-wide stack, for files that only read it or write data into their own tables (never restart, kill, recreate or
// reconfigure it, and never run DDL a concurrent pg_dump could trip over). Waits until it is healthy; dispose() does
// nothing, global-setup.ts's teardown removes it. Without global setup (a single file run by hand) it falls back to an
// own stack that dispose() removes, so every file still runs alone.
export const sharedStack = async (): Promise<TestStack> => {
	const text = process.env[SHARED_STACK_ENV];
	if (!text) return createTestStack();
	const info = JSON.parse(text) as SharedStackInfo;
	const container = await findContainer(info.project);
	await waitHealthy(container);
	return {
		...info,
		container,
		dispose: async () => {},
		secret: (name) => readFile(join(info.secretsDir, name), "utf8"),
	};
};

export const compose = (stack: TestStack, ...args: string[]): Promise<RunResult> =>
	run("docker", stackArgs(stack, ...args), { env: stackEnv(stack) });
