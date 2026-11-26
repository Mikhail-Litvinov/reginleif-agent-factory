// Removal guard: a cleanup removes only what carries this run's own label, never by project name or name pattern. The one
// place that removes docker resources is deploy/lib.ts (removeOwned); this test fails when any other file of the package
// (code, tests, tools) issues a docker removal itself.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, it } from "node:test";

const PACKAGE_ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const LIB = "deploy/lib.ts";
const SELF = "tests/removal-guard.test.ts";

// Every way this package could call docker to remove something, as an argument (a quoted word of an argument list) or as
// shell text. Built from parts so that this file does not match itself (it is excluded as well).
const WORDS = ["down", "rm", "prune", "--remove-orphans", "--volumes", "--force"].map((w) => `["'\`]${w}["'\`]`);
const SHELL = ["docker (container |volume |network |image |system )?(rm|prune)", "compose[^\\n]* down", "--remove-orphans"];
const FORBIDDEN = new RegExp([...WORDS, ...SHELL].join("|"), "i");

const sources = (): string[] =>
	readdirSync(PACKAGE_ROOT, { recursive: true, encoding: "utf8" })
		.map((entry) => entry.split(sep).join("/"))
		.filter((entry) => /\.(ts|sh|yml|json)$/.test(entry) && !entry.startsWith("node_modules/") && !entry.includes("/node_modules/"))
		.filter((entry) => entry !== LIB && entry !== SELF);

// The lines of a text that issue a removal, as "file:line: text".
export const removalSites = (file: string, text: string): string[] =>
	text.split(/\r?\n/).flatMap((line, index) => (FORBIDDEN.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : []));

describe("removal guard", () => {
	it("no file of the package removes docker resources outside deploy/lib.ts", () => {
		const sites = sources().flatMap((file) => removalSites(file, readFileSync(join(PACKAGE_ROOT, relative(".", file)), "utf8")));
		assert.deepEqual(sites, [], "route every removal through removeOwned (by label af.run=<run id>) in deploy/lib.ts");
	});

	it("the guard recognizes the removal forms it exists to catch", () => {
		const forms = [
			'run("docker", ["compose", "-p", p, "down", "-v"])',
			'run("docker", ["rm", "-f", id])',
			'run("docker", ["volume", "rm", name])',
			'run("docker", ["network", "rm", name])',
			'run("docker", ["system", "prune", "-f"])',
			"docker compose -p x down --remove-orphans",
			"docker volume rm some_volume",
		];
		for (const form of forms) assert.equal(removalSites("x.ts", form).length, 1, form);
		assert.deepEqual(removalSites("x.ts", 'run("docker", ["ps", "-a", "-q"])'), []);
	});

	it("deploy/lib.ts is where removal lives: it removes by the run label", () => {
		const lib = readFileSync(join(PACKAGE_ROOT, LIB), "utf8");
		assert.match(lib, /label=\$\{RUN_LABEL\}=\$\{runId\}/);
	});
});
