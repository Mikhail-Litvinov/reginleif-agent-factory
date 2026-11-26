// The commands of the operator docs are pasted into Windows PowerShell as they stand. An angle-bracket placeholder
// outside a quoted string is parsed by PowerShell as a redirection, so the command does something else (or fails). A
// placeholder is written once into a variable, as a single-quoted string, and the commands use the variable.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { disposeScratch, makeScratch } from "./scratch.ts";

const DOCS = ["deployment.md", "recovery.md", "database.md"];
const docUrl = (name: string): URL => new URL(`../../docs/agent-factory/${name}`, import.meta.url);

// Code that is meant to be typed: inline spans that start like a command, an option or a variable, and fenced lines.
const COMMAND_START = /^(\$|node\s|npm\s|docker\s|powershell|pwsh|--)/;

const commandsOf = (text: string): { line: number; code: string }[] => {
	const found: { line: number; code: string }[] = [];
	let fenced = false;
	text.split(/\r?\n/).forEach((line, index) => {
		if (/^\s*```/.test(line)) {
			fenced = !fenced;
			return;
		}
		if (fenced) {
			found.push({ line: index + 1, code: line });
			return;
		}
		for (const span of line.matchAll(/`([^`\n]+)`/g)) {
			if (COMMAND_START.test(span[1] ?? "")) found.push({ line: index + 1, code: span[1] ?? "" });
		}
	});
	return found;
};

// What PowerShell would parse: the single-quoted strings are text, everything else is syntax.
const outsideQuotes = (code: string): string => code.replace(/'(?:[^']|'')*'/g, "''");

describe("docs: commands", () => {
	for (const name of DOCS) {
		it(`${name} holds no angle-bracket placeholder outside a quoted string in a command`, () => {
			const text = readFileSync(docUrl(name), "utf8");
			const bad = commandsOf(text)
				.filter(({ code }) => /<[^<>\n]+>/.test(outsideQuotes(code)))
				.map(({ line, code }) => `${name}:${line}: ${code}`);
			assert.deepEqual(bad, []);
		});
	}

	// The volume copy of recovery.md is run as the doc writes it (the script text and the image are read from the doc; the
	// volume is replaced by a scratch directory): a second run into the same name must fail and leave the first file as
	// it was, and the doc must not name a fixed file.
	it("recovery.md: the volume copy writes a new file and refuses a name that exists", async () => {
		const text = readFileSync(docUrl("recovery.md"), "utf8");
		assert.doesNotMatch(text, /pgdata\.tgz/, "a fixed file name would be overwritten by the next copy");
		const run = commandsOf(text).find(({ code }) => /^docker run .*\bsh -c '/.test(code));
		assert.ok(run, "the doc has a copy command that runs a shell script in the container");
		const script = /\bsh -c '([^']+)'/.exec(run.code)?.[1] ?? "";
		const image = /\s(alpine)\s+sh -c/.exec(run.code)?.[1] ?? "";
		assert.notEqual(image, "");
		const scratch = await makeScratch("af-copydoc-");
		try {
			const source = join(scratch.path, "src");
			const out = join(scratch.path, "out");
			mkdirSync(source);
			mkdirSync(out);
			writeFileSync(join(source, "PG_VERSION"), "16\n");
			const copy = (): ReturnType<typeof spawnSync> =>
				spawnSync("docker", ["run", "--rm", "-e", "NAME=copy.tgz", "-v", `${source}:/d:ro`, "-v", `${out}:/o`, image, "sh", "-c", script], { encoding: "utf8" });
			const first = copy();
			assert.equal(first.status, 0, String(first.stderr));
			const before = readFileSync(join(out, "copy.tgz"));
			assert.ok(before.length > 0);
			const second = copy();
			assert.notEqual(second.status, 0, "the second copy into the same name must be refused");
			assert.deepEqual(readFileSync(join(out, "copy.tgz")), before);
		} finally {
			await disposeScratch(scratch);
		}
	});

	it("the check itself sees a bare placeholder and ignores a quoted one", () => {
		assert.equal(commandsOf("`node a.ts --project <project>`").length, 1);
		assert.match(outsideQuotes("node a.ts --project <project>"), /<project>/);
		assert.doesNotMatch(outsideQuotes("$x = '<project>'"), /</);
	});
});
