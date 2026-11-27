import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { controlDatabaseUrl, LoadSettings } from "../control/index.ts";

test("LoadSettings returns the stored settings snapshot", async () => {
	const settings = { snapshot: async (keys: readonly string[]) => Object.fromEntries(keys.map((key) => [key, key === "retry.max" ? 4 : null])) };
	assert.deepEqual(await LoadSettings(settings, ["retry.max", "missing"]), { "retry.max": 4, missing: null });
});

test("connection URL uses af_control and its secret file", async () => {
	const directory = await mkdtemp(join(tmpdir(), "af-control-"));
	try {
		await mkdir(directory, { recursive: true });
		await writeFile(join(directory, "af_control"), "secret-with_dash\n");
		assert.equal(await controlDatabaseUrl({ secretsDir: directory, port: 55432 }), "postgres://af_control:secret-with_dash@127.0.0.1:55432/agent_factory");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
