import { expect, test } from "bun:test";

import { createRealRuntime } from "../src/commands/real-runtime.js";
import { runExecRunner } from "../src/exec-core.js";
import { apiOk } from "../src/output.js";
import { withIsolatedHome } from "./helpers/isolated-home.js";

// Allow a cold Bun process to start; poll quickly and stop as soon as its exit file appears.
const WAIT_BOUND_MS = 10_000;
const POLL_MS = 20;
const EXPECTED_EXIT = 3;
const TEST_BOUND_MS = 20_000;
const TEMP_HOME_PREFIX = "rig-exec-home-";

test("real runner appends both streams and writes its exit code", async () => {
	await withIsolatedHome(TEMP_HOME_PREFIX, async (directory) => {
		const result = await createRealRuntime();
		if (!result.ok) throw new Error(result.error);
		const runtime = result.value;
		const runDir = runtime.resolvePath(directory, ".agent-rig", "exec", "real-run");
		await runtime.fs.ensureDirectory(runDir);
		await runtime.fs.writeText(`${runDir}/record.json`, JSON.stringify({ id: "real-run", shell: "bash", cwd: directory, text: "", startedAt: runtime.clock.nowText() }));
		await runtime.fs.writeText(`${runDir}/log`, "");
		const script = runtime.resolvePath(directory, "child.js");
		await runtime.fs.writeText(script, `console.log("line one"); console.error("line two"); process.exit(${EXPECTED_EXIT});`);
		const running = runExecRunner(runtime, "real-run", async () => apiOk({ argv: [runtime.executablePath, script], env: runtime.environment.entries(), files: [] }));
		const deadline = Date.now() + WAIT_BOUND_MS;
		while (await runtime.fs.stat(`${runDir}/exit.json`) === null && Date.now() < deadline) await runtime.clock.sleep(POLL_MS);
		expect(await runtime.fs.stat(`${runDir}/exit.json`)).not.toBeNull();
		expect(await running).toBe(0);
		const log = await runtime.fs.readText(`${runDir}/log`);
		expect(log).toContain("line one");
		expect(log).toContain("line two");
		expect(JSON.parse(await runtime.fs.readText(`${runDir}/exit.json`))).toMatchObject({ kind: "exit", code: EXPECTED_EXIT });
	});
}, TEST_BOUND_MS);
