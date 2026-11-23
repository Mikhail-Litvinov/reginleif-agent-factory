import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPOSITORY_ROOT = join(import.meta.dir, "..");
// Everything rig ships for Claude Code: base and feature files (agents, skills, rules, commands) and plugins.
const SHIPPED_PATTERNS = ["base/**/*.md", "features/**/*.md", "plugins/**/*.md"];
const LF = "\n";
const CRLF = "\r\n";
const FENCE = "---";
// Claude Code loads these as agents or skills, so each must carry front matter.
const FRONT_MATTER_REQUIRED = /(^|\/)agents\/[^/]+\.md$|(^|\/)SKILL\.md$/;
const REQUIRED_STRING_FIELDS = ["name", "description"];
// rig replaces these placeholders at install time (for example {{PYTHON}} and {{CLONE}}); the check puts a plain word in their place.
const PLACEHOLDER = /\{\{[A-Z_]+\}\}/g;
const PLACEHOLDER_STAND_IN = "placeholder";
// A line `key: value` at the top level of the front matter (an indented line is a nested value).
const TOP_LEVEL_KEY = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/;
// A value that starts with one of these is quoted, a block, a flow collection, or an anchor, alias, tag or directive:
// the parser checks it alone. Any other value is a plain scalar and must read back exactly as written.
const NON_PLAIN_START = /^[-?:,[\]{}#&*!|>'"%@`]/;

// The problems in one text (LF or CRLF) of a file's front matter; an empty list means it is strict YAML with the required fields.
const frontMatterProblems = (text: string, requiresFrontMatter: boolean): string[] => {
	const rawLines = text.split(LF);
	const lines = rawLines.map((line) => line.replace(/\r$/, ""));
	if (lines[0] !== FENCE) return requiresFrontMatter ? ["no front matter at the top of the file"] : [];
	const close = lines.indexOf(FENCE, 1);
	if (close < 0) return ["front matter is not closed by ---"];
	const yamlText = rawLines.slice(1, close).join(LF).replaceAll(PLACEHOLDER, PLACEHOLDER_STAND_IN);
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(yamlText);
	} catch (error) {
		return [`front matter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`];
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return ["front matter is not a mapping of keys"];
	const record = parsed as Record<string, unknown>;
	const problems: string[] = [];
	// Every top-level key as written, in order; the parser keeps only the last of a repeated key, so a repeat is a problem of its own.
	const writtenValues = new Map<string, string[]>();
	for (const line of lines.slice(1, close).map((entry) => entry.replaceAll(PLACEHOLDER, PLACEHOLDER_STAND_IN))) {
		const match = TOP_LEVEL_KEY.exec(line);
		if (match === null) continue;
		writtenValues.set(match[1], [...(writtenValues.get(match[1]) ?? []), (match[2] ?? "").trim()]);
	}
	for (const [key, values] of writtenValues) {
		if (values.length > 1) {
			problems.push(`key ${key} is repeated`);
			continue;
		}
		const written = values[0];
		if (written === "" || NON_PLAIN_START.test(written)) continue;
		if (String(record[key]) !== written) problems.push(`${key} is read as ${JSON.stringify(record[key])}, not as written: ${written}`);
	}
	for (const field of REQUIRED_STRING_FIELDS) {
		const value = record[field];
		if (typeof value !== "string" || value.trim() === "") problems.push(`${field} is missing or not a string`);
	}
	return problems;
};

const shippedFiles = async (): Promise<string[]> => {
	const found = new Set<string>();
	for (const pattern of SHIPPED_PATTERNS) {
		for await (const path of new Bun.Glob(pattern).scan({ cwd: REPOSITORY_ROOT, onlyFiles: true })) {
			found.add(path.replace(/\\/g, "/"));
		}
	}
	return [...found].sort();
};

describe("front matter of shipped Markdown files", () => {
	test("the check reads both line endings the same way: a colon-space value is rejected, quoted it is accepted", () => {
		const unquoted = "---\nname: x\ndescription: attach: <job> and more\n---\nBody\n";
		const quoted = "---\nname: x\ndescription: 'attach: <job> and more'\n---\nBody\n";
		for (const variant of [LF, CRLF]) {
			expect(frontMatterProblems(unquoted.split(LF).join(variant), false).length).toBeGreaterThan(0);
			expect(frontMatterProblems(quoted.split(LF).join(variant), false)).toEqual([]);
		}
	});

	test("the check rejects a repeated key, a value read back differently, and a missing description", () => {
		expect(frontMatterProblems("---\nname: x\nname: y\ndescription: d\n---\n", false)).toEqual(["key name is repeated"]);
		expect(frontMatterProblems("---\nname: x\ndescription: d # note\n---\n", false)).toEqual([
			'description is read as "d", not as written: d # note',
		]);
		expect(frontMatterProblems("---\nname: x\n---\n", false)).toEqual(["description is missing or not a string"]);
		expect(frontMatterProblems("Body only\n", true)).toEqual(["no front matter at the top of the file"]);
	});

	test("the scan finds the shipped agents and skills, so the check cannot pass on an empty scan", async () => {
		const files = await shippedFiles();
		expect(files.filter((path) => FRONT_MATTER_REQUIRED.test(path)).length).toBeGreaterThan(0);
	});

	test("every shipped file's front matter is strict YAML with string name and description, with LF and with CRLF line endings", async () => {
		const failures: string[] = [];
		for (const path of await shippedFiles()) {
			const lf = readFileSync(join(REPOSITORY_ROOT, path), "utf8").replace(/\r\n/g, LF);
			const required = FRONT_MATTER_REQUIRED.test(path);
			for (const [label, text] of [["LF", lf], ["CRLF", lf.split(LF).join(CRLF)]] as const) {
				for (const problem of frontMatterProblems(text, required)) failures.push(`${path} [${label}]: ${problem}`);
			}
		}
		expect(failures).toEqual([]);
	});
});
