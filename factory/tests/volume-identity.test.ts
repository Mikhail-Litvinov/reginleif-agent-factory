// A documented step that mounts, adopts or removes the data volume must first prove that the volume is the stack's own:
// a volume of the same name that compose did not make (another project's, a hand-made one) is refused, not adopted
// ("up" would mount it as the database), not copied and not deleted. The proof is one definition per doc (`$proveVolume`),
// and each such command stands on one line with the proof before it: a pasted line that fails stops only itself, so a
// proof on an earlier line would not stop the command after it.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { freePort, runChecked, stackArgs, stackEnv } from "../deploy/lib.ts";
import type { OwnedDir } from "../deploy/owned.ts";
import { adaptCommand, commandsOf, docText, gateDefinition, isMountSite, proofBefore, proofDefinition, projectOfSite, restrictDir, runPs } from "./doc-lib.ts";
import { Cleanups, newSecretsDir, trackedProject } from "./helpers.ts";
import { createVolume, runContainer } from "./owned-docker.ts";
import { makeScratch, disposeScratch } from "./scratch.ts";

const DOCS = ["deployment.md", "recovery.md"];
const HEX = "0123456789ab";
const SENTINEL = "sentinel-of-a-foreign-volume";

const sitesOf = (name: string): Array<{ line: number; code: string }> => commandsOf(docText(name)).filter(({ code }) => isMountSite(code));

const sentinelIn = async (runId: string, volume: string): Promise<string> =>
	(await runContainer(runId, "--rm", "-v", `${volume}:/d:ro`, "alpine", "cat", "/d/SENTINEL")).trim();

const foreignVolume = async (cleanups: Cleanups, runId: string, name: string): Promise<void> => {
	await cleanups.track(createVolume(runId, name));
	await runContainer(runId, "--rm", "-v", `${name}:/d`, "-e", `S=${SENTINEL}`, "alpine", "sh", "-c", "echo $S > /d/SENTINEL");
};

describe("volume identity: the doc proves the data volume before it acts on it", () => {
	for (const name of DOCS) {
		it(`${name} defines the proof once and puts it before every command that mounts or removes the data volume`, () => {
			const text = docText(name);
			assert.ok(proofDefinition(text), `${name} has a line that defines $proveVolume`);
			const sites = sitesOf(name);
			assert.ok(sites.length > 0, `${name} has commands that act on the data volume`);
			const bad = sites
				.filter(({ code }) => proofBefore(code) === undefined || proofBefore(code) !== projectOfSite(code))
				.map(({ line, code }) => `${name}:${line}: ${code}`);
			assert.deepEqual(bad, [], "the proof of the same project must come first on the same line");
		});
	}

	it("both docs define the same proof", () => {
		const [first, second] = DOCS.map((name) => proofDefinition(docText(name)));
		assert.ok(first && second);
		assert.equal(first, second);
	});

	it("both docs define the same protected-directory gate, and the command that copies the data volume runs it first", () => {
		const [first, second] = DOCS.map((name) => gateDefinition(docText(name)));
		assert.ok(first && second);
		assert.equal(first, second);
		const copies = sitesOf("recovery.md").filter(({ code }) => /\bdocker\s+run\b/.test(code));
		assert.ok(copies.length > 0, "recovery.md has a command that copies the data volume");
		for (const { code } of copies) {
			const gate = code.indexOf("& $protectedDir ");
			assert.ok(gate >= 0 && gate < code.indexOf("& $proveVolume "), `the gate comes first on the line: ${code}`);
		}
	});

	it("the gate refuses a missing directory and one open to everyone, and accepts a restricted one", async () => {
		const definition = gateDefinition(docText("deployment.md"));
		assert.ok(definition, "deployment.md defines $protectedDir");
		let work: OwnedDir | undefined;
		try {
			work = await makeScratch("af-gate-");
			await restrictDir(work.path);
			const ok = await runPs([`& $protectedDir '${work.path}'`], { prelude: [definition] });
			assert.equal(ok.code, 0, ok.stderr);
			const missing = await runPs([`& $protectedDir '${work.path}\\nope'`], { prelude: [definition] });
			assert.notEqual(missing.code, 0);
			assert.match(missing.stderr, /refusing/);
			await restrictDir(work.path, ["*S-1-1-0:(OI)(CI)R"]);
			const open = await runPs([`& $protectedDir '${work.path}'`], { prelude: [definition] });
			assert.notEqual(open.code, 0, "a directory open to everyone is refused");
			assert.match(open.stderr, /refusing/);
		} finally {
			await disposeScratch(work);
		}
	});

	it("the proof refuses a volume that compose did not make, accepts the stack's own and an absent one", async () => {
		const definition = proofDefinition(docText("deployment.md"));
		assert.ok(definition, "deployment.md defines $proveVolume");
		const cleanups = new Cleanups();
		try {
			const { project, runId } = trackedProject(cleanups);
			const secretsDir = await newSecretsDir(cleanups);
			const port = await freePort();
			const absent = await runPs([`& $proveVolume '${project}'`], { prelude: [definition] });
			assert.equal(absent.code, 0, absent.stderr);

			await foreignVolume(cleanups, runId, `${project}_pgdata`);
			const foreign = await runPs([`& $proveVolume '${project}'`], { prelude: [definition] });
			assert.notEqual(foreign.code, 0, "an unlabelled volume of that name is refused");
			assert.match(foreign.stderr, /refusing/);
			assert.equal(await sentinelIn(runId, `${project}_pgdata`), SENTINEL);

			// The stack's own: created by compose itself, not started.
			const own = trackedProject(cleanups);
			const options = { project: own.project, runId: own.runId, secretsDir, port };
			await runChecked("docker", stackArgs(options, "create"), { env: stackEnv(options) });
			const ok = await runPs([`& $proveVolume '${own.project}'`], { prelude: [definition] });
			assert.equal(ok.code, 0, ok.stderr);
		} finally {
			await cleanups.runAll();
		}
	});

	it("the proof stops when docker itself cannot answer: only a successful answer without the volume counts as absent", async () => {
		const definition = proofDefinition(docText("deployment.md"));
		assert.ok(definition, "deployment.md defines $proveVolume");
		// A daemon address nothing listens on (port 1 on loopback): every docker call fails, as with a stopped or unreachable daemon.
		const unreachable = await runPs(["& $proveVolume 'af-no-daemon-probe'"], { prelude: [definition], env: { DOCKER_HOST: "tcp://127.0.0.1:1" } });
		assert.notEqual(unreachable.code, 0, "a failed docker call is not 'the volume is absent'");
		assert.match(unreachable.stderr, /refusing/);
	});

	for (const name of DOCS) {
		it(`${name}: every command that acts on the data volume refuses a same-name volume of another origin and leaves it whole`, async () => {
			const definition = proofDefinition(docText(name));
			const gate = gateDefinition(docText(name));
			const sites = sitesOf(name);
			assert.ok(sites.length > 0);
			for (const site of sites) {
				const cleanups = new Cleanups();
				let work: OwnedDir | undefined;
				try {
					const { project, runId } = trackedProject(cleanups);
					const secretsDir = await newSecretsDir(cleanups);
					const port = await freePort();
					cleanups.add(() => disposeScratch(work));
					work = await makeScratch("af-volid-");
					// Protected, so that a gate on the same line passes and only the volume proof can stop the line.
					await restrictDir(work.path);
					const code = adaptCommand(site.code, { project });
					const volume = `${projectOfSite(code)?.replaceAll("$hex", HEX)}_pgdata`;
					await foreignVolume(cleanups, runId, volume);
					const prelude = [
						...(definition ? [definition] : []),
						...(gate ? [gate] : []),
						`$secrets = '${secretsDir}'`,
						`$backups = '${work.path}'`,
						`$project = '${project}'`,
						`$copy = '${work.path}'`,
						`$old = '${work.path}'`,
						`$hex = '${HEX}'`,
						`$name = 'copy.tgz'`,
						`$container = '${project}-postgres-1'`,
						`$env:AF_SECRETS_DIR = $secrets`,
					];
					const result = await runPs([code], { prelude, env: stackEnv({ project, secretsDir, port, runId }) });
					assert.notEqual(result.code, 0, `${name}:${site.line} must stop on a foreign volume: ${site.code}`);
					assert.equal(await sentinelIn(runId, volume), SENTINEL, `${name}:${site.line} left the foreign volume whole`);
				} finally {
					await cleanups.runAll();
				}
			}
		});
	}
});
