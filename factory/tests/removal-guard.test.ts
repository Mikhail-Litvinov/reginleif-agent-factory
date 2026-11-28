// Removal guard: a run removes only what it created, judged by an identity it recorded at creation, never by a name, a
// name pattern, a project, or a flag that cascades to objects the run did not select. This test fails when any file of the
// package (code, tests, tools) removes something in a way that skips that rule:
//   - docker: only removeOwned (by the run label) and removeRecordedVolumes (by a recorded, re-verified name) in
//     deploy/lib.ts may remove containers, networks, volumes or images; nothing else in the package may.
//   - files: every file-system delete (rm, rmSync, rmdir, rmdirSync, unlink, unlinkSync, through fs, fs.promises, fsp, a
//     destructured or renamed import, a string key, any spelling over several lines) is forbidden, recursive or not, except
//     in deploy/owned.ts (identity re-read before each) and the unlink of deploy/setup-secrets.ts (identity of the file it
//     created re-read first). Tests clean up through OwnedDir (deploy/owned.ts), never by a delete of their own.
//   - shell and PowerShell text: any `rm`, `rmdir`, `unlink`, `del`, `erase`, `ri`, `rd` command (recursive or not, in a
//     script, a string or a template) and any `Remove-Item` is forbidden, except the fragments listed in SHELL_ALLOWED: each
//     is one exact piece of text of one file (a script's own private temp file, a test's own entry in its own container),
//     and a test checks that the listed piece still exists, so a stale entry cannot linger.
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
const SELF = "tests/removal-guard.test.ts";

// The only functions of deploy/lib.ts that may remove docker resources: from the declaration to the first closing "};".
const LIB_REMOVERS = ["removeOwned", "removeRecordedVolumes"];
// The shell removals that exist, by file, each an exact piece of that file's text (blanked before the shell rule looks). Each
// removes only what its own script or test made: a private temp file or directory, or an entry in the test's own container.
const SHELL_ALLOWED: Record<string, string[]> = {
	"deploy/lib.ts": [`trap 'rm -f "$f"' EXIT`], // the passfile script deletes its own mktemp file
	"tests/roles.test.ts": [`trap 'rm -f "$f"' EXIT`],
	"deploy/postgres/entrypoint.sh": ['rm -f -- "$health_passfile.new"', 'rm -rf -- "$init_dir"'], // its own files in the container's tmpfs
	"deploy/postgres/init/lib/bootstrap.sh": ['rm -f "$passfile"'],
	"deploy/temporal/server-entrypoint.sh": ['rm -f "$config.new"'], // its own half-written config in the container's tmpfs
	"deploy/temporal/setup-schema.sh": ['rm -f "$handover"'], // the password handover file in the container's tmpfs
	"deploy/postgres/init/99-finish.sh": ['rm -f -- "$PGSERVICEFILE"'],
	"tests/verify-init.test.ts": ['rm -f -- "\\$PGSERVICEFILE"'], // a regex that checks 99-finish.sh still contains the line above
	"tests/interrupted-init.test.ts": [
		'rm -f "$AF_INIT_DIR"/* && rmdir "$AF_INIT_DIR"',
		'rm -f ${own.join(" ")} && for d in ${dirs.join(" ")}; do if [ -d "$d" ]; then rmdir "$d" || exit 1; fi; done && cd / && rmdir ${dir}',
		"rmdir fails (loudly) on a directory", // a comment
	],
};

// Whitespace between the words of a shell command, a backslash continuation included.
const SP = String.raw`(?:\s|\\\r?\n)+`;
const DOCKER_WORDS = ["down", "rm", "rmi", "remove", "prune", "--remove-orphans", "--volumes", "--force"].map((w) => `["'\`]${w}["'\`]`);
const DOCKER_TEXT = [
	String.raw`\bdocker${SP}(?:(?:container|volume|network|image|system|builder|compose)${SP})?(?:rm|rmi|remove|prune)\b`,
	String.raw`\bcompose\b(?:[^\n\\]|\\\r?\n)*?${SP}down\b`,
	"--remove-orphans",
];
const DOCKER = new RegExp([...DOCKER_WORDS, ...DOCKER_TEXT].join("|"), "gi");
// A shell or PowerShell command that deletes: a remover word where a command word stands (not part of a name, a path, a
// `--rm` flag or a member access) followed by an argument, or Remove-Item anywhere.
const SHELL_REMOVERS = ["rm", "rmdir", "unlink", "del", "erase", "ri", "rd"];
const SHELL_REMOVE = new RegExp(String.raw`(?<![\w$.-])(?:${SHELL_REMOVERS.join("|")})${SP}(?=[-"'$/.\\\w%~])|\bRemove-Item\b`, "gi");
// Every file-system call that removes something, whatever its options: the recursive flag is not what makes it unsafe, an
// unchecked name is.
const FS_REMOVERS = ["rm", "rmSync", "rmdir", "rmdirSync", "unlink", "unlinkSync"];
// Which of them a file may use: deploy/owned.ts all (identity re-read before each), deploy/setup-secrets.ts only its unlink
// of the empty file it created (identity re-read first); every other file none.
const fsAllowed = (file: string): string[] => (file === OWNED ? FS_REMOVERS : file === SETUP_SECRETS ? ["unlink", "unlinkSync"] : []);

// The patterns that find a use of the given remover names, in any spelling that has to name one:
//  - a call, bare or as a member (`rm(`, `fs.rm(`, `fs.promises.rm(`, `fsp.rm(`, a name split from its "(" by whitespace);
//  - a member access without a call (`fs.rm`, `fs?.promises?.rm`), or one by a string key (`fs["rm"]`);
//  - a binding: a name imported from node:fs or node:fs/promises (renamed with `as` included, re-export included), or
//    destructured from anything (`const { rm: remove } = fs.promises`). The binding itself is the finding, so a rename
//    cannot hide the later calls of the alias.
const fsRemovalPatterns = (names: string[]): RegExp[] => {
	if (names.length === 0) return [];
	const any = names.join("|");
	return [
		new RegExp(String.raw`(?<![\w$])(?:${any})\s*\(`, "g"),
		new RegExp(String.raw`\.\s*(?:${any})\b`, "g"),
		new RegExp(String.raw`\[\s*["'\`](?:${any})["'\`]\s*\]`, "g"),
		new RegExp(String.raw`\b(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{[^}]*\b(?:${any})\b[^}]*\}\s*from\s*["'](?:node:)?fs(?:/promises)?["']`, "g"),
		new RegExp(String.raw`\b(?:const|let|var)\s*\{[\s\S]*?\b(?:${any})\b[\s\S]*?\}\s*=`, "g"),
	];
};

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

// The removal sites of a text, as "file:line: text". `file` is the path relative to the package root.
export const removalSites = (file: string, text: string): string[] => {
	let body = file === LIB ? withoutLibRemovers(text) : text;
	for (const piece of SHELL_ALLOWED[file] ?? []) body = body.split(piece).join(" ".repeat(piece.length));
	const found = new Map<number, string>();
	const note = (index: number): void => {
		const line = body.slice(0, index).split("\n").length;
		if (!found.has(line)) found.set(line, `${file}:${line}: ${(body.split("\n")[line - 1] ?? "").trim()}`);
	};
	for (const match of body.matchAll(DOCKER)) note(match.index);
	if (file !== OWNED) for (const match of body.matchAll(SHELL_REMOVE)) note(match.index);
	for (const pattern of fsRemovalPatterns(FS_REMOVERS.filter((name) => !fsAllowed(file).includes(name)))) {
		for (const match of body.matchAll(pattern)) note(match.index);
	}
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
		// A form may be seen twice, as a docker removal and as a shell `rm` on another line of it.
		for (const form of forms) assert.equal(removalSites("x.ts", form).length >= 1, true, JSON.stringify(form));
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
			"docker run --rm -d alpine",
			"await rename(path, `${path}.moved`);",
			"const names = await readdir(dir); // a comment about remove, rmdir, rm.",
		]) assert.deepEqual(removalSites("tests/x.ts", fine), [], fine);
	});

	it("the guard catches a delete that is not recursive, in every spelling", () => {
		const forms = [
			"await rm(path);",
			"await rm(path, { force: true });",
			"rmSync(path);",
			"await rmdir(path);",
			"rmdirSync(path);",
			"await unlink(path);",
			"unlinkSync(file);",
			"await fs.rm(path);",
			"await fs.promises.rm(path);",
			"await fsp.rm(path);",
			"await fs.promises.unlink(path);",
			"fs.rmSync(path)",
			"fs.unlinkSync(path)",
			"await fs.promises\n\t.rm(path);",
			"await rm\n\t(\n\t\tpath,\n\t);",
			'await fs["rm"](path);',
			"await fs?.promises?.rm?.(path);",
			'const f = require("node:fs").rmSync;',
			'await (await import("node:fs/promises")).rm(path);',
			"const remove = fs.promises.rm;",
			"await promisify(fs.unlink)(path);",
		];
		for (const form of forms) assert.equal(removalSites("tests/x.ts", form).length >= 1, true, JSON.stringify(form));
	});

	it("the guard catches a delete under another name: renamed on import, destructured, aliased", () => {
		const forms = [
			'import { rm as remove } from "node:fs/promises";\nawait remove(path);',
			'import { rmSync as gone } from "node:fs";',
			'import { readFile, unlink as drop } from "node:fs/promises";',
			'import {\n\trm as cleanup,\n\treadFile,\n} from "node:fs/promises";',
			'import { rm } from "fs/promises";',
			'import type { rm } from "node:fs/promises";',
			'const { rm: remove } = fs.promises;\nawait remove(p);',
			'const { rmSync } = require("node:fs");',
			'const { promises: { rm } } = fs;',
			'const { rm: remove } = await import("node:fs/promises");',
			'let { unlinkSync: kill } = fs;',
		];
		for (const form of forms) assert.equal(removalSites("tests/x.ts", form).length >= 1, true, JSON.stringify(form));
		// Naming nothing destructive is fine, whatever the alias.
		for (const fine of [
			'import { readFile as read, rename } from "node:fs/promises";',
			'const { readFile: read } = fs.promises;',
			'import { rmdirSyncLike } from "./other.ts";',
		]) assert.deepEqual(removalSites("tests/x.ts", fine), [], fine);
	});

	it("the exemptions are by file and by name: owned.ts everything, setup-secrets.ts only its unlink", () => {
		assert.deepEqual(removalSites("deploy/owned.ts", 'import { rmdir, unlink } from "node:fs/promises";\nawait unlink(path);\nawait rmdir(path);'), []);
		assert.deepEqual(removalSites("deploy/setup-secrets.ts", 'import { unlinkSync } from "node:fs";\nunlinkSync(file);'), []);
		assert.equal(removalSites("deploy/setup-secrets.ts", "rmSync(dir);").length, 1);
		assert.equal(removalSites("deploy/setup-secrets.ts", "rmdirSync(dir);").length, 1);
		assert.equal(removalSites("deploy/setup-secrets.ts", 'import { rm as gone } from "node:fs/promises";').length, 1);
		assert.equal(removalSites("tests/x.ts", "await unlink(path);").length, 1);
		assert.equal(removalSites("deploy/x.ts", "unlinkSync(file);").length, 1);
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

	it("the guard catches the docker `remove` spellings", () => {
		const forms = [
			"docker volume remove some_volume",
			"docker container remove c",
			"docker network remove n",
			"docker image remove i",
			"docker compose rm -f",
			'run("docker", ["volume", "remove", name])',
			'run("docker", ["container", "remove", "-f", id])',
			"const c = `docker \\\n  volume \\\n  remove x`;",
		];
		for (const form of forms) assert.equal(removalSites("tests/x.ts", form).length, 1, JSON.stringify(form));
	});

	it("the guard catches a shell or PowerShell delete in a script, a string or a template, recursive or not", () => {
		const forms = [
			"rm file.txt",
			'rm -f "$x"',
			"rm -- /x",
			"cleanup() { rm $tmp; }",
			"rmdir /x",
			"unlink /x/y",
			"run('sh', ['-c', 'rm /tmp/x'])",
			"sh(`cd ${dir} && rm ${name}`)",
			"sh(`cd ${dir} \\\n  && rm \\\n  ${name}`)",
			"powershell -Command 'Remove-Item -Recurse -Force C:\\x'",
			"Remove-Item $path",
			"remove-item -Path x",
			"ri -Force x",
			"del x.txt",
			"del /q x.txt",
			"erase x.txt",
			"rd /s /q x",
			"cmd /c del x",
			'run("powershell", ["-NoProfile", "-Command", "Remove-Item x"])',
			"if (Test-Path x) { ri x }",
		];
		for (const form of forms) assert.equal(removalSites("tests/x.ts", form).length >= 1, true, JSON.stringify(form));
		for (const fine of [
			"docker run --rm alpine",
			"const names = ['--rm', 'remove-orphans'];",
			"fs.rm_helper(x)",
			"const form = rm;",
			"the rmdirs are listed above",
			"const trim = 1; const norm = 2;",
			"printf 'delete %s' x",
		]) assert.deepEqual(removalSites("tests/x.ts", fine), [], fine);
	});

	it("each listed shell removal is exempt in its own file only, and still exists there", () => {
		for (const [file, pieces] of Object.entries(SHELL_ALLOWED)) {
			const text = readFileSync(join(PACKAGE_ROOT, file), "utf8");
			for (const piece of pieces) {
				assert.ok(text.includes(piece), `${file} no longer contains the listed piece ${JSON.stringify(piece)}: drop it from SHELL_ALLOWED`);
				assert.deepEqual(removalSites(file, piece), [], `${file}: ${piece}`);
				assert.equal(removalSites("deploy/other.sh", piece).length >= 1, true, `the piece must not be exempt elsewhere: ${piece}`);
				assert.equal(removalSites(file, `${piece}\nrm -rf "$HOME"`).length, 1, `${file}: only the exact piece is exempt`);
			}
		}
	});

	it("deploy/lib.ts is where docker removal lives: it removes by the run label, and the exempt bodies exist", () => {
		const lib = readFileSync(join(PACKAGE_ROOT, LIB), "utf8");
		assert.match(lib, /label=\$\{RUN_LABEL\}=\$\{runId\}/);
		// If a declaration were renamed the exemption would go vacuous: the guard would then flag it, or never see it.
		for (const name of LIB_REMOVERS) assert.ok(lib.includes(`export const ${name} = `), `deploy/lib.ts must declare ${name}`);
		assert.ok(removalSites(LIB, lib).length === 0, "the real lib.ts has removals outside its exempt bodies");
	});
});
