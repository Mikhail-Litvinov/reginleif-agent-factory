// Creation guard: every docker object a test creates carries af.run and af.owner from the command that creates it, so a test
// process killed right after the creation leaves something the sweep of dead owners (dead-owners.ts) can find. The one place
// that creates objects outside a compose stack is tests/owned-docker.ts; compose stacks get their labels from
// deploy/compose.run.yml through stackArgs / ownedComposeArgs. This test fails when any other test file
//   - calls docker with a literal `create`, `run`, `volume create`, `network create` (also `container ...`) or a raw
//     `compose ... up|create|run`;
//   - passes docker an argument list whose first word is not a literal (a spread or a variable) unless it also names a
//     read-only word (inspect, ls, ps, --filter, ...): such a list could be a creation in disguise;
//   - passes docker anything other than an array literal or a call of stackArgs / ownedComposeArgs / withPassfile;
//   - writes such a command inside a shell string.
// The check reads the text of each file with the comments removed. There is no list of exceptions: any site fails the test.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const TESTS_DIR = decodeURIComponent(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const SELF = "owned-creation-guard.test.ts";
const HELPER = "owned-docker.ts";

// Test files that hold docker command lines only as text to be scanned, never run: the removal guard's fixtures and the
// mount-site parser's inputs. A file that also runs docker never belongs here.
const TEXT_ONLY = new Set(["removal-guard.test.ts", "mount-site.test.ts"]);

const SAFE_CALLS = /^(?:stackArgs|ownedComposeArgs|withPassfile)\s*\(/;
const READ_ONLY = new Set(["inspect", "ls", "ps", "port", "logs", "exec", "cp", "start", "stop", "kill", "wait", "update", "--filter", "config"]);
const CREATING = new Set(["create", "run"]);
const KINDS = new Set(["container", "volume", "network"]);
const COMPOSE_CREATING = new Set(["up", "create", "run"]);
const SHELL_CREATION = /\bdocker\s+(?:(?:container|volume|network)\s+)?(?:create|run)\b|\bdocker\s+compose\b[^\n]*\s(?:up|create|run)\b/;

const withoutComments = (text: string): string =>
	text
		.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
		.split("\n")
		.map((line) => line.replace(/(^|\s)\/\/.*$/, "$1")) // a comment to the end of the line (a "//" inside a URL has no space before it)
		.join("\n");

// The text of one expression starting at `from`: an array or call to its balanced end, anything else to the first comma or
// closing bracket at depth 0.
const expressionAt = (text: string, from: number): string => {
	let depth = 0;
	let quote = "";
	for (let i = from; i < text.length; i += 1) {
		const ch = text[i] as string;
		if (quote !== "") {
			if (ch === "\\") i += 1;
			else if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") quote = ch;
		else if (ch === "(" || ch === "[" || ch === "{") depth += 1;
		else if (ch === ")" || ch === "]" || ch === "}") {
			depth -= 1;
			if (depth === 0 && ch === "]") return text.slice(from, i + 1);
			if (depth < 0) return text.slice(from, i);
		} else if (ch === "," && depth === 0) return text.slice(from, i);
	}
	return text.slice(from);
};

// The top-level elements of an array literal's text, each trimmed.
const elementsOf = (array: string): string[] => {
	const inner = array.slice(1, -1);
	const out: string[] = [];
	let from = 0;
	while (from < inner.length) {
		const element = expressionAt(inner, from);
		out.push(element.trim());
		from += element.length + 1;
	}
	return out.filter((element) => element !== "");
};

const literal = (element: string | undefined): string | undefined => /^["'`]([^"'`$]*)["'`]$/.exec(element ?? "")?.[1];

const classify = (expression: string): string | undefined => {
	if (!expression.startsWith("[")) return SAFE_CALLS.test(expression) ? undefined : `docker arguments are neither an array nor stackArgs/ownedComposeArgs/withPassfile: ${expression.slice(0, 60)}`;
	const elements = elementsOf(expression);
	const words = elements.map(literal);
	const first = words[0];
	if (first === undefined) return words.some((word) => word !== undefined && READ_ONLY.has(word)) ? undefined : `docker arguments start with a non-literal and name no read-only word: ${expression.slice(0, 60)}`;
	if (CREATING.has(first)) return `raw docker ${first}`;
	if (KINDS.has(first) && words[1] !== undefined && CREATING.has(words[1])) return `raw docker ${first} ${words[1]}`;
	if (first === "compose" && words.some((word) => word !== undefined && COMPOSE_CREATING.has(word))) return "raw docker compose up/create/run";
	return undefined;
};

/** The creation sites of a file's text: "line: reason". */
export const creationSites = (text: string): string[] => {
	const body = withoutComments(text);
	const sites: string[] = [];
	const lineOf = (index: number): number => body.slice(0, index).split("\n").length;
	for (const match of body.matchAll(/["'`]docker["'`]\s*,\s*/g)) {
		const reason = classify(expressionAt(body, match.index + match[0].length).trim());
		if (reason !== undefined) sites.push(`${lineOf(match.index)}: ${reason}`);
	}
	for (const match of body.matchAll(new RegExp(SHELL_CREATION, "g"))) sites.push(`${lineOf(match.index)}: docker creation in a shell string`);
	return sites;
};

const testFiles = (): string[] =>
	readdirSync(TESTS_DIR, { encoding: "utf8" }).filter((name) => /\.(ts|mts)$/.test(name) && name !== SELF && name !== HELPER && !TEXT_ONLY.has(name));

describe("creation guard", () => {
	it("no test file creates a docker object outside tests/owned-docker.ts", () => {
		const problems: string[] = [];
		for (const file of testFiles()) {
			const sites = creationSites(readFileSync(join(TESTS_DIR, file), "utf8"));
			if (sites.length > 0) problems.push(`${file}: ${sites.length} creation site(s): ${sites.join("; ")}`);
		}
		assert.deepEqual(problems, [], "create objects through createContainer / runContainer / createVolume / createNetwork in tests/owned-docker.ts");
	});

	it("recognizes the creations it exists to catch", () => {
		const cases = [
			'await run("docker", ["run", "--rm", "alpine"]);',
			"await runChecked('docker', ['create', '--name', n, img]);",
			'await runChecked("docker", ["network", "create", "--label", `af.run=${id}`, name]);',
			'await runChecked("docker", ["volume", "create", name]);',
			'await runChecked("docker", ["container", "run", img]);',
			'await run("docker", ["compose", "-p", p, "up", "-d"]);',
			'await run("docker", [...args, name]);',
			'await run("docker", args);',
			'await run("docker",\n\t[\n\t\t"run",\n\t\t"-d",\n\t]);',
			'spawnSync("docker", ["run", "--rm", img]);',
			"await sh(`docker run --rm ${img}`);",
			"await sh(`docker volume create ${name}`);",
			"await sh(`docker compose -p x up -d`);",
		];
		for (const text of cases) assert.equal(creationSites(text).length, 1, text);
	});

	it("lets through what is not a creation", () => {
		const cases = [
			'await run("docker", ["inspect", name]);',
			'await run("docker", [kind, "inspect", name]);',
			'await run("docker", [...args, "--filter", "label=x", "--format", f]);',
			'await runChecked("docker", ["exec", "-u", "root", c, ...command]);',
			'await runChecked("docker", ["cp", a, b]);',
			'await run("docker", ["volume", "inspect", name]);',
			'await runChecked("docker", stackArgs(info, "up", "-d"), { env });',
			'await runChecked("docker", ownedComposeArgs(project, runId, "create"), { env });',
			'await run("docker", withPassfile(line, host));',
			'// await run("docker", ["run", img]);',
			'/* await run("docker", ["run", img]); */',
			'await run("docker", ["logs", name]); // a comment that says docker run',
		];
		for (const text of cases) assert.deepEqual(creationSites(text), [], text);
	});
});
