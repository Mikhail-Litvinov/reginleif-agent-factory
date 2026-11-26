// The commands of the operator docs are pasted into Windows PowerShell as they stand. An angle-bracket placeholder
// outside a quoted string is parsed by PowerShell as a redirection, so the command does something else (or fails). A
// placeholder is written once into a variable, as a single-quoted string, and the commands use the variable.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

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

	it("the check itself sees a bare placeholder and ignores a quoted one", () => {
		assert.equal(commandsOf("`node a.ts --project <project>`").length, 1);
		assert.match(outsideQuotes("node a.ts --project <project>"), /<project>/);
		assert.doesNotMatch(outsideQuotes("$x = '<project>'"), /</);
	});
});
