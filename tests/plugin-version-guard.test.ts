import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkPlugin, computeHash, pluginDirs } from "../scripts/plugin-fingerprint";

test("every shipped plugin's version changes whenever its shipped content changes", async () => {
	const dirs = await pluginDirs("plugins");
	expect(dirs.length).toBeGreaterThan(0);
	for (const dir of dirs) expect(await checkPlugin(dir), dir).toBeUndefined();
});

test("the fingerprint ignores tests and line endings but sees module content and the version-less manifest", async () => {
	const dir = await mkdtemp(join(tmpdir(), "plugin-guard-"));
	try {
		await mkdir(join(dir, ".claude-plugin"));
		await writeFile(join(dir, ".claude-plugin", "plugin.json"), '{"name":"x","version":"1.0.0"}');
		await writeFile(join(dir, "mod.ts"), "a\nb\n");
		const base = await computeHash(dir);
		await writeFile(join(dir, "mod.test.ts"), "anything");
		await writeFile(join(dir, ".claude-plugin", "plugin.json"), '{"name":"x","version":"2.0.0"}');
		await writeFile(join(dir, "mod.ts"), "a\r\nb\r\n");
		expect(await computeHash(dir)).toBe(base);
		await writeFile(join(dir, "mod.ts"), "a\nc\n");
		expect(await computeHash(dir)).not.toBe(base);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
