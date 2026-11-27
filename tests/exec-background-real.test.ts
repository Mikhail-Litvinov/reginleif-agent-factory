import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createRealRuntime } from "../src/commands/real-runtime.js";
import { EXEC_RUN_POLL_MS, startExec, statusExec, stopExec } from "../src/exec-core.js";
import { withIsolatedHome } from "./helpers/isolated-home.js";

// Allow cold Bun and Git Bash starts: the runner and the shell are two process starts in a row.
const WAIT_BOUND_MS = 30_000;
const POLL_MS = 25;
const TEST_BOUND_MS = 60_000;
const TEMP_HOME_PREFIX = "rig-exec-background-home-";
// The background process waits for a release file instead of sleeping a fixed time: a fixed sleep races against how
// late a loaded machine lets the test observe the run (the run is seen ended when the sleep ran out first). While the
// file is absent the run cannot end, however slow the observation is.
// The run is held this long after "started" appears: two supervision polls, enough for the runner to end the run if it
// wrongly treated the exited foreground command as the end.
const HOLD_AFTER_STARTED_MS = 2 * EXEC_RUN_POLL_MS;
const LONG_SLEEP_SECONDS = 61;

const GIT_BASH_PATH = "C:\\Program Files\\Git\\bin\\bash.exe";
const POSIX_BASH_PATH = "/bin/bash";
// Windows needs Git Bash (its commands leave Bun's job, so only the runner's own job holds them); Linux and macOS use the system bash.
const hasBash = process.platform === "win32" ? existsSync(GIT_BASH_PATH) : existsSync(POSIX_BASH_PATH);
// The command line that prints the background process's id as the shell's job table knows it: on Windows the real Windows pid (`kill(pid, 0)` of Bun needs that one), on POSIX the pid itself.
const PRINT_BACKGROUND_PID = process.platform === "win32" ? "cat /proc/$!/winpid" : "echo $!";

const alive = (pid: number): boolean => {
	try { process.kill(pid, 0); return true; } catch { return false; }
};

const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Reads the run's status; a status that cannot be read fails the test.
const status = async (runtime: Awaited<ReturnType<typeof makeRuntime>>, id: string): Promise<Record<string, unknown>> => {
	const result = await statusExec(runtime, id, 0);
	if (!result.ok || !object(result.value)) throw new Error("Status unavailable");
	return result.value;
};

const makeRuntime = async () => {
	const created = await createRealRuntime();
	if (!created.ok) throw new Error(created.error);
	return created.value;
};

const startedId = (value: unknown): string => {
	if (!object(value) || typeof value.id !== "string") throw new Error("Unexpected start result");
	return value.id;
};

const logText = (status: Record<string, unknown>): string => {
	const log = status.log;
	return object(log) && typeof log.text === "string" ? log.text : "";
};

// A run is one unit of all its processes: a command that leaves a background process behind keeps the run running until
// that process ends, and the end code is the command's own. Needs bash: Git Bash on Windows, the system bash elsewhere (the real runner is a separate
// process, so its kill-on-close job is the one a normal run uses).
// The shell's path of a file: forward slashes, which Git Bash and POSIX bash both read.
const shellPath = (path: string): string => path.replaceAll("\\", "/");
// A background process that lives until the release file appears.
const waitForRelease = (release: string): string => `(while [ ! -e "${shellPath(release)}" ]; do sleep 0.1; done)`;

for (const variant of [
	{ name: "that keeps the output pipes", redirect: "" },
	{ name: "with its output redirected away", redirect: " >/dev/null 2>&1" },
]) {
	test.skipIf(!hasBash)(`a run stays running while its background process lives, ${variant.name}`, async () => {
		await withIsolatedHome(TEMP_HOME_PREFIX, async (home) => {
			const release = join(home, "release");
			const runtime = await makeRuntime();
			const started = await startExec(runtime, "bash", runtime.currentDirectory, `${waitForRelease(release)}${variant.redirect} & echo started`);
			if (!started.ok) throw new Error(started.error.message);
			const id = startedId(started.value);
			try {
				const deadline = Date.now() + WAIT_BOUND_MS;
				while (!logText(await status(runtime, id)).includes("started") && Date.now() < deadline) await runtime.clock.sleep(POLL_MS);
				// The foreground command has exited; the background process holds the run for the whole hold, which spans supervision polls.
				const holdEnd = Date.now() + HOLD_AFTER_STARTED_MS;
				while (Date.now() < holdEnd) {
					const whileBackground = await status(runtime, id);
					expect(logText(whileBackground)).toContain("started");
					expect(whileBackground.state).toBe("running");
					await runtime.clock.sleep(POLL_MS);
				}
				writeFileSync(release, "");
				const endBound = Date.now() + WAIT_BOUND_MS;
				while ((await status(runtime, id)).state === "running" && Date.now() < endBound) await runtime.clock.sleep(POLL_MS);
				expect(await status(runtime, id)).toMatchObject({ state: "ended", end: { kind: "exit", code: 0 } });
			} finally {
				// A failed test must not leave the background process waiting: releasing it lets the run end and the runner exit.
				writeFileSync(release, "");
			}
		});
	}, TEST_BOUND_MS);
}

test.skipIf(!hasBash)("stop of a run whose command has already exited kills its background process", async () => {
	await withIsolatedHome(TEMP_HOME_PREFIX, async () => {
		const runtime = await makeRuntime();
		const text = [`sleep ${LONG_SLEEP_SECONDS} >/dev/null 2>&1 &`, PRINT_BACKGROUND_PID, `echo started`, ""].join("\n");
		const started = await startExec(runtime, "bash", runtime.currentDirectory, text);
		if (!started.ok) throw new Error(started.error.message);
		const id = startedId(started.value);
		let sleepPid = 0;
		try {
			const deadline = Date.now() + WAIT_BOUND_MS;
			let current = await status(runtime, id);
			while (!logText(current).includes("started") && Date.now() < deadline) { await runtime.clock.sleep(POLL_MS); current = await status(runtime, id); }
			const pid = Number(logText(current).split("\n")[0]?.trim());
			expect(Number.isInteger(pid) && pid > 0).toBe(true);
			sleepPid = pid;
			expect(alive(sleepPid)).toBe(true);
			expect(current.state).toBe("running");
			const stopped = await stopExec(runtime, id);
			expect(stopped.ok).toBe(true);
			const waitEnd = Date.now() + WAIT_BOUND_MS;
			while (alive(sleepPid) && Date.now() < waitEnd) await runtime.clock.sleep(POLL_MS);
			expect(alive(sleepPid)).toBe(false);
			// The runner killed the member itself and records the end a poll later.
			while ((await status(runtime, id)).state === "running" && Date.now() < waitEnd) await runtime.clock.sleep(POLL_MS);
			expect(await status(runtime, id)).toMatchObject({ state: "ended", end: { kind: "stopped" } });
		} finally {
			// The run directory goes with the temporary home, after the runner has exited (withIsolatedHome).
			if (sleepPid !== 0 && alive(sleepPid)) process.kill(sleepPid);
		}
	});
}, TEST_BOUND_MS);
