// Removal guard: a run removes only what it created, judged by an identity it recorded at creation, never by a name, a
// name pattern, a project, or a flag that cascades to objects the run did not select. This test fails when any file of the
// package (code, tests, tools) removes something in a way that skips that rule:
//   - docker: only removeOwned (by the run label) and removeRecordedVolumes (by a recorded, re-verified name) in
//     deploy/lib.ts may remove containers, networks, volumes or images; nothing else in the package may.
//   - files: a recursive delete is forbidden everywhere; a bare unlink only in deploy/owned.ts (identity re-read first) and
//     deploy/setup-secrets.ts (identity of the file it created re-read first).
// The check reads the whole text of each file, not line by line, so a removal split over several lines, a line continuation,
// a multiline template string or an argument list spread over lines is seen. Its patterns are built from parts so that this
// file does not match itself (it is excluded as well).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, it } from "node:test";

const PACKAGE_ROOT = decodeURIComponent(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const LIB = "deploy/lib.ts";
const OWNED = "deploy/owned.ts";
const SETUP_SECRETS = "deploy/setup-secrets.ts";
const ENTRYPOINT = "deploy/postgres/entrypoint.sh";
const SELF = "tests/removal-guard.test.ts";

// The only functions of deploy/lib.ts that may remove docker resources: from the declaration to the first closing "};".
const LIB_REMOVERS = ["removeOwned", "removeRecordedVolumes"];
// The one recursive delete of a shell script: the entrypoint's own private mktemp directory in the container's tmpfs.
const ENTRYPOINT_OWN = 'rm -rf -- "$init_dir"';

// Whitespace between the words of a shell command, a backslash continuation included.
const SP = String.raw`(?:\s|\\\r?\n)+`;
const DOCKER_WORDS = ["down", "rm", "rmi", "prune", "--remove-orphans", "--volumes", "--force"].map((w) => `["'\`]${w}["'\`]`);
const DOCKER_TEXT = [
	String.raw`\bdocker${SP}(?:(?:container|volume|network|image|system|builder)${SP})?(?:rm|rmi|prune)\b`,
	String.raw`\bcompose\b(?:[^\n\\]|\\\r?\n)*?${SP}down\b`,
	"--remove-orphans",
];
const DOCKER = new RegExp([...DOCKER_WORDS, ...DOCKER_TEXT].join("|"), "gi");
const SHELL_RECURSIVE = new RegExp(String.raw`\brm${SP}(?:-[a-zA-Z]*[rR][a-zA-Z]*\b|--recursive\b)`, "g");
const FS_CALL = /\b(?:rm|rmSync|rmdir|rmdirSync)\s*\(/g;
const UNLINK = /\b(?:unlink|unlinkSync)\s*\(/g;

const sources = (): string[] =>
	readdirSync(PACKAGE_ROOT, { recursive: true, encoding: "utf8" })
		.map((entry) => entry.split(sep).join("/"))
		.filter((entry) => /\.(ts|mts|js|mjs|cjs|sh|ps1|yml|yaml|json)$/.test(entry) && !entry.startsWith("node_modules/") && !entry.includes("/node_modules/"))
		.filter((entry) => entry !== SELF);

// `text` with the span [from, to) blanked out, newlines kept so that line numbers stay.
const blank = (text: string, from: number, to: number): string => text.slice(0, from) + text.slice(from, to).replace(/[^\n]/g, " ") + text.slice(to);

// The text of deploy/lib.ts without the bodies of the functions that may remove.
const withoutLibRemovers = (text: string): string => {
	let out = text;
	for (const name of LIB_REMOVERS) {
		const start = out.indexOf(`export const ${name} = `);
		if (start < 0) continue;
		const close = out.indexOf("\n};", start);
		out = blank(out, start, close < 0 ? out.length : close + 3);
	}
	return out;
};

// The argument text of the call whose "(" is at `open`: up to the matching ")" (to the end of the text when it never closes,
// which makes an unbalanced file loud rather than silent).
const callText = (text: string, open: number): string => {
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === "(") depth++;
		else if (text[i] === ")" && --depth === 0) return text.slice(open, i + 1);
	}
	return text.slice(open);
};

// The removal sites of a text, as "file:line: text". `file` is the path relative to the package root.
export const removalSites = (file: string, text: string): string[] => {
	let body = file === LIB ? withoutLibRemovers(text) : text;
	if (file === ENTRYPOINT) body = body.split(ENTRYPOINT_OWN).join(" ".repeat(ENTRYPOINT_OWN.length));
	const found = new Map<number, string>();
	const note = (index: number): void => {
		const line = body.slice(0, index).split("\n").length;
		if (!found.has(line)) found.set(line, `${file}:${line}: ${(body.split("\n")[line - 1] ?? "").trim()}`);
	};
	for (const match of body.matchAll(DOCKER)) note(match.index);
	if (file !== OWNED) {
		for (const match of body.matchAll(SHELL_RECURSIVE)) note(match.index);
		for (const match of body.matchAll(FS_CALL)) {
			if (/\brecursive\b/.test(callText(body, match.index + match[0].length - 1))) note(match.index);
		}
	}
	if (file !== OWNED && file !== SETUP_SECRETS) for (const match of body.matchAll(UNLINK)) note(match.index);
	return [...found.entries()].sort((a, b) => a[0] - b[0]).map(([, site]) => site);
};

describe("removal guard", () => {
	it("no file of the package removes anything outside the identity-checked places", () => {
		const sites = sources().flatMap((file) => removalSites(file, readFileSync(join(PACKAGE_ROOT, file), "utf8")));
		assert.deepEqual(sites, [], "docker: removeOwned / removeRecordedVolumes in deploy/lib.ts; files: OwnedFiles / OwnedDir in deploy/owned.ts");
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

	it("the guard reads the whole text: multiline strings, line continuations, array arguments over several lines, image removal", () => {
		const forms = [
			"const c = `docker volume\n\t\trm some_volume`;",
			"const c = `docker \\\n  rm -f x`;",
			"const c = `docker compose -p x \\\n  down`;",
			"const c = `docker\n  compose -p x\n  down`;",
			"docker rmi some_image",
			"docker image rm some_image",
			'run("docker", ["rmi", image])',
			'run("docker", [\n\t"container",\n\t"rm",\n\tid,\n])',
			'run("docker", ["compose",\n "-p", p,\n "down"])',
		];
		for (const form of forms) assert.equal(removalSites("x.ts", form).length, 1, JSON.stringify(form));
	});

	it("the guard catches a recursive file-system delete in every spelling, and leaves creation and reading alone", () => {
		const forms = [
			"await rm(work, { recursive: true, force: true });",
			"await fs.rm(work, { force: true, recursive: true });",
			"rmSync(dir, { recursive: true });",
			"await rmdir(dir, { recursive: true });",
			"await rm(\n\tjoin(dir, x),\n\t{\n\t\trecursive: true,\n\t},\n);",
			"const c = `rm -rf \"$dir\"`;",
			"run('sh', ['-c', 'rm -fr /x'])",
		];
		for (const form of forms) assert.equal(removalSites("tests/x.ts", form).length, 1, JSON.stringify(form));
		for (const fine of [
			"await mkdir(dir, { recursive: true });",
			"readdirSync(root, { recursive: true, encoding: 'utf8' })",
			"trap 'rm -f \"$f\"' EXIT",
			"await rm(path);",
		]) assert.deepEqual(removalSites("tests/x.ts", fine), [], fine);
	});

	it("a bare unlink is allowed only where the identity of the file is checked first", () => {
		assert.equal(removalSites("tests/x.ts", "await unlink(path);").length, 1);
		assert.equal(removalSites("deploy/x.ts", "unlinkSync(file);").length, 1);
		assert.deepEqual(removalSites("deploy/owned.ts", "await unlink(path);"), []);
		assert.deepEqual(removalSites("deploy/setup-secrets.ts", "unlinkSync(file);"), []);
	});

	it("deploy/lib.ts may remove only inside removeOwned and removeRecordedVolumes", () => {
		const body = 'export const removeOwned = async () => {\n\tawait run("docker", ["rm", "-f", id]);\n\tawait run("docker", ["volume", "rm", v]);\n};\n';
		const volumes = 'export const removeRecordedVolumes = async () => {\n\tawait run("docker", ["volume", "rm", name]);\n};\n';
		assert.deepEqual(removalSites(LIB, body + volumes), []);
		const stray = 'export const sweep = async () => {\n\tawait run("docker", ["rmi", image]);\n};\n';
		assert.equal(removalSites(LIB, body + stray + volumes).length, 1);
		assert.equal(removalSites(LIB, stray + body).length, 1);
		// A removal right after the exempt body is outside it.
		assert.equal(removalSites(LIB, body + 'await run("docker", ["network", "rm", n]);\n').length, 1);
		// Another file gets no such allowance, whatever it names its functions.
		assert.equal(removalSites("tests/helpers.ts", body).length, 2);
	});

	it("the one shell script that removes a directory recursively is the entrypoint's own mktemp directory in the container", () => {
		const own = 'init_dir=$(mktemp -d /dev/shm/af-init.XXXXXX)\n\t[ -s "$secret" ] || { rm -rf -- "$init_dir"; exit 1; }\n';
		assert.deepEqual(removalSites("deploy/postgres/entrypoint.sh", own), []);
		assert.equal(removalSites("deploy/postgres/entrypoint.sh", 'rm -rf -- "$HOME"').length, 1);
		assert.equal(removalSites("deploy/other.sh", own).length, 1);
	});

	it("deploy/lib.ts is where docker removal lives: it removes by the run label, and the exempt bodies exist", () => {
		const lib = readFileSync(join(PACKAGE_ROOT, LIB), "utf8");
		assert.match(lib, /label=\$\{RUN_LABEL\}=\$\{runId\}/);
		// If a declaration were renamed the exemption would go vacuous: the guard would then flag it, or never see it.
		for (const name of LIB_REMOVERS) assert.ok(lib.includes(`export const ${name} = `), `deploy/lib.ts must declare ${name}`);
		assert.ok(removalSites(LIB, lib).length === 0, "the real lib.ts has removals outside its exempt bodies");
	});
});
