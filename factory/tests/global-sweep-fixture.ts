// A helper test file for global-sweep.test.ts, run by `node --test` with the real global setup and teardown. By the time it
// runs, global setup has swept the stack that an earlier dead process left (AF_FIXTURE_PRE_RUN), which it checks; and it
// then makes a stack in a process that ends without cleanup (a killed test process), which only the teardown can remove. It
// reports that stack to the test that started it through the file AF_FIXTURE_OUT. It is not a test of its own.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { leftovers } from "./helpers.ts";

const need = (name: string): string => {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
};

it("global setup swept the earlier leftover; this file leaves a new one behind", async () => {
	assert.deepEqual(await leftovers(need("AF_FIXTURE_PRE_RUN")), []);
	const child = fileURLToPath(new URL("./dead-owner-child.ts", import.meta.url));
	const { stdout } = await promisify(execFile)(process.execPath, [child], { env: { ...process.env, NODE_TEST_CONTEXT: "" } });
	await writeFile(need("AF_FIXTURE_OUT"), stdout);
});
