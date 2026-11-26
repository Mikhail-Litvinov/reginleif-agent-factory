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
// meet. The run first makes a private staging directory <target>/.af-staging-<random> (mkdtemp, so it is new) and
// writes every file there, created exclusively. A file is then published to its final name by hard link, which fails
// (EEXIST) instead of overwriting, in this order, so that a crash or a failure leaves no file that looks complete:
//   <name>.dump          -> pg_dump output, published after pg_dump succeeded
//   <name>.dump.sha256   -> "<hex>  <name>.dump"
//   <name>.manifest.json -> published last: its presence marks a finished backup
// Cleanup acts on identity, not on names (../owned.ts): the run records the identity (device and file index) of the
// staging directory and of every file it creates, a published name carries the identity of the staged file it was
// linked from, and cleanup removes only a path that still holds a recorded identity. A name that another run created
// meanwhile, even under this run's own name, is left alone. The staging directory is removed without recursion, so a
// directory that holds something this run did not create stays, with that thing, and is reported.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DATABASE, FOREIGN_KEYS_SQL, PsqlSession, ROW_COUNTS_SQL, execArgs, findContainer, realClock, runChecked, waitHealthy, type Clock, type ForeignKey } from "../lib.ts";
import { OwnedDir, OwnedFiles } from "../owned.ts";

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
	// Test hook: runs right after the dump is published, with the staging directory, to let a test play another run
	// that takes one of the remaining names or writes into the staging directory.
	readonly hooks?: { readonly afterDumpPublished?: (stagingDir: string) => Promise<void> };
}

export interface BackupResult {
	readonly manifestPath: string;
	readonly dumpPath: string;
	readonly manifest: Manifest;
	// Problems of the cleanup after a finished run (the backup itself is complete); empty normally.
	readonly leftovers: readonly string[];
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

const closed = (stream: Writable): Promise<void> => (stream.closed ? Promise.resolve() : new Promise((done) => stream.once("close", () => done())));

// Writes a running pg_dump's standard output to `file`, created exclusively through `owned` (a private record when the
// caller passes none). Resolves with the digest only when the whole output reached the file and the process exited 0;
// the file then stays: with the caller's `owned` it stays recorded there (the caller publishes or removes it), with the
// private record it is released and is the caller's file. On any failure (write error, process death, non-zero exit,
// empty output) the process is killed, the file handle is closed and the file this call created is removed, only if
// the path still holds the file that was created; then the error is thrown. A file that existed before is refused
// (EEXIST) and never removed.
export const captureDump = async (child: ChildProcessByStdio<null, Readable, Readable>, file: string, owned?: OwnedFiles): Promise<DumpDigest> => {
	const record = owned ?? new OwnedFiles();
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
	let sink: Writable | undefined;
	try {
		const handle = await record.create(file);
		created = true;
		sink = handle.createWriteStream();
		const [digest, code] = await Promise.all([streamDump(child.stdout, sink), exit]);
		if (code !== 0) throw new Error(`pg_dump failed (exit ${code}): ${stderr.trim()}`);
		if (digest.bytes === 0) throw new Error("pg_dump produced no output");
		await closed(sink); // the handle is closed before anyone links or removes the file
		if (!owned) record.release(file);
		return digest;
	} catch (error) {
		child.kill();
		let removal = "";
		if (created) {
			sink?.destroy();
			if (sink) await closed(sink);
			try {
				await record.remove(file);
			} catch (removeError) {
				removal = `; the partial file was not removed: ${removeError instanceof Error ? removeError.message : String(removeError)}`;
			}
		}
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`${stderr.trim() && !reason.includes(stderr.trim()) ? `${reason} (${stderr.trim()})` : reason}${removal}`, { cause: error });
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

// Creates `path` exclusively through `owned` and writes `text` to it.
const writeStaged = async (owned: OwnedFiles, path: string, text: string): Promise<void> => {
	const handle = await owned.create(path);
	try {
		await handle.writeFile(text);
	} finally {
		await handle.close();
	}
};

export const backup = async (options: BackupOptions): Promise<BackupResult> => {
	if (!options.target) throw new Error("the target directory is required");
	const target = resolve(options.target);
	await mkdir(target, { recursive: true });
	const container = await findContainer(options.project);
	await waitHealthy(container, options.healthTimeoutMs ?? 60_000, { clock: options.clock ?? realClock });
	const image = (await runChecked("docker", ["inspect", "--format", "{{.Config.Image}}", container])).trim();

	const name = (options.nameFor ?? uniqueName)();
	const dumpPath = join(target, `${name}.dump`);
	const sumPath = join(target, `${name}.dump.sha256`);
	const manifestPath = join(target, `${name}.manifest.json`);
	// The run's private staging directory: everything is written here first and published by link, so the identity of
	// every file this run owns is recorded at creation (see ../owned.ts) and the cleanup below acts on those identities
	// only, never on a path that merely carries this run's name.
	const staging = await OwnedDir.make(target, ".af-staging-");
	const stagedDump = join(staging.path, "dump");
	const stagedSum = join(staging.path, "sha256");
	const stagedManifest = join(staging.path, "manifest");

	let session: PsqlSession | undefined;
	let result: BackupResult | undefined;
	let failure: { readonly error: unknown } | undefined;
	try {
		session = new PsqlSession(container, "af_backup");
		session.execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;");
		const snapshot = await session.query("SELECT pg_export_snapshot();");
		const version = await session.query("SELECT current_setting('server_version') || '|' || current_setting('server_version_num');");
		const [serverVersion, serverVersionNum] = version.split("|") as [string, string];
		const rowCounts = JSON.parse(await session.query(ROW_COUNTS_SQL)) as Record<string, number>;
		const foreignKeys = JSON.parse(await session.query(FOREIGN_KEYS_SQL)) as ForeignKey[];

		const dumped = await captureDump(dumpProcess(container, snapshot), stagedDump, staging.files);
		// link, not rename: a rename silently replaces a file that already has the name; link fails with EEXIST.
		await staging.files.publish(stagedDump, dumpPath);
		await options.hooks?.afterDumpPublished?.(staging.path);
		await writeStaged(staging.files, stagedSum, `${dumped.sha256}  ${name}.dump\n`);
		await staging.files.publish(stagedSum, sumPath);
		const manifest: Manifest = {
			format: MANIFEST_FORMAT,
			createdAt: new Date().toISOString(),
			serverVersion,
			serverVersionNum: Number(serverVersionNum),
			image,
			database: DATABASE,
			dump: { file: `${name}.dump`, sha256: dumped.sha256, bytes: dumped.bytes },
			rowCounts,
			foreignKeys,
		};
		await writeStaged(staging.files, stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`);
		// The manifest is published last: its presence marks a finished backup.
		await staging.files.publish(stagedManifest, manifestPath);
		result = { manifestPath, dumpPath, manifest, leftovers: [] };
	} catch (error) {
		failure = { error };
	}

	const leftovers: string[] = [];
	if (session) {
		try {
			await session.close();
		} catch (error) {
			leftovers.push(`the psql session did not close: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	// A finished run keeps its three published names; every other name it recorded, and the staging directory, go.
	// A failed run removes the published names too, each only if it still is the file this run linked there.
	if (result) for (const path of [dumpPath, sumPath, manifestPath]) staging.files.release(path);
	try {
		leftovers.push(...(await staging.remove()));
	} catch (error) {
		leftovers.push(`staging cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (failure) {
		const reason = failure.error instanceof Error ? failure.error.message : String(failure.error);
		if (leftovers.length === 0) throw failure.error;
		throw new Error(`${reason}; cleanup left: ${leftovers.join("; ")}`, { cause: failure.error });
	}
	return { ...(result as BackupResult), leftovers };
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
		for (const leftover of result.leftovers) console.error(`warning: cleanup left: ${leftover}`);
	} catch (error) {
		console.error(`backup failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
