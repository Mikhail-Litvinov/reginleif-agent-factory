// Backup and restore check: the good path and every way a backup can be broken.
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { backup, type Manifest } from "../deploy/backup/backup.ts";
import { restoreCheck, startScratch, type ScratchServer } from "../deploy/backup/restore-check.ts";
import { psql, run } from "../deploy/lib.ts";
import { OwnedDir } from "../deploy/owned.ts";
import { createTestStack, leftovers, type TestStack } from "./helpers.ts";
import { createHash } from "node:crypto";

const BACKUP_CLI = new URL("../deploy/backup/backup.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const CHECK_CLI = new URL("../deploy/backup/restore-check.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

describe("backup and restore check", () => {
	let stack: TestStack;
	let workDir: OwnedDir;
	let work: string;
	let good: { manifestPath: string; dumpPath: string; manifest: Manifest };

	let scratch: ScratchServer;
	let scratchStarting: Promise<ScratchServer>;
	let cliCheck: Promise<Awaited<ReturnType<typeof run>>>;

	// The real command, once (the intact backup); every other case runs in process against one shared scratch server.
	const checkCli = (manifestPath: string) => run("node", [CHECK_CLI, "--manifest", manifestPath, "--prefix", "af-test-rc"]);
	const check = (manifestPath: string, hooks?: Parameters<typeof restoreCheck>[0]["hooks"]) =>
		restoreCheck({ manifestPath, scratch, hooks });

	// Copies the good backup into a new directory so that a test can damage its own copy.
	const copyBackup = async (name: string) => {
		const dir = join(work, name);
		await run("node", ["-e", `require("fs").mkdirSync(${JSON.stringify(dir)})`]);
		const files = await readdir(join(work, "good"));
		for (const file of files) await copyFile(join(work, "good", file), join(dir, file));
		const manifestFile = files.find((f) => f.endsWith(".manifest.json")) as string;
		const dumpFile = files.find((f) => f.endsWith(".dump")) as string;
		return { dir, manifestPath: join(dir, manifestFile), dumpPath: join(dir, dumpFile), sumPath: join(dir, `${dumpFile}.sha256`) };
	};

	before(async () => {
		workDir = await OwnedDir.make(tmpdir(), "af-test-backup-");
		work = workDir.path;
		// The shared scratch server does not depend on the stack: it starts at the same time (its removal is in after()).
		scratchStarting = startScratch("af-test-rc");
		scratchStarting.catch(() => {});
		stack = await createTestStack();
		const c = stack.container;
		await psql(c, "af_migrator", [
			"CREATE TABLE parent (id int PRIMARY KEY, name text);",
			"CREATE TABLE child (id int PRIMARY KEY, parent_id int NOT NULL REFERENCES parent (id));",
			"CREATE TABLE empty_table (id int);",
			"INSERT INTO parent SELECT g, 'p' || g FROM generate_series(1, 50) g;",
			"INSERT INTO child SELECT g, 1 + g % 50 FROM generate_series(1, 200) g;",
		].join("\n"));
		good = await backup({ project: stack.project, target: join(work, "good") });
		// The real command starts its own scratch server (about 40 s), so it runs while the in-process cases use the shared one;
		// the test that reports its result awaits this promise (run() never rejects, so it cannot go unhandled).
		cliCheck = checkCli(good.manifestPath);
		scratch = await scratchStarting;
	});
	after(async () => {
		const errors: unknown[] = [];
		try {
			await cliCheck;
			await (await scratchStarting?.catch(() => undefined))?.close();
		} catch (error) {
			errors.push(error);
		}
		try {
			await stack?.dispose();
		} catch (error) {
			errors.push(error);
		}
		// The directory is private (mkdtemp) and everything in it was written by this test or the code it ran; it is
		// recorded now that nothing writes any more, and removed by identity, bottom-up, without a recursive delete.
		try {
			await workDir.adoptChildren();
			const problems = await workDir.remove();
			if (problems.length > 0) errors.push(new Error(problems.join("; ")));
		} catch (error) {
			errors.push(error);
		}
		if (errors.length > 0) throw new AggregateError(errors, "cleanup failed");
	});

	it("writes the dump, its checksum and a manifest with versions, row counts and foreign keys", async () => {
		const files = (await readdir(join(work, "good"))).sort();
		assert.equal(files.length, 3, files.join(", "));
		assert.ok(files.every((f) => !f.endsWith(".partial")));
		const m = good.manifest;
		assert.equal(m.database, "agent_factory");
		assert.match(m.serverVersion, /^16\./);
		assert.deepEqual(m.rowCounts, { "public.child": 200, "public.empty_table": 0, "public.parent": 50 });
		assert.equal(m.foreignKeys.length, 1);
		assert.equal(m.foreignKeys[0]?.validated, true);
		const sum = createHash("sha256").update(await readFile(good.dumpPath)).digest("hex");
		assert.equal(m.dump.sha256, sum);
		assert.equal((await readFile(`${good.dumpPath}.sha256`, "utf8")).split(" ")[0], sum);
	});

	it("two backups at once into one directory get different names and both stay valid", async () => {
		const { verifyBackupFiles } = await import("../deploy/backup/restore-check.ts");
		const target = join(work, "concurrent");
		const [a, b] = await Promise.all([backup({ project: stack.project, target }), backup({ project: stack.project, target })]);
		assert.notEqual(a.manifestPath, b.manifestPath);
		assert.notEqual(a.dumpPath, b.dumpPath);
		for (const one of [a, b]) await verifyBackupFiles(one.manifestPath);
		const files = await readdir(target);
		assert.equal(files.length, 6, files.join(", "));
		assert.ok(files.every((f) => !f.endsWith(".partial")));
		assert.match(a.manifest.dump.file, /^af-\d{8}T\d{6}Z-[0-9a-f]{8}\.dump$/);
	});

	it("a file that already holds one of the run's names is never overwritten or removed, and the run fails", async () => {
		const name = "af-20260101T000000Z-0badf00d";
		let n = 0;
		for (const suffix of [".dump", ".dump.sha256", ".manifest.json"]) {
			const target = join(work, `collide-${n++}`);
			await mkdir(target);
			const taken = join(target, `${name}${suffix}`);
			await writeFile(taken, "someone else's data");
			await assert.rejects(backup({ project: stack.project, target, nameFor: () => name }), /EEXIST/, suffix);
			assert.equal(await readFile(taken, "utf8"), "someone else's data", `${suffix} was changed`);
			assert.deepEqual(await readdir(target), [`${name}${suffix}`], `${suffix}: the failed run left files behind`);
		}
	});

	it("a failed run removes its own published files and leaves the foreign file that made it fail", async () => {
		const name = "af-20260101T000000Z-0badf00d";
		const target = join(work, "foreign-later");
		const sums = join(target, `${name}.dump.sha256`);
		await assert.rejects(
			backup({
				project: stack.project,
				target,
				nameFor: () => name,
				hooks: {
					afterDumpPublished: async () => {
						await writeFile(sums, "forces this run to fail"); // another run holds the checksum name
					},
				},
			}),
			/EEXIST/,
		);
		assert.equal(await readFile(sums, "utf8"), "forces this run to fail");
		assert.deepEqual(await readdir(target), [`${name}.dump.sha256`], "the run's own dump was removed, nothing else is left");
	});

	it("a failed run never removes a file that replaced one of its published names", async () => {
		const name = "af-20260101T000000Z-0badf00d";
		const target = join(work, "replaced");
		const dump = join(target, `${name}.dump`);
		const sums = join(target, `${name}.dump.sha256`);
		await assert.rejects(
			backup({
				project: stack.project,
				target,
				nameFor: () => name,
				hooks: {
					afterDumpPublished: async () => {
						await rename(dump, `${dump}.moved`); // the run's own published dump goes away (moved aside: tests never delete) ...
						await writeFile(dump, "another run's dump, same name"); // ... and another file takes the name
						await writeFile(sums, "forces this run to fail"); // this run fails at its checksum file
					},
				},
			}),
			/EEXIST/,
		);
		assert.equal(await readFile(dump, "utf8"), "another run's dump, same name");
		assert.equal(await readFile(sums, "utf8"), "forces this run to fail");
		assert.deepEqual((await readdir(target)).sort(), [`${name}.dump`, `${name}.dump.moved`, `${name}.dump.sha256`]);
	});

	it("a failed run keeps its staging directory when something it did not create is in it, and says so", async () => {
		const name = "af-20260101T000000Z-0badf00d";
		const target = join(work, "foreign-staging");
		let foreign = "";
		await assert.rejects(
			backup({
				project: stack.project,
				target,
				nameFor: () => name,
				hooks: {
					afterDumpPublished: async (staging) => {
						foreign = join(staging, "not-mine");
						await writeFile(foreign, "someone else's file inside the private directory");
						await writeFile(join(target, `${name}.dump.sha256`), "forces this run to fail");
					},
				},
			}),
			/EEXIST[\s\S]*cleanup left[\s\S]*not empty/,
		);
		assert.equal(await readFile(foreign, "utf8"), "someone else's file inside the private directory");
		assert.deepEqual((await readdir(target)).filter((entry) => !entry.endsWith(".dump.sha256")).length, 1, "only the kept staging directory remains");
	});

	it("never puts a password into the files or the manifest", async () => {
		for (const name of ["af_bootstrap", "af_migrator", "af_api", "af_control", "af_backup", "af_reader"]) {
			const password = (await stack.secret(name)).trim();
			for (const file of await readdir(join(work, "good"))) {
				const bytes = await readFile(join(work, "good", file));
				assert.equal(bytes.includes(password), false, `${name} password found in ${file}`);
			}
		}
	});

	it("refuses to run without a target directory", async () => {
		const result = await run("node", [BACKUP_CLI, "--project", stack.project]);
		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /target directory|usage/);
	});

	it("a failed dump leaves no dump, partial or manifest file behind", async () => {
		await psql(stack.container, "af_migrator", "REVOKE SELECT ON child FROM af_backup;");
		try {
			const target = join(work, "failed");
			await assert.rejects(backup({ project: stack.project, target }), /permission denied for table child/);
			const left = await readdir(target).catch(() => [] as string[]);
			assert.deepEqual(left, []);
		} finally {
			await psql(stack.container, "af_migrator", "GRANT SELECT ON child TO af_backup;");
		}
	});

	it("restore check passes on an intact backup", async () => {
		const result = await cliCheck;
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /passed/);
	});

	it("restore check passes in process on the shared scratch server, twice (the scratch database is reset between)", async () => {
		for (let i = 0; i < 2; i += 1) {
			const result = await check(good.manifestPath);
			assert.deepEqual(result.problems, []);
			assert.equal(result.ok, true);
		}
	});

	it("restore check fails on a flipped byte (checksum)", async () => {
		const copy = await copyBackup("flipped");
		const bytes = await readFile(copy.dumpPath);
		const at = Math.floor(bytes.length / 2);
		bytes.writeUInt8((bytes.readUInt8(at) ^ 0xff) & 0xff, at);
		await writeFile(copy.dumpPath, bytes);
		const result = await check(copy.manifestPath);
		assert.equal(result.ok, false);
		assert.match(result.problems.join("\n"), /checksum mismatch/);
	});

	it("restore check catches a dump changed after it was verified (the bytes pg_restore consumes are hashed)", async () => {
		const copy = await copyBackup("swapped");
		const bytes = await readFile(copy.dumpPath);
		const at = Math.floor(bytes.length / 2);
		const changed = Buffer.from(bytes);
		changed.writeUInt8((changed.readUInt8(at) ^ 0xff) & 0xff, at);
		const result = await check(copy.manifestPath, {
			beforeFeed: async () => {
				await writeFile(copy.dumpPath, changed);
			},
		});
		assert.equal(result.ok, false);
		assert.match(result.problems.join("\n"), /checksum mismatch: the dump changed after it was verified/);
	});

	it("restore check refuses a manifest that is not the final marker", async () => {
		const copy = await copyBackup("partial");
		await assert.rejects(check(`${copy.manifestPath}.partial`), /manifest .*\.partial/);
		const odd = join(copy.dir, "manifest.json");
		await copyFile(copy.manifestPath, odd);
		await assert.rejects(check(odd), /manifest .*af-/);
	});

	it("restore check fails on a truncated dump even when its checksum was recomputed", async () => {
		const copy = await copyBackup("truncated");
		const bytes = await readFile(copy.dumpPath);
		const cut = bytes.subarray(0, Math.floor(bytes.length * 0.6));
		await writeFile(copy.dumpPath, cut);
		const sum = createHash("sha256").update(cut).digest("hex");
		const manifest = JSON.parse(await readFile(copy.manifestPath, "utf8")) as Manifest;
		await writeFile(copy.sumPath, `${sum}  ${manifest.dump.file}\n`);
		await writeFile(copy.manifestPath, JSON.stringify({ ...manifest, dump: { ...manifest.dump, sha256: sum, bytes: cut.length } }));
		const result = await check(copy.manifestPath);
		assert.equal(result.ok, false);
		assert.match(result.problems.join("\n"), /pg_restore failed/);
	});

	it("restore check fails when the manifest is missing", async () => {
		const copy = await copyBackup("nomanifest");
		await rename(copy.manifestPath, `${copy.manifestPath}.moved`);
		await assert.rejects(check(copy.manifestPath), /manifest missing/);
	});

	it("restore check fails when a row count in the manifest differs", async () => {
		const copy = await copyBackup("rowcount");
		const manifest = JSON.parse(await readFile(copy.manifestPath, "utf8")) as Manifest;
		const changed = { ...manifest, rowCounts: { ...manifest.rowCounts, "public.child": 199 } };
		await writeFile(copy.manifestPath, JSON.stringify(changed));
		const result = await check(copy.manifestPath);
		assert.equal(result.ok, false);
		assert.match(result.problems.join("\n"), /public\.child: 199 rows in the backup, 200 after restore/);
	});

	// Last: closes the shared scratch server, then lists by its run label (the listing must succeed to count as empty).
	it("closing the scratch server leaves no container, volume or network with its label", async () => {
		assert.ok((await leftovers(scratch.runId)).length > 0, "the scratch server was running");
		await scratch.close();
		assert.deepEqual(await leftovers(scratch.runId), []);
	});
});
