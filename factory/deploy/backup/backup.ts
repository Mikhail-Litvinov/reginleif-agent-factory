// Backup of the Agent Factory database.
//
//   node deploy/backup/backup.ts --target <directory> [--project agent-factory]
//
// Reads through the least-privileged account af_backup (select on tables and sequences, nothing else), never the
// superuser. One REPEATABLE READ snapshot is exported by a psql session that stays open; the row counts and the foreign
// keys are read in that session and pg_dump reads the same snapshot (--snapshot), so the manifest describes the dump
// exactly even while the application writes. The backup first waits (bounded) until the server is healthy.
//
// Files. The name is af-<UTC stamp>-<8 random hex digits>, so two runs in one directory (also at the same second) never
// meet. Every file is created exclusively (an existing file is an error, never overwritten) and the files are written
// in this order, so that a crash or a failure leaves no file that looks complete (a failed run removes its own files):
//   <name>.dump.partial  -> pg_dump output; linked to <name>.dump after pg_dump succeeded (fails if that exists)
//   <name>.dump.sha256   -> "<hex>  <name>.dump"
//   <name>.manifest.json -> written last (temporary name, then linked to its final name): its presence marks a finished backup
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { open, link, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DATABASE, FOREIGN_KEYS_SQL, PsqlSession, ROW_COUNTS_SQL, execArgs, findContainer, realClock, runChecked, waitHealthy, type Clock, type ForeignKey } from "../lib.ts";

export const MANIFEST_FORMAT = "agent-factory-backup-1";

export interface Manifest {
	readonly format: string;
	readonly createdAt: string;
	readonly serverVersion: string;
	readonly serverVersionNum: number;
	readonly image: string;
	readonly database: string;
	readonly dump: { readonly file: string; readonly sha256: string; readonly bytes: number };
	readonly rowCounts: Record<string, number>;
	readonly foreignKeys: ForeignKey[];
}

export interface BackupOptions {
	readonly project: string;
	readonly target: string;
	// Time source of the wait for a healthy server (tests inject a fake one).
	readonly clock?: Clock;
	// How long to wait for a healthy server before giving up (default one minute).
	readonly healthTimeoutMs?: number;
	// Test hook: the base name of the run's files (default: a fresh unique name), to force a collision on purpose.
	readonly nameFor?: () => string;
}

export interface BackupResult {
	readonly manifestPath: string;
	readonly dumpPath: string;
	readonly manifest: Manifest;
}

const stamp = (date: Date): string => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

export interface DumpDigest {
	readonly sha256: string;
	readonly bytes: number;
}

// Streams `source` into `sink` with backpressure (stream pipeline) while counting and hashing the bytes. A failure of
// either side rejects and destroys both, so nothing is left half open.
export const streamDump = async (source: Readable, sink: Writable): Promise<DumpDigest> => {
	const hash = createHash("sha256");
	let bytes = 0;
	const meter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			hash.update(chunk);
			bytes += chunk.length;
			callback(null, chunk);
		},
	});
	await pipeline(source, meter, sink);
	return { sha256: hash.digest("hex"), bytes };
};

// Writes a running pg_dump's standard output to `file`, created exclusively. Resolves with the digest only when the
// whole output reached the file and the process exited 0; on any failure (write error, process death, non-zero exit,
// empty output) the process is killed and the file this call created is removed, then the error is thrown.
export const captureDump = async (child: ChildProcessByStdio<null, Readable, Readable>, file: string): Promise<DumpDigest> => {
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const exit = new Promise<number | null>((resolvePromise, reject) => {
		child.on("error", reject);
		child.on("close", resolvePromise);
	});
	exit.catch(() => {});
	let created = false;
	try {
		const handle = await open(file, "wx");
		created = true;
		const [digest, code] = await Promise.all([streamDump(child.stdout, handle.createWriteStream()), exit]);
		if (code !== 0) throw new Error(`pg_dump failed (exit ${code}): ${stderr.trim()}`);
		if (digest.bytes === 0) throw new Error("pg_dump produced no output");
		return digest;
	} catch (error) {
		child.kill();
		if (created) await rm(file, { force: true });
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(stderr.trim() && !reason.includes(stderr.trim()) ? `${reason} (${stderr.trim()})` : reason, { cause: error });
	}
};

const dumpProcess = (container: string, snapshot: string): ChildProcessByStdio<null, Readable, Readable> => {
	if (!/^[0-9A-F-]+$/.test(snapshot)) throw new Error("unexpected snapshot id");
	const program = `pg_dump -Fc --snapshot=${snapshot} -U af_backup -d ${DATABASE}`;
	return spawn("docker", execArgs(container, "af_backup", program), { stdio: ["ignore", "pipe", "pipe"] });
};

// A name that is unique per run: the UTC second plus 32 random bits. Exclusive creation of every file backs it up: a
// name that does exist already fails the run instead of overwriting.
const uniqueName = (): string => `af-${stamp(new Date())}-${randomBytes(4).toString("hex")}`;

export const backup = async (options: BackupOptions): Promise<BackupResult> => {
	if (!options.target) throw new Error("the target directory is required");
	const target = resolve(options.target);
	await mkdir(target, { recursive: true });
	const container = await findContainer(options.project);
	await waitHealthy(container, options.healthTimeoutMs ?? 60_000, { clock: options.clock ?? realClock });
	const image = (await runChecked("docker", ["inspect", "--format", "{{.Config.Image}}", container])).trim();

	const name = (options.nameFor ?? uniqueName)();
	const partial = join(target, `${name}.dump.partial`);
	const dumpPath = join(target, `${name}.dump`);
	const sumPath = join(target, `${name}.dump.sha256`);
	const manifestPath = join(target, `${name}.manifest.json`);
	const manifestTemp = `${manifestPath}.partial`;
	// Files this run created (each is recorded right after its exclusive creation succeeded): a failed run removes
	// exactly these and never a file that belongs to someone else.
	const mine: string[] = [];
	let finished = false;

	let session: PsqlSession | undefined;
	try {
		session = new PsqlSession(container, "af_backup");
		session.execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;");
		const snapshot = await session.query("SELECT pg_export_snapshot();");
		const version = await session.query("SELECT current_setting('server_version') || '|' || current_setting('server_version_num');");
		const [serverVersion, serverVersionNum] = version.split("|") as [string, string];
		const rowCounts = JSON.parse(await session.query(ROW_COUNTS_SQL)) as Record<string, number>;
		const foreignKeys = JSON.parse(await session.query(FOREIGN_KEYS_SQL)) as ForeignKey[];

		const dumped = await captureDump(dumpProcess(container, snapshot), partial);
		mine.push(partial);
		await link(partial, dumpPath);
		mine.push(dumpPath);
		await rm(partial);
		await writeFile(sumPath, `${dumped.sha256}  ${name}.dump\n`, { flag: "wx" });
		mine.push(sumPath);
		const manifest: Manifest = {
			format: MANIFEST_FORMAT,
			createdAt: new Date().toISOString(),
			serverVersion,
			serverVersionNum: Number(serverVersionNum),
			image,
			database: DATABASE,
			dump: { file: `${name}.dump`, sha256: dumped.sha256, bytes: (await stat(dumpPath)).size },
			rowCounts,
			foreignKeys,
		};
		await writeFile(manifestTemp, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
		mine.push(manifestTemp);
		// link, not rename: a rename silently replaces a manifest that already has this name; link fails with EEXIST.
		await link(manifestTemp, manifestPath);
		mine.push(manifestPath);
		await rm(manifestTemp);
		finished = true;
		return { manifestPath, dumpPath, manifest };
	} finally {
		if (session) await session.close();
		if (!finished) for (const file of mine) await rm(file, { force: true });
	}
};

const parseArgs = (argv: string[]): BackupOptions => {
	let project = "agent-factory";
	let target = "";
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		if (flag === "--target") target = argv[++i] ?? "";
		else if (flag === "--project") project = argv[++i] ?? "";
		else throw new Error(`unknown argument: ${flag}`);
	}
	if (!target) throw new Error("usage: node deploy/backup/backup.ts --target <directory> [--project agent-factory]");
	return { project, target };
};

if (import.meta.main) {
	try {
		const result = await backup(parseArgs(process.argv.slice(2)));
		const tables = Object.keys(result.manifest.rowCounts).length;
		console.log(`backup written: ${result.manifestPath}`);
		console.log(`dump: ${result.dumpPath} (${result.manifest.dump.bytes} bytes, sha256 ${result.manifest.dump.sha256}); ${tables} tables counted`);
	} catch (error) {
		console.error(`backup failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
