import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ALLOWED = new Set(["commands/real-runtime.ts", "node-file-operations.ts", "assets/node-asset-file-system.ts", "commands/process-runner.ts"]);
const FORBIDDEN = /(?:from\s*|import\s*\()\s*["']node:(?:fs(?:\/promises)?|child_process|os)["']/;

test("host filesystem, process and OS imports stay in runtime adapters", async () => {
	const visit = async (directory: string, relative: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const name = relative === "" ? entry.name : `${relative}/${entry.name}`;
			if (entry.isDirectory()) await visit(join(directory, entry.name), name);
			else if (name.endsWith(".ts") && !ALLOWED.has(name)) expect(await readFile(join(directory, entry.name), "utf8"), name).not.toMatch(FORBIDDEN);
		}
	};
	await visit("src", "");
});
