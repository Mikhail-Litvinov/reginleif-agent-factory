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
import { composeArgs, freePort, removeStack, run, startStack, type RunResult } from "../deploy/lib.ts";

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

// Registers the removal of a compose project, then returns its name; nothing exists yet, and removing nothing is fine.
export const trackedProject = (cleanups: Cleanups, secretsDir: string, port: number): string => {
	const project = newProject();
	cleanups.add(() => removeStack({ project, secretsDir, port }));
	return project;
};

// Creates the stack and waits until it is healthy. If anything fails on the way, what was created is removed.
export const createTestStack = async (): Promise<TestStack> => {
	const cleanups = new Cleanups();
	try {
		const secretsDir = await newSecretsDir(cleanups);
		const port = await freePort();
		const project = trackedProject(cleanups, secretsDir, port);
		const stack: TestStack = {
			project,
			secretsDir,
			port,
			container: "",
			dispose: () => cleanups.runAll(),
			secret: (name) => readFile(join(secretsDir, name), "utf8"),
		};
		stack.container = await startStack({ project, secretsDir, port });
		return stack;
	} catch (error) {
		await cleanups.runAll().catch(() => {});
		throw error;
	}
};

export const compose = (stack: TestStack, ...args: string[]): Promise<RunResult> =>
	run("docker", composeArgs(stack.project, ...args), { env: { AF_SECRETS_DIR: stack.secretsDir, AF_PG_PORT: String(stack.port) } });
