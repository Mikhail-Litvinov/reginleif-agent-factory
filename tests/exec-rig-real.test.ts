import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { runExecCommand } from "../src/commands/exec.js";
import { createRealRuntime } from "../src/commands/real-runtime.js";
import { readStatus } from "../src/commands/status.js";
import { withIsolatedHome } from "./helpers/isolated-home.js";

// Allow a cold Bun process to start twice (runner, then rig); poll quickly and stop at the end.
const WAIT_BOUND_MS = 30_000;
const POLL_MS = 50;
const TEST_BOUND_MS = 40_000;
const TEMP_HOME_PREFIX = "rig-exec-rig-home-";

test("rig exec start rig -- status runs rig's own read-only command through the real runner", async () => {
	await withIsolatedHome(TEMP_HOME_PREFIX, async (home) => {
		const made = await createRealRuntime();
		if (!made.ok) throw new Error(made.error);
		const runtime = made.value;
		const started = await runExecCommand(runtime, "start", ["rig", "--", "status"]);
		if (!started.ok) throw new Error(started.error.message);
		const value = started.value;
		if (typeof value !== "object" || value === null || Array.isArray(value) || typeof value.id !== "string") throw new Error("Unexpected start result");
		const id = value.id;
		// The run directory goes with the temporary home, after the runner has exited (withIsolatedHome).
		{
			expect(value.shell).toBe("rig");
			const deadline = Date.now() + WAIT_BOUND_MS;
			let latest = await runExecCommand(runtime, "status", [id]);
			while (latest.ok && typeof latest.value === "object" && latest.value !== null && !Array.isArray(latest.value) && latest.value.state === "running" && Date.now() < deadline) {
				await runtime.clock.sleep(POLL_MS);
				latest = await runExecCommand(runtime, "status", [id]);
			}
			if (!latest.ok) throw new Error(latest.error.message);
			const status = await runExecCommand(runtime, "status", [id]);
			expect(status.ok && status.value).toMatchObject({ shell: "rig", args: ["status"], state: "ended", end: { kind: "exit", code: 0 } });
			// The detached runner wrote its exit under the temporary home, the home the test set, not the real one.
			expect(existsSync(runtime.resolvePath(home, ".agent-rig", "exec", id, "exit.json"))).toBe(true);
			const direct = await readStatus(runtime);
			if (!direct.ok || !status.ok || typeof status.value !== "object" || status.value === null || Array.isArray(status.value)) throw new Error("Status unavailable");
			expect(Object.keys(status.value.result ?? {}).sort()).toEqual(Object.keys(direct.value).sort());
		}
	});
}, TEST_BOUND_MS);
