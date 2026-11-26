// The command line of every command in deploy/ goes through ONE strict parser (deploy/cli-args.ts): a wrong command line
// is a usage error, exit status 2 with the usage text, before the command does anything. The unit tests prove the parser;
// the table proves each command is wired to it (an unknown flag, a missing, empty or flag-like value, a repeated flag and a
// missing required flag in every command), so one command cannot keep a laxer parser of its own.
import assert from "node:assert/strict";
import { OwnedDir } from "../deploy/owned.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { UsageError, integerValue, parseCliArgs, type CliSpec } from "../deploy/cli-args.ts";
import { run } from "../deploy/lib.ts";

const SPEC: CliSpec = { flags: { "--name": "value", "--on": "boolean" }, required: ["--name"] };

describe("parseCliArgs", () => {
	it("reads value flags and boolean flags", () => {
		const parsed = parseCliArgs(["--on", "--name", "x"], SPEC);
		assert.equal(parsed.values["--name"], "x");
		assert.ok(parsed.present.has("--on"));
		assert.deepEqual(parsed.positionals, []);
	});

	const WRONG: Array<[string, string[], RegExp]> = [
		["an unknown flag", ["--name", "x", "--bogus"], /unknown argument: --bogus/],
		["a value flag as the last argument", ["--name"], /--name needs a value/],
		["an empty value", ["--name", ""], /--name needs a value/],
		["a blank value", ["--name", "  "], /--name needs a value/],
		["a flag as the value", ["--name", "--on"], /--name needs a value/],
		["a repeated value flag", ["--name", "a", "--name", "b"], /--name given more than once/],
		["a repeated boolean flag", ["--name", "a", "--on", "--on"], /--on given more than once/],
		["a missing required flag", ["--on"], /--name is required/],
		["an argument the command does not take", ["--name", "a", "stray"], /unknown argument: stray/],
		["an inherited object property used as a flag", ["--name", "a", "--constructor"], /unknown argument: --constructor/],
	];
	for (const [name, argv, message] of WRONG) {
		it(`refuses ${name}`, () => {
			assert.throws(
				() => parseCliArgs(argv, SPEC),
				(error: unknown) => error instanceof UsageError && message.test(error.message),
			);
		});
	}

	it("takes exactly the positional arguments the command declares", () => {
		const spec: CliSpec = { flags: { "--check": "boolean" }, positionals: 1 };
		assert.deepEqual(parseCliArgs(["--check", "dir"], spec).positionals, ["dir"]);
		assert.throws(() => parseCliArgs([], spec), /missing argument/);
		assert.throws(() => parseCliArgs(["a", "b"], spec), /unknown argument: b/);
		assert.throws(() => parseCliArgs([""], spec), /an argument is empty/);
	});

	it("integerValue accepts a whole number in range and refuses everything else", () => {
		assert.equal(integerValue("--port", "5432", 1, 65535), 5432);
		for (const text of ["abc", "1.5", "-1", "1e3", "0x10", " 5"]) assert.throws(() => integerValue("--port", text, 1, 65535), UsageError, text);
		assert.throws(() => integerValue("--port", "0", 1, 65535), /must be between 1 and 65535/);
		assert.throws(() => integerValue("--port", "65536", 1, 65535), /must be between 1 and 65535/);
	});
});

const cli = (relative: string): string => fileURLToPath(new URL(`../deploy/${relative}`, import.meta.url));

// Every command with its wrong command lines. No row can reach docker or write anything: the parser stops each one first,
// and the paths in the rows exist nowhere. Each row has a message that names the problem.
const TABLE: Array<{ command: string; script: string; usage: RegExp; wrong: Array<[string, string[], RegExp]> }> = [
	{
		command: "verify-init",
		script: "verify-init.ts",
		usage: /usage: node deploy\/verify-init\.ts/,
		wrong: [
			["an unknown flag", ["--bogus"], /unknown argument: --bogus/],
			["--project without a value", ["--project"], /--project needs a value/],
			["an empty --project", ["--project", ""], /--project needs a value/],
			["--project followed by a flag", ["--project", "--with-marker"], /--project needs a value/],
			["a repeated --project", ["--project", "a", "--project", "b"], /--project given more than once/],
			["a repeated --with-marker", ["--with-marker", "--with-marker"], /--with-marker given more than once/],
			["a stray word", ["agent-factory"], /unknown argument: agent-factory/],
				["--container without a value", ["--container"], /--container needs a value/],
				["an empty --container", ["--container", ""], /--container needs a value/],
				["--container followed by a flag", ["--container", "--with-marker"], /--container needs a value/],
				["a repeated --container", ["--container", "a", "--container", "b"], /--container given more than once/],
				["--container together with --project", ["--container", "a", "--project", "b"], /--container and --project cannot be used together/],
		],
	},
	{
		command: "backup",
		script: "backup/backup.ts",
		usage: /usage: node deploy\/backup\/backup\.ts/,
		wrong: [
			["an unknown flag", ["--target", "t", "--bogus"], /unknown argument: --bogus/],
			["--target as the last argument", ["--target"], /--target needs a value/],
			["an empty --target", ["--target", ""], /--target needs a value/],
			["an empty --project", ["--target", "t", "--project", ""], /--project needs a value/],
			["--project as the last argument", ["--target", "t", "--project"], /--project needs a value/],
			["a repeated --target", ["--target", "a", "--target", "b"], /--target given more than once/],
			["a repeated --project", ["--target", "t", "--project", "a", "--project", "b"], /--project given more than once/],
			["a missing --target", ["--project", "p"], /--target is required/],
		],
	},
	{
		command: "restore-check",
		script: "backup/restore-check.ts",
		usage: /usage: node deploy\/backup\/restore-check\.ts/,
		wrong: [
			["an unknown flag", ["--manifest", "m", "--bogus"], /unknown argument: --bogus/],
			["--prefix as the last argument", ["--manifest", "m", "--prefix"], /--prefix needs a value/],
			["an empty --prefix", ["--manifest", "m", "--prefix", ""], /--prefix needs a value/],
			["--manifest as the last argument", ["--manifest"], /--manifest needs a value/],
			["an empty --manifest", ["--manifest", ""], /--manifest needs a value/],
			["a repeated --manifest", ["--manifest", "a", "--manifest", "b"], /--manifest given more than once/],
			["a repeated --prefix", ["--manifest", "m", "--prefix", "a", "--prefix", "b"], /--prefix given more than once/],
			["a missing --manifest", ["--prefix", "p"], /--manifest is required/],
		],
	},
	{
		command: "restore",
		script: "backup/restore.ts",
		usage: /usage: node deploy\/backup\/restore\.ts/,
		wrong: [
			["an unknown flag", ["--manifest", "m", "--secrets", "s", "--bogus"], /unknown argument: --bogus/],
			["--secrets as the last argument", ["--manifest", "m", "--secrets"], /--secrets needs a value/],
			["an empty --secrets", ["--manifest", "m", "--secrets", ""], /--secrets needs a value/],
			["an empty --manifest", ["--manifest", "", "--secrets", "s"], /--manifest needs a value/],
			["--port as the last argument", ["--manifest", "m", "--secrets", "s", "--port"], /--port needs a value/],
			["a --port that is not a number", ["--manifest", "m", "--secrets", "s", "--port", "abc"], /--port needs a whole number/],
			["a --port out of range", ["--manifest", "m", "--secrets", "s", "--port", "70000"], /--port must be between 1 and 65535/],
			["a repeated --secrets", ["--manifest", "m", "--secrets", "a", "--secrets", "b"], /--secrets given more than once/],
			["a repeated --port", ["--manifest", "m", "--secrets", "s", "--port", "5000", "--port", "5001"], /--port given more than once/],
			["a missing --secrets", ["--manifest", "m"], /--secrets is required/],
			["a missing --manifest", ["--secrets", "s"], /--manifest is required/],
		],
	},
	{
		command: "setup-secrets",
		script: "setup-secrets.ts",
		usage: /usage: node deploy\/setup-secrets\.ts/,
		wrong: [
			["no directory", [], /missing argument/],
			["--check without a directory", ["--check"], /missing argument/],
			["an unknown flag", ["--bogus", "dir"], /unknown argument: --bogus/],
			["a repeated --check", ["--check", "--check", "dir"], /--check given more than once/],
			["two directories", ["a", "b"], /unknown argument: b/],
			["an empty directory", [""], /an argument is empty/],
				["--check-access without a directory", ["--check-access"], /missing argument/],
				["a repeated --check-access", ["--check-access", "--check-access", "dir"], /--check-access given more than once/],
				["--check together with --check-access", ["--check", "--check-access", "dir"], /--check and --check-access cannot be used together/],
		],
	},
];

describe("every command refuses a wrong command line with exit status 2 and its usage", () => {
	// The rows use relative paths ("b", "t"). Run in a disposable cwd, so a command that wrongly accepted a row (a parser
	// regression) would write there and not into the worktree (a real backup once landed in factory/b that way).
	let dir: OwnedDir;
	let cwd = "";
	before(async () => {
		dir = await OwnedDir.make(tmpdir(), "af-test-cli-args-");
		cwd = dir.path;
	});
	after(async () => {
		// Removed by identity, bottom-up, like the other tests' work directories.
		await dir.adoptChildren();
		const problems = await dir.remove();
		if (problems.length > 0) throw new Error(problems.join("; "));
	});
	for (const { command, script, usage, wrong } of TABLE) {
		for (const [name, argv, message] of wrong) {
			it(`${command}: ${name}`, async () => {
				const result = await run("node", [cli(script), ...argv], { cwd });
				assert.equal(result.code, 2, `exit status; stderr: ${result.stderr}`);
				assert.match(result.stderr, message);
				assert.match(result.stderr, usage);
				assert.equal(result.stdout, "", "a refused command line prints nothing on stdout");
			});
		}
	}
});
