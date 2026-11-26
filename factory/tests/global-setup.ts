// One server stack shared by the test files that only READ the stack or write DATA into their own tables (they never
// restart, kill, recreate or reconfigure it). Started once before all files (`node --test --test-global-setup`), removed
// once after all files, also when a test failed (node runs globalTeardown after failures).
//
// Only the compose start of the two stacks runs here: the wait for health is done by the first file that needs the stack
// (sharedStack in helpers.ts), so the files that do not use it start at once instead of waiting 15-20 s for the server.
//
// The stack is described to the test files by one environment variable: node passes what globalSetup sets in
// process.env on to every test file process (measured with a probe on Node 24.16: the value was visible in the
// test file, and globalTeardown ran after a failing test).
import { freePort, newRunId, removeOwned, runChecked, stackArgs, stackEnv } from "../deploy/lib.ts";
import { sweepStale } from "./dead-owners.ts";
import { newPaths, snapshotUntracked, worktreeGuardMessage } from "./worktree-guard.ts";
import { BENCH_COMPOSE_FILE, BENCH_STACK_ENV, benchStackEnv, Cleanups, newBenchStackInfo, newProject, newSecretsDir, SHARED_STACK_ENV, type SharedStackInfo } from "./helpers.ts";

const cleanups = new Cleanups();
let untrackedAtStart: string[] | undefined;

// Stacks of earlier runs of this worktree whose process was killed (see dead-owners.ts for why this removes only those).
// A failure here must not block the run that is starting, but it is never silent.
const sweep = async (): Promise<void> => {
	const result = await sweepStale();
	if (result.swept.length > 0) console.error(`removed stacks left by dead test processes: ${result.swept.join(", ")}`);
};

export const globalSetup = async (): Promise<void> => {
	untrackedAtStart = await snapshotUntracked();
	await sweep().catch((error) => console.error(error instanceof Error ? error.message : error));
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
		// The bench stack (own secrets, run id and port; test pg_hba.conf), up next to the shared one; its health is awaited by
		// the first bench file, like the shared stack's.
		const bench = await newBenchStackInfo(cleanups);
		await runChecked("docker", stackArgs(bench, "-f", BENCH_COMPOSE_FILE, "up", "-d"), { env: benchStackEnv(bench) });
		process.env[BENCH_STACK_ENV] = JSON.stringify(bench);
	} catch (error) {
		try {
			await cleanups.runAll();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "starting the shared stack failed, and so did removing what it had created");
		}
		throw error;
	}
};

// The test files are finished here, so a stack that one of them left (its process ended without running its cleanup) has
// a dead owner: the same sweep removes it. The shared stack of this process is removed first and is never swept (own pid).
export const globalTeardown = async (): Promise<void> => {
	const errors: unknown[] = [];
	await cleanups.runAll().catch((error) => errors.push(error));
	await sweep().catch((error) => errors.push(error));
	if (untrackedAtStart) {
		const start = untrackedAtStart;
		const now = await snapshotUntracked().catch((error) => (console.error(error), (process.exitCode = 1), start));
		const created = newPaths(start, now);
		// Not thrown: a throwing global teardown makes the node runner loop forever.
		if (created.length > 0) {
			console.error(worktreeGuardMessage(created));
			process.exitCode = 1;
		}
	}
	if (errors.length > 0) throw new AggregateError(errors, "teardown of the test run failed");
};
