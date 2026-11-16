// Content fingerprint of every plugin under plugins/. Claude Code keys its plugin cache by the plugin.json version,
// so a plugin whose content changed without a version bump is never refreshed on installed machines.
// The fingerprint covers everything Claude Code copies (the whole plugin folder) except tests (*.test.ts, never
// loaded) and the content-hash file itself; the "version" field of plugin.json is left out so a bump alone does not
// change it. It is stored in plugins/<name>/.claude-plugin/content-hash together with the version it was recorded at.
// Usage: bun scripts/plugin-fingerprint.ts   (after bumping the version in plugin.json by hand; refuses without a bump)
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CONTENT_HASH_FILE = ".claude-plugin/content-hash";
const PLUGIN_JSON = ".claude-plugin/plugin.json";
const TEST_FILE_SUFFIX = ".test.ts";

export type Recorded = { version: string; hash: string };

const listFiles = async (root: string, relative: string): Promise<string[]> => {
	const found: string[] = [];
	for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
		const name = relative === "" ? entry.name : `${relative}/${entry.name}`;
		if (entry.isDirectory()) found.push(...(await listFiles(root, name)));
		else if (name !== CONTENT_HASH_FILE && !name.endsWith(TEST_FILE_SUFFIX)) found.push(name);
	}
	return found;
};

const parseObject = (text: string): Record<string, unknown> => {
	const value: unknown = JSON.parse(text);
	return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
};

export const readVersion = async (pluginDir: string): Promise<string> => {
	const version = parseObject(await readFile(join(pluginDir, PLUGIN_JSON), "utf8")).version;
	return typeof version === "string" ? version : "";
};

export const computeHash = async (pluginDir: string): Promise<string> => {
	const hash = createHash("sha256");
	for (const name of (await listFiles(pluginDir, "")).sort()) {
		let text = (await readFile(join(pluginDir, name), "utf8")).replace(/\r\n/g, "\n");
		if (name === PLUGIN_JSON) {
			const { version: _version, ...rest } = parseObject(text);
			text = JSON.stringify(rest);
		}
		hash.update(`${name}\0${text}\0`);
	}
	return hash.digest("hex");
};

export const readRecorded = async (pluginDir: string): Promise<Recorded | undefined> => {
	try {
		const object = parseObject(await readFile(join(pluginDir, CONTENT_HASH_FILE), "utf8"));
		return typeof object.version === "string" && typeof object.hash === "string" ? { version: object.version, hash: object.hash } : undefined;
	} catch {
		return undefined;
	}
};

export const pluginDirs = async (pluginsRoot: string): Promise<string[]> =>
	(await readdir(pluginsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => join(pluginsRoot, entry.name));

export const UPDATE_COMMAND = "bun scripts/plugin-fingerprint.ts";

// Returns a problem text, or undefined when the version and the recorded fingerprint match the content.
export const checkPlugin = async (pluginDir: string): Promise<string | undefined> => {
	const [version, hash, recorded] = [await readVersion(pluginDir), await computeHash(pluginDir), await readRecorded(pluginDir)];
	if (recorded === undefined) return `${pluginDir}: no ${CONTENT_HASH_FILE}; run ${UPDATE_COMMAND}`;
	if (hash !== recorded.hash && version === recorded.version) return `${pluginDir}: shipped content changed but the version is still ${version}; bump "version" in ${PLUGIN_JSON} and run ${UPDATE_COMMAND}`;
	if (hash !== recorded.hash || version !== recorded.version) return `${pluginDir}: the recorded fingerprint is stale; run ${UPDATE_COMMAND}`;
	return undefined;
};

if (import.meta.main) {
	let failed = false;
	for (const dir of await pluginDirs("plugins")) {
		const [version, hash, recorded] = [await readVersion(dir), await computeHash(dir), await readRecorded(dir)];
		if (recorded !== undefined && recorded.hash === hash && recorded.version === version) continue;
		if (recorded !== undefined && recorded.hash !== hash && recorded.version === version) {
			console.error(`${dir}: content changed but the version is still ${version}; bump "version" in ${PLUGIN_JSON} first`);
			failed = true;
			continue;
		}
		await writeFile(join(dir, CONTENT_HASH_FILE), `${JSON.stringify({ version, hash }, null, "\t")}\n`);
		console.log(`${dir}: recorded ${version} ${hash}`);
	}
	process.exit(failed ? 1 : 0);
}
