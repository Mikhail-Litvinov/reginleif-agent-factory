// The real global setup and teardown (global-setup.ts) sweep the stacks that dead test processes left: one that an earlier
// run left (setup), and one that a test file's process left during this run (teardown). Both are run for real, as a nested
// `node --test` with the global setup, on a helper test file (global-sweep-fixture.ts).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { OwnedDir } from "../deploy/owned.ts";
import { removeOwned } from "../deploy/lib.ts";
import { Cleanups, leftovers } from "./helpers.ts";
import { disposeScratch, makeScratch } from "./scratch.ts";

const here = (name: string): string => fileURLToPath(new URL(`./${name}`, import.meta.url));
const exists = (path: string): Promise<boolean> =>
	access(path).then(
		() => true,
		() => false,
	);

interface Made {
	runId: string;
	secretsDir: string;
	token: string;
}

describe("global setup and teardown", () => {
	const cleanups = new Cleanups();
	after(() => cleanups.runAll());

	// Safety net for a failing test: only what the child processes made, by run id and by the recorded identity.
	const guard = (made: Made): void => {
		cleanups.add(() => removeOwned(made.runId));
		cleanups.add(async () => {
			const dir = await OwnedDir.reclaim(made.secretsDir, made.token);
			await dir?.adoptChildren();
			await dir?.remove();
		});
	};

	it("setup removes the stack an earlier dead process left, and teardown the one a test file's process left", async () => {
		// The children are not test files of this run: the variable is removed (an empty value still makes `--test` refuse to run).
		const { NODE_TEST_CONTEXT: _outer, ...noContext } = process.env;
		const exec = promisify(execFile);
		const out = await makeScratch("af-test-sweep-");
		cleanups.add(() => disposeScratch(out));
		const { stdout } = await exec(process.execPath, [here("dead-owner-child.ts")], { env: noContext });
		const earlier = JSON.parse(stdout) as Made;
		guard(earlier);
		assert.ok((await leftovers(earlier.runId)).length >= 3, "the earlier process left a stack");

		const reportPath = join(out.path, "made.json");
		await exec(process.execPath, ["--test", `--test-global-setup=${here("global-setup.ts")}`, here("global-sweep-fixture.ts")], {
			env: { ...noContext, AF_FIXTURE_PRE_RUN: earlier.runId, AF_FIXTURE_OUT: reportPath },
		});
		const during = JSON.parse(await readFile(reportPath, "utf8")) as Made;
		guard(during);

		assert.deepEqual(await leftovers(earlier.runId), [], "swept by the setup (the helper file also checked it before it ran)");
		assert.equal(await exists(earlier.secretsDir), false);
		assert.deepEqual(await leftovers(during.runId), [], "swept by the teardown");
		assert.equal(await exists(during.secretsDir), false);
	});
});
