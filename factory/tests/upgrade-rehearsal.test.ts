// Rehearsal of the upgrade of a running stack (deployment.md "Upgrade of a running stack", "Roll back" and the way out of a
// restart loop) on a legacy fixture. The fixture is the deploy directory of the revision before the marker
// `.af-init-complete` existed (LEGACY_REVISION: its compose file, its start wrapper and its init scripts, read from git),
// started as the owner's stack was, on a scratch project of its own. The commands are the ones of the doc, taken from it and
// run as written in Windows PowerShell; only the real project name is replaced by the scratch one, `--project` is added to the
// two node tools that default to the real project, and `git pull` is replaced by copying the deploy files of this revision
// over the legacy ones (the update the pull makes).
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { freePort, run, runChecked, stackEnv, waitHealthy } from "../deploy/lib.ts";
import { REPO_ROOT, RUN_LABEL_FILE, adaptCommand, commandsOf, docText, proofDefinition, psq, restrictDir, runPs } from "./doc-lib.ts";
import { Cleanups, newSecretsDir, trackedProject } from "./helpers.ts";
import { composeUpFrom } from "./owned-docker.ts";
import { disposeScratch, makeScratch } from "./scratch.ts";

// The revision the owner's stack was made from: compose file with the health check of the server only, no marker, no
// verification of the data directory by the wrapper (git log: "secrets only into a verified directory, ...").
const LEGACY_REVISION = "a8c628a";
const DATA = "/var/lib/postgresql/data";
// A file the test puts into the data directory: it proves that the same volume is served after every step.
const SENTINEL = "af-rehearsal-sentinel";

const git = async (...args: string[]): Promise<string> => runChecked("git", args, { cwd: REPO_ROOT });

// Writes the deploy directory of the legacy revision into <repo>/factory/deploy, and the package file that makes the node
// tools run as modules.
const writeLegacyTree = async (repo: string): Promise<void> => {
	const hash = (await git("rev-parse", `${LEGACY_REVISION}^{commit}`)).trim();
	const files = (await git("ls-tree", "-r", "--name-only", hash, "factory/deploy")).split(/\r?\n/).filter(Boolean);
	assert.ok(files.includes("factory/deploy/compose.yml") && files.includes("factory/deploy/postgres/entrypoint.sh"), "the legacy revision has the deploy files");
	for (const file of files) {
		const target = join(repo, ...file.split("/"));
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, await git("show", `${hash}:${file}`));
	}
	writeFileSync(join(repo, "factory", "package.json"), await git("show", "HEAD:factory/package.json"));
};

interface Fixture {
	readonly project: string;
	readonly runId: string;
	readonly secretsDir: string;
	readonly port: number;
	readonly repo: string;
	readonly backups: string;
	readonly old: string;
	readonly container: string;
	readonly env: Record<string, string>;
}

const exec = async (fixture: Fixture, ...args: string[]): Promise<string> => (await runChecked("docker", ["exec", "-u", "postgres", fixture.container, ...args])).trim();

const systemId = async (fixture: Fixture): Promise<string> => {
	const text = await exec(fixture, "/usr/lib/postgresql/16/bin/pg_controldata", DATA);
	return /Database system identifier:\s*(\d+)/.exec(text)?.[1] ?? "";
};

const inspect = async (fixture: Fixture, format: string): Promise<string> => (await runChecked("docker", ["inspect", "--format", format, fixture.container])).trim();

// A legacy stack: the legacy deploy files, started with a scratch project's own name, volume, port and secrets, labelled
// with the run id (the second compose file) so that cleanup finds it. Waits until it is healthy by its own health check.
const legacyStack = async (cleanups: Cleanups): Promise<Fixture> => {
	const { project, runId } = trackedProject(cleanups);
	const secretsDir = await newSecretsDir(cleanups);
	const port = await freePort();
	const root = await makeScratch("af-upgrade-");
	cleanups.add(() => disposeScratch(root));
	const repo = join(root.path, "repo");
	const backups = join(root.path, "backups");
	mkdirSync(repo);
	mkdirSync(backups);
	await restrictDir(backups);
	await writeLegacyTree(repo);
	const fixture: Fixture = { project, runId, secretsDir, port, repo, backups, old: join(root.path, "old"), container: `${project}-postgres-1`, env: stackEnv({ project, secretsDir, port, runId }) };
	await composeUpFrom(fixture.project, join(repo, "factory", "deploy", "compose.yml"), RUN_LABEL_FILE, fixture.env);
	await waitHealthy(fixture.container);
	await exec(fixture, "sh", "-c", `echo ${SENTINEL} > ${DATA}/${SENTINEL}`);
	return fixture;
};

// The fixture is the legacy stack: no marker, the health check of the server only, a data directory of the legacy init.
const assertLegacy = async (fixture: Fixture): Promise<void> => {
	assert.doesNotMatch(await inspect(fixture, "{{json .Config.Healthcheck.Test}}"), /af-init-complete/, "the fixture has the old health check");
};

// The commands of one part of the "Upgrade of a running stack" section of the doc, adapted to the scratch project.
const upgradeSection = (): string => {
	const text = docText("deployment.md");
	const start = text.indexOf("## Upgrade of a running stack");
	const end = text.indexOf("\n## ", start + 1);
	assert.ok(start >= 0 && end > start, "deployment.md has the section");
	return text.slice(start, end);
};

const part = (from: string, to: string | undefined): string => {
	const section = upgradeSection();
	const start = section.indexOf(from);
	const end = to === undefined ? section.length : section.indexOf(to, start);
	assert.ok(start >= 0 && end > start, `the section has "${from}"`);
	return section.slice(start, end);
};

const ROLLBACK = "Roll back, when step 9 failed";
const LOOP = "A stack that already restarts in a loop";

// Prose that is written as a code span but is not a step.
const NOT_A_STEP = /^docker (logs|start)\b/;

const stepsOf = (text: string, fixture: Fixture): string[] =>
	commandsOf(text)
		.map(({ code }) => code)
		.filter((code) => !NOT_A_STEP.test(code))
		.map((code) => {
			const adapted = adaptCommand(code, { project: fixture.project });
			// (the added run file's path is the worktree's, which may contain the name)
			assert.doesNotMatch(adapted.replaceAll(RUN_LABEL_FILE, "").replaceAll("/etc/agent-factory/", ""), /agent-factory/, `no command keeps the real project's name: ${code}`);
			return /\b(backup|verify-init)\.ts\b/.test(adapted) && !/--(project|container)\b/.test(adapted) ? `${adapted} --project ${fixture.project}` : adapted;
		});

const upgradeSteps = (fixture: Fixture): string[] => {
	const steps = stepsOf(part("Upgrade, in this order:", ROLLBACK), fixture);
	// `git pull` is the update; here the files of this revision are copied over the legacy ones.
	const at = steps.findIndex((step) => step === "git pull --ff-only");
	assert.ok(at >= 0, "the doc updates the repository with git pull");
	steps[at] = `Copy-Item -Recurse -Force ${psq(`${REPO_ROOT}/factory/deploy/*`)} 'factory/deploy'`;
	// The doc has the reader copy the `<UTC stamp>-<8 hex>` part of the name the backup command printed into $manifest; the
	// rehearsal does the same reading, from that command's own output, and nothing else (never the newest file of the directory).
	const backup = steps.findIndex((step) => /\bbackup\.ts\b/.test(step));
	const named = steps.findIndex((step) => step.startsWith("$manifest = ") && step.includes("<UTC stamp>-<8 hex>"));
	assert.ok(backup >= 0 && named > backup, "the doc takes a backup, then names its manifest from the printed name");
	steps[backup] = `$printed = (${steps[backup]}); $printed; $printedName = [regex]::Match(($printed -join "\`n"), 'backup written: .*[\\\\/]af-(\\S+)\\.manifest\\.json').Groups[1].Value; if (-not $printedName) { throw 'the backup command printed no manifest name' }`;
	steps[named] = (steps[named] as string).replace("'af-<UTC stamp>-<8 hex>.manifest.json'", "('af-' + $printedName + '.manifest.json')");
	return steps;
};

const prelude = (fixture: Fixture): string[] => {
	const proof = proofDefinition(docText("deployment.md"));
	assert.ok(proof);
	return [proof, `$secrets = ${psq(fixture.secretsDir)}`, `$backups = ${psq(fixture.backups)}`, `$old = ${psq(fixture.old)}`, `$project = ${psq(fixture.project)}`];
};

const play = async (fixture: Fixture, steps: readonly string[]): Promise<void> => {
	const result = await runPs(steps, { cwd: fixture.repo, env: fixture.env, prelude: prelude(fixture), timeoutMs: 900_000 });
	assert.equal(result.code, 0, `the doc steps stopped (exit ${result.code}) in step ${result.steps.length - 1}: ${steps[result.steps.length - 1]}\n${result.stdout}\n${result.stderr}`);
};

// The data and the database are the same as before the upgrade: the sentinel file, the system identifier, the volume.
// The record the doc's step 4 wrote before the upgrade: a container id, the real volume's name and the system identifier,
// none empty (the doc is run in Windows PowerShell 5.1, the owner's shell: `powershell`, see runPs in doc-lib.ts).
const assertRecord = (fixture: Fixture, legacyId: string, system: string, volume: string): void => {
	const files = readdirSync(fixture.backups).filter((name) => /^upgrade-.*\.json$/.test(name));
	assert.equal(files.length, 1, "the doc wrote one upgrade record");
	const record = JSON.parse(readFileSync(join(fixture.backups, files[0] as string), "utf8")) as { container?: string; volume?: string; system?: string };
	assert.ok(record.volume, "the recorded volume name is not empty");
	assert.equal(record.volume, volume, "the recorded volume is the real volume");
	assert.equal(record.container, legacyId, "the recorded container is the one that ran before the upgrade");
	assert.equal(record.system, system, "the recorded system identifier is the real one");
};

const assertSameData = async (fixture: Fixture, system: string, volume: string): Promise<void> => {
	assert.equal(await exec(fixture, "cat", `${DATA}/${SENTINEL}`), SENTINEL, "the sentinel in the data directory");
	assert.equal(await systemId(fixture), system, "the same database system");
	const mounts = JSON.parse(await inspect(fixture, "{{json .Mounts}}")) as Array<{ Destination: string; Name?: string }>;
	assert.equal(mounts.find((mount) => mount.Destination === DATA)?.Name, volume, "the same volume");
};

describe("the stops of the upgrade section", () => {
	// A start in the window between a stop and the daemon recording it is silently lost, and that window is too short to
	// observe in a run, so the rehearsal cannot see a missing wait: the doc is checked for it here (deployment.md "Stop and
	// start"). Every stop (compose stop of the project, docker stop of one container) is followed by the wait for that container.
	it("every stop is followed at once by a wait for the container it stopped", () => {
		const commands = commandsOf(upgradeSection())
			.map(({ code }) => code)
			.filter((code) => !NOT_A_STEP.test(code));
		const stops = commands.flatMap((code, index) => {
			const compose = /^docker compose -p agent-factory -f factory\/deploy\/compose\.yml stop$/.test(code);
			const single = /^docker stop (\S+)$/.exec(code);
			return compose || single ? [{ index, container: compose ? "agent-factory-postgres-1" : (single?.[1] as string) }] : [];
		});
		assert.equal(stops.length, 4, "the upgrade, the rollback and the restart-loop way out stop four times");
		for (const { index, container } of stops) {
			assert.equal(commands[index + 1], `docker wait ${container}`, `the stop "${commands[index]}" is followed by the wait for ${container}`);
		}
	});
});

describe("upgrade of a running legacy stack, by the commands of the doc", () => {
	it("the doc steps upgrade the legacy stack to this revision and roll it back to the legacy files, on the same data", async () => {
		const cleanups = new Cleanups();
		try {
			const fixture = await legacyStack(cleanups);
			await assertLegacy(fixture);
			const legacyId = await inspect(fixture, "{{.Id}}");
			const system = await systemId(fixture);
			const volume = `${fixture.project}_pgdata`;
			const upgrade = upgradeSteps(fixture);
			assert.ok(upgrade.length >= 20, `the upgrade has its steps (${upgrade.length})`);

			await play(fixture, upgrade);
			assertRecord(fixture, legacyId, system, volume);
			assert.notEqual(await inspect(fixture, "{{.Id}}"), legacyId, "the container is a new one");
			assert.match(await inspect(fixture, "{{json .Config.Healthcheck.Test}}"), /af-init-complete/, "the new revision's health check");
			assert.equal(await inspect(fixture, "{{.State.Health.Status}}"), "healthy");
			assert.equal(await exec(fixture, "test", "-f", `${DATA}/.af-init-complete`).then(() => "marked"), "marked", "the data directory is marked");
			await assertSameData(fixture, system, volume);

			const rollback = stepsOf(part(ROLLBACK, LOOP), fixture);
			assert.ok(rollback.length >= 6, `the roll back has its steps (${rollback.length})`);
			await play(fixture, rollback);
			assert.doesNotMatch(await inspect(fixture, "{{json .Config.Healthcheck.Test}}"), /af-init-complete/, "the old health check is back");
			assert.equal(await inspect(fixture, "{{.State.Health.Status}}"), "healthy");
			await assertSameData(fixture, system, volume);
		} finally {
			await cleanups.runAll();
		}
	});

	it("the doc steps lead a restart-looping stack (updated and started before the marking) back to a healthy one on the same data", async () => {
		const cleanups = new Cleanups();
		try {
			const fixture = await legacyStack(cleanups);
			await assertLegacy(fixture);
			const system = await systemId(fixture);
			const volume = `${fixture.project}_pgdata`;
			// The mistake the doc names: the files are updated and the stack is started at once.
			const update = upgradeSteps(fixture).find((step) => step.startsWith("Copy-Item -Recurse -Force"));
			assert.ok(update, "the update step is there");
			await play(fixture, [update]);
			const deploy = join(fixture.repo, "factory", "deploy", "compose.yml");
			await composeUpFrom(fixture.project, deploy, RUN_LABEL_FILE, fixture.env);
			let restarts = 0;
			for (let i = 0; i < 100 && restarts < 2; i++) {
				restarts = Number((await run("docker", ["inspect", "--format", "{{.RestartCount}}", fixture.container])).stdout.trim() || "0");
				if (restarts < 2) await new Promise((resolve) => setTimeout(resolve, 500));
			}
			assert.ok(restarts >= 2, "the container restarts in a loop (the wrapper refuses the unmarked data)");
			assert.match((await run("docker", ["logs", fixture.container])).stderr, /refusing to start/);
			assert.notEqual(await inspect(fixture, "{{.State.Health.Status}}"), "healthy");

			const steps = stepsOf(part(LOOP, undefined), fixture);
			assert.ok(steps.length >= 10, `the way out has its steps (${steps.length})`);
			try {
				await play(fixture, steps);
			} catch (error) {
				const logs = await run("docker", ["logs", `${fixture.project}-oneoff`]);
				const state = await run("docker", ["inspect", "--format", "{{json .State}} {{json .Config.Entrypoint}} {{json .Config.Cmd}}", `${fixture.project}-oneoff`]);
				const all = await run("docker", ["ps", "-a", "--format", "{{.Names}} {{.Status}} {{.Command}}", "--filter", `label=af.run=${fixture.runId}`]);
				throw new Error(`${(error as Error).message}\none-off log:\n${logs.stdout}\n${logs.stderr}\nstate:${state.stdout}${state.stderr}\nall:${all.stdout}`);
			}
			// The doc ends with "confirm as in step 9": the health and the new container.
			await waitHealthy(fixture.container);
			assert.match(await inspect(fixture, "{{json .Config.Healthcheck.Test}}"), /af-init-complete/);
			assert.equal((await run("docker", ["inspect", `${fixture.project}-oneoff`])).code, 1, "the one-off container is gone");
			await exec(fixture, "test", "-f", `${DATA}/.af-init-complete`);
			await assertSameData(fixture, system, volume);
		} finally {
			await cleanups.runAll();
		}
	});
});
