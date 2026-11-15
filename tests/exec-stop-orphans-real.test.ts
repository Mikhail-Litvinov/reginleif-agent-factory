import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRealRuntime } from "../src/commands/real-runtime.js";

// Allow cold Bun and Git Bash starts: the runner and the shell are two process starts in a row.
const WAIT_BOUND_MS = 20_000;
const POLL_MS = 25;
const TEST_BOUND_MS = 40_000;
const LONG_SLEEP_SECONDS = 61;

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const REPOSITORY_RUNTIME = join(import.meta.dir, "..", "src", "commands", "real-runtime.ts").replaceAll("\\", "/");
const hasGitBash = process.platform === "win32" && existsSync(GIT_BASH);

const alive = (pid: number): boolean => {
	try { process.kill(pid, 0); return true; } catch { return false; }
};

const waitFor = async (condition: () => Promise<boolean> | boolean): Promise<boolean> => {
	const deadline = Date.now() + WAIT_BOUND_MS;
	while (Date.now() < deadline) {
		if (await condition()) return true;
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
	}
	return condition();
};

// Git Bash starts its commands with a breakaway flag, so they leave Bun's own job and a parent-walking tree kill
// (`taskkill /T`) does not reach them. Only the runner's own kill-on-close job does. Needs Windows with Git Bash.
test.skipIf(!hasGitBash)("killing a run's runner also ends the Git Bash command it started", async () => {
	const directory = await mkdtemp(join(tmpdir(), "rig-orphan-"));
	const pidFile = join(directory, "command.pid").replaceAll("\\", "/");
	const commandScript = join(directory, "command.sh").replaceAll("\\", "/");
	const runnerScript = join(directory, "runner.ts");
	let commandPid = 0;
	let runner: ReturnType<typeof Bun.spawn> | null = null;
	try {
		await writeFile(commandScript, [`sleep ${LONG_SLEEP_SECONDS} &`, `cat /proc/$!/winpid > ${pidFile}`, `wait`, ""].join("\n"));
		await writeFile(runnerScript, [
			`import { createRealRuntime } from ${JSON.stringify(REPOSITORY_RUNTIME)};`,
			`const created = await createRealRuntime();`,
			`if (!created.ok) throw new Error(created.error);`,
			`const runtime = created.value;`,
			`await runtime.process.runStreaming([${JSON.stringify(GIT_BASH)}, "-l", ${JSON.stringify(commandScript)}], process.cwd(), runtime.environment.entries(), async () => {}, false);`,
		].join("\n"));
		const created = await createRealRuntime();
		if (!created.ok) throw new Error(created.error);
		const runtime = created.value;
		runner = Bun.spawn([runtime.executablePath, runnerScript], { stdio: ["ignore", "ignore", "ignore"] });
		expect(await waitFor(async () => /^\d+/.test(await readFile(pidFile, "utf8").catch(() => "")))).toBe(true);
		commandPid = Number((await readFile(pidFile, "utf8")).trim());
		expect(alive(commandPid)).toBe(true);
		const killed = await runtime.process.killTree(runner.pid, true);
		expect(killed.ok).toBe(true);
		expect(await waitFor(() => !alive(commandPid))).toBe(true);
	} finally {
		if (commandPid !== 0 && alive(commandPid)) process.kill(commandPid);
		runner?.kill();
		await rm(directory, { recursive: true, force: true });
	}
}, TEST_BOUND_MS);
