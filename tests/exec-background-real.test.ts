import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { createRealRuntime } from "../src/commands/real-runtime.js";
import { startExec, statusExec, stopExec } from "../src/exec-core.js";
import { withIsolatedHome } from "./helpers/isolated-home.js";

// Allow cold Bun and Git Bash starts: the runner and the shell are two process starts in a row.
const WAIT_BOUND_MS = 30_000;
const POLL_MS = 25;
const TEST_BOUND_MS = 60_000;
const TEMP_HOME_PREFIX = "rig-exec-background-home-";
// The background command sleeps this long; the run must outlive its foreground command by about this much.
const BACKGROUND_SECONDS = 3;
// Polling and process start-up take a little of the sleep; the run must still last most of it after "started" appears.
const MIN_RUN_AFTER_STARTED_MS = 2_000;
const LONG_SLEEP_SECONDS = 61;

const GIT_BASH_PATH = "C:\\Program Files\\Git\\bin\\bash.exe";
const hasGitBash = process.platform === "win32" && existsSync(GIT_BASH_PATH);

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
// that process ends, and the end code is the command's own. Needs Windows with Git Bash (the real runner is a separate
// process, so its kill-on-close job is the one a normal run uses).
for (const variant of [
	{ name: "that keeps the output pipes", text: `sleep ${BACKGROUND_SECONDS} & echo started` },
	{ name: "with its output redirected away", text: `sleep ${BACKGROUND_SECONDS} >/dev/null 2>&1 & echo started` },
]) {
	test.skipIf(!hasGitBash)(`a run stays running while its background process lives, ${variant.name}`, async () => {
		await withIsolatedHome(TEMP_HOME_PREFIX, async () => {
			const runtime = await makeRuntime();
			const started = await startExec(runtime, "bash", runtime.currentDirectory, variant.text);
			if (!started.ok) throw new Error(started.error.message);
			const id = startedId(started.value);
			try {
				const deadline = Date.now() + WAIT_BOUND_MS;
				while (!logText(await status(runtime, id)).includes("started") && Date.now() < deadline) await runtime.clock.sleep(POLL_MS);
				const seenAt = Date.now();
				const whileBackground = await status(runtime, id);
				expect(logText(whileBackground)).toContain("started");
				expect(whileBackground.state).toBe("running");
				while ((await status(runtime, id)).state === "running" && Date.now() < deadline) await runtime.clock.sleep(POLL_MS);
				const ended = await status(runtime, id);
				expect(ended).toMatchObject({ state: "ended", end: { kind: "exit", code: 0 } });
				expect(Date.now() - seenAt).toBeGreaterThanOrEqual(MIN_RUN_AFTER_STARTED_MS);
			} finally { await runtime.fs.removeDirectoryTree(runtime.resolvePath(runtime.home, ".agent-rig", "exec", id)); }
		});
	}, TEST_BOUND_MS);
}

test.skipIf(!hasGitBash)("stop of a run whose command has already exited kills its background process", async () => {
	await withIsolatedHome(TEMP_HOME_PREFIX, async () => {
		const runtime = await makeRuntime();
		const text = [`sleep ${LONG_SLEEP_SECONDS} >/dev/null 2>&1 &`, `cat /proc/$!/winpid`, `echo started`, ""].join("\n");
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
			expect(await status(runtime, id)).toMatchObject({ state: "ended", end: { kind: "stopped" } });
		} finally {
			if (sleepPid !== 0 && alive(sleepPid)) process.kill(sleepPid);
			await runtime.fs.removeDirectoryTree(runtime.resolvePath(runtime.home, ".agent-rig", "exec", id));
		}
	});
}, TEST_BOUND_MS);
