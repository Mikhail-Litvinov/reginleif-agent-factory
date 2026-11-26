// The commands of the operator docs are pasted into Windows PowerShell as they stand. An angle-bracket placeholder
// outside a quoted string is parsed by PowerShell as a redirection, so the command does something else (or fails). A
// placeholder is written once into a variable, as a single-quoted string, and the commands use the variable.
//
// The emergency volume copy of recovery.md is run as the doc writes it: the script text and the image are read from the
// doc (the volume is replaced by a scratch directory or a memory disk where the failure needs it), and the doc line itself
// is run in PowerShell against a stack's own volume. The copy must never present a half archive as its result.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { freePort, runChecked, stackArgs, stackEnv } from "../deploy/lib.ts";
import { adaptCommand, commandsOf, docText, docUrl, gateDefinition, outsideQuotes, proofDefinition, restrictDir, runPs } from "./doc-lib.ts";
import { Cleanups, newSecretsDir, trackedProject } from "./helpers.ts";
import { runContainer } from "./owned-docker.ts";
import { disposeScratch, makeScratch } from "./scratch.ts";

const DOCS = ["deployment.md", "recovery.md", "database.md"];

// The doc line that copies the data volume: the one command with a shell script for the container.
const copyLine = (): string => {
	const found = commandsOf(docText("recovery.md")).find(({ code }) => /--rm\b/.test(code) && /\bsh -c '/.test(code));
	assert.ok(found, "recovery.md has a copy command that runs a shell script in the container");
	return found.code;
};

const copyScript = (): { script: string; image: string } => {
	const line = copyLine();
	const script = /\bsh -c '([^']+)'/.exec(line)?.[1] ?? "";
	const image = /\s(alpine)\s+sh -c/.exec(line)?.[1] ?? "";
	assert.notEqual(script, "");
	assert.notEqual(image, "");
	return { script, image };
};

const listing = (dir: string): string[] => readdirSync(dir).sort();

// Waits (a bounded poll, 50 ms steps, 30 s at most) until the directory has a file ending in `suffix`.
const waitForFile = async (dir: string, suffix: string): Promise<boolean> => {
	for (let i = 0; i < 600; i++) {
		if (listing(dir).some((name) => name.endsWith(suffix))) return true;
		await pause(50);
	}
	return false;
};

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

	// The volume copy writes a new file and refuses a name that exists: a second run into the same name must fail and leave
	// the first file as it was, and the doc must not name a fixed file.
	it("recovery.md: the volume copy writes a new file and refuses a name that exists", async () => {
		assert.doesNotMatch(docText("recovery.md"), /pgdata\.tgz/, "a fixed file name would be overwritten by the next copy");
		const doc = copyScript();
		const cleanups = new Cleanups();
		try {
			const runId = trackedProject(cleanups).runId;
			const scratch = await makeScratch("af-copydoc-");
			cleanups.add(() => disposeScratch(scratch));
			const source = join(scratch.path, "src");
			const out = join(scratch.path, "out");
			mkdirSync(source);
			mkdirSync(out);
			writeFileSync(join(source, "PG_VERSION"), "16\n");
			const copy = (): Promise<string> => runContainer(runId, "--rm", "-e", "NAME=copy.tgz", "-v", `${source}:/d:ro`, "-v", `${out}:/o`, doc.image, "sh", "-c", doc.script);
			assert.equal((await copy()).trim(), "copy.tgz", "the name is printed on success");
			const before = readFileSync(join(out, "copy.tgz"));
			assert.ok(before.length > 0);
			await assert.rejects(copy(), "the second copy into the same name must be refused");
			assert.deepEqual(readFileSync(join(out, "copy.tgz")), before);
			assert.deepEqual(listing(out), ["copy.tgz"], "a refused copy leaves no part file");
		} finally {
			await cleanups.runAll();
		}
	});

	// A failed write (a full disk) must leave no archive and no part file, and the script must exit non-zero. The source and
	// the target are memory disks, the target too small for the data; the script's own exit status and the target's content
	// are written to a results directory from inside the container, since the memory disk vanishes with it.
	it("recovery.md: a failed write (full disk) leaves no file and exits non-zero; the same run on a roomy disk succeeds", async () => {
		const doc = copyScript();
		const cleanups = new Cleanups();
		try {
			const runId = trackedProject(cleanups).runId;
			const scratch = await makeScratch("af-copyfull-");
			cleanups.add(() => disposeScratch(scratch));
			const attempt = async (targetSize: string, tag: string): Promise<{ rc: string; left: string }> => {
				const results = join(scratch.path, tag);
				mkdirSync(results);
				const wrapper = 'head -c 2097152 /dev/urandom > /d/random; sh -c "$SCRIPT" > /r/out 2> /r/err; echo $? > /r/rc; ls -A /o > /r/left';
				await runContainer(runId, "--rm", "-e", "NAME=copy.tgz", "-e", `SCRIPT=${doc.script}`, "--tmpfs", "/d", "--tmpfs", `/o:size=${targetSize}`, "-v", `${results}:/r`, doc.image, "sh", "-c", wrapper);
				return { rc: readFileSync(join(results, "rc"), "utf8").trim(), left: readFileSync(join(results, "left"), "utf8").trim() };
			};
			const roomy = await attempt("64m", "roomy");
			assert.equal(roomy.rc, "0", "the control run on a roomy disk succeeds");
			assert.equal(roomy.left, "copy.tgz");
			const full = await attempt("64k", "full");
			assert.notEqual(full.rc, "0", "a write that fails must end the script with a failure");
			assert.equal(full.left, "", "neither a half archive nor a part file is left");
		} finally {
			await cleanups.runAll();
		}
	});

	// An interruption (the container told to stop while the archive is being written) must leave no archive and no part file.
	it("recovery.md: an interrupted copy leaves no file and exits non-zero", async () => {
		const doc = copyScript();
		const cleanups = new Cleanups();
		try {
			const runId = trackedProject(cleanups).runId;
			const scratch = await makeScratch("af-copyint-");
			cleanups.add(() => disposeScratch(scratch));
			const out = join(scratch.path, "out");
			mkdirSync(out);
			const container = `${runId}-copy`;
			// A sparse 20 GB file on a memory disk takes the archiver far longer than the test waits.
			await runContainer(runId, "-d", "--name", container, "-e", "NAME=copy.tgz", "--tmpfs", "/d:size=30g", "-v", `${out}:/o`, doc.image, "sh", "-c", `truncate -s 20G /d/big; ${doc.script}`);
			assert.ok(await waitForFile(out, ".part"), "the copy started and is writing its part file");
			await runChecked("docker", ["kill", "--signal", "TERM", container]);
			const status = (await runChecked("docker", ["wait", container])).trim();
			assert.notEqual(status, "0", "an interrupted copy ends with a failure");
			assert.deepEqual(listing(out), [], "neither a half archive nor a part file is left");
		} finally {
			await cleanups.runAll();
		}
	});

	// The doc line itself, in PowerShell, on a volume of the stack's own: it prints the name, and the archive holds the data.
	// A directory that is open to everyone is refused before any container starts.
	it("recovery.md: the copy line refuses an unprotected directory and, on the stack's own volume, writes a whole archive", async () => {
		const line = copyLine();
		const text = docText("recovery.md");
		const proof = proofDefinition(text);
		const gate = gateDefinition(text);
		assert.ok(proof && gate);
		const cleanups = new Cleanups();
		try {
			const { project, runId } = trackedProject(cleanups);
			const secretsDir = await newSecretsDir(cleanups);
			const port = await freePort();
			const options = { project, runId, secretsDir, port };
			await runChecked("docker", stackArgs(options, "create"), { env: stackEnv(options) });
			await runContainer(runId, "--rm", "-v", `${project}_pgdata:/d`, "-e", "S=sentinel-of-the-copy", "alpine", "sh", "-c", "echo $S > /d/SENTINEL");
			const scratch = await makeScratch("af-copyline-");
			cleanups.add(() => disposeScratch(scratch));
			const open = await makeScratch("af-copyopen-");
			cleanups.add(() => disposeScratch(open));
			await restrictDir(scratch.path);
			await restrictDir(open.path, ["*S-1-1-0:(OI)(CI)R"]);
			const prelude = (copy: string): string[] => [proof, gate, `$copy = '${copy}'`, "$name = 'copy.tgz'", `$env:AF_SECRETS_DIR = '${secretsDir}'`];
			const command = adaptCommand(line, { project });

			const refused = await runPs([command], { prelude: prelude(open.path), env: stackEnv(options) });
			assert.notEqual(refused.code, 0, "a directory open to everyone is refused");
			assert.deepEqual(listing(open.path), [], "nothing was written there");

			const done = await runPs([command], { prelude: prelude(scratch.path), env: stackEnv(options) });
			assert.equal(done.code, 0, done.stderr);
			assert.equal(done.steps[0]?.trim(), "copy.tgz", "only the file name is printed");
			assert.deepEqual(listing(scratch.path), ["copy.tgz"]);
			const member = await runContainer(runId, "--rm", "-v", `${scratch.path}:/o:ro`, "alpine", "tar", "-xzOf", "/o/copy.tgz", "./SENTINEL");
			assert.equal(member.trim(), "sentinel-of-the-copy", "the archive holds the volume's data");
		} finally {
			await cleanups.runAll();
		}
	});

	it("the check itself sees a bare placeholder and ignores a quoted one", () => {
		assert.equal(commandsOf("`node a.ts --project <project>`").length, 1);
		assert.match(outsideQuotes("node a.ts --project <project>"), /<project>/);
		assert.doesNotMatch(outsideQuotes("$x = '<project>'"), /</);
	});
});
