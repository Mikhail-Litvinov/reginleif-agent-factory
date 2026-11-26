// One server stack shared by the test files that only READ the stack or write DATA into their own tables (they never
// restart, kill, recreate or reconfigure it). Started once before all files (`node --test --test-global-setup`), removed
// once after all files, also when a test failed (node runs globalTeardown after failures).
//
// Only `docker compose up -d` runs here: the wait for health is done by the first file that needs the stack
// (sharedStack in helpers.ts), so the files that do not use it start at once instead of waiting 15-20 s for the server.
//
// The stack is described to the test files by one environment variable: node passes what globalSetup sets in
// process.env on to every test file process (measured with a probe on Node 24.16: the value was visible in the
// test file, and globalTeardown ran after a failing test).
import { freePort, newRunId, removeOwned, runChecked, stackArgs, stackEnv } from "../deploy/lib.ts";
import { Cleanups, newProject, newSecretsDir, SHARED_STACK_ENV, type SharedStackInfo } from "./helpers.ts";

const cleanups = new Cleanups();

export const globalSetup = async (): Promise<void> => {
	try {
		const secretsDir = await newSecretsDir(cleanups);
		const port = await freePort();
		const project = newProject();
		const runId = newRunId();
		// Registered before the stack exists: removing nothing is a no-op.
		cleanups.add(() => removeOwned(runId));
		const info: SharedStackInfo = { project, runId, secretsDir, port };
		await runChecked("docker", stackArgs(info, "up", "-d"), { env: stackEnv(info) });
		process.env[SHARED_STACK_ENV] = JSON.stringify(info);
	} catch (error) {
		await cleanups.runAll().catch(() => {});
		throw error;
	}
};

export const globalTeardown = async (): Promise<void> => {
	await cleanups.runAll();
};
