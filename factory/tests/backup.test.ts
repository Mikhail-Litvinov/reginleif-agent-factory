// Backup and restore check: the good path and every way a backup can be broken.
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { backup, type Manifest } from "../deploy/backup/backup.ts";
import { psql, run } from "../deploy/lib.ts";
import { createTestStack, type TestStack } from "./helpers.ts";
import { createHash } from "node:crypto";

const BACKUP_CLI = new URL("../deploy/backup/backup.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const CHECK_CLI = new URL("../deploy/backup/restore-check.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

describe("backup and restore check", () => {
	let stack: TestStack;
	let work: string;
	let good: { manifestPath: string; dumpPath: string; manifest: Manifest };

	// A restore check of a manifest through the real command; resolves with its exit code and error text.
	const check = (manifestPath: string) => run("node", [CHECK_CLI, "--manifest", manifestPath, "--prefix", "af-test-rc"]);

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
		work = await mkdtemp(join(tmpdir(), "af-test-backup-"));
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
	});
	after(async () => {
		await stack?.dispose();
		await rm(work, { recursive: true, force: true });
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
		const result = await check(good.manifestPath);
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /passed/);
	});

	it("restore check fails on a flipped byte (checksum)", async () => {
		const copy = await copyBackup("flipped");
		const bytes = await readFile(copy.dumpPath);
		const at = Math.floor(bytes.length / 2);
		bytes.writeUInt8((bytes.readUInt8(at) ^ 0xff) & 0xff, at);
		await writeFile(copy.dumpPath, bytes);
		const result = await check(copy.manifestPath);
		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /checksum mismatch/);
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
		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /pg_restore failed/);
	});

	it("restore check fails when the manifest is missing", async () => {
		const copy = await copyBackup("nomanifest");
		await rm(copy.manifestPath);
		const result = await check(copy.manifestPath);
		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /manifest missing/);
	});

	it("restore check fails when a row count in the manifest differs", async () => {
		const copy = await copyBackup("rowcount");
		const manifest = JSON.parse(await readFile(copy.manifestPath, "utf8")) as Manifest;
		const changed = { ...manifest, rowCounts: { ...manifest.rowCounts, "public.child": 199 } };
		await writeFile(copy.manifestPath, JSON.stringify(changed));
		const result = await check(copy.manifestPath);
		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /public\.child: 199 rows in the backup, 200 after restore/);
	});

	it("restore check leaves no scratch container, volume or network behind", async () => {
		const names = await run("docker", ["ps", "-a", "--format", "{{.Names}}"]);
		assert.equal(/af-test-rc/.test(names.stdout), false);
		const volumes = await run("docker", ["volume", "ls", "--format", "{{.Name}}"]);
		assert.equal(/af-test-rc/.test(volumes.stdout), false);
		const networks = await run("docker", ["network", "ls", "--format", "{{.Name}}"]);
		assert.equal(/af-test-rc/.test(networks.stdout), false);
	});
});
