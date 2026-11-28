// Restore check: proves that a backup can be restored and that the restored database equals what was backed up.
//
//   node deploy/backup/restore-check.ts --manifest <path to af-<stamp>.manifest.json> [--prefix af-restore-check]
//
// Steps: verify the backup files (every completion artifact is required and checked by content); start a scratch server
// (same image, same compose file, own project name, own throw-away secrets, a free loopback port); restore the dump into
// an empty database there; compare the row counts and the foreign keys with the manifest; remove the scratch server
// whatever happened. The scratch server is the one place the superuser is used (over its local socket): it holds no data
// of the real stack. Exits 1 on any difference or error, listing every problem found.
//
// The pieces that restore.ts (the real recovery command) shares with the check live here, so both do the same thing:
// verifyBackupFiles, restoreDump, applyDatabaseGrants and compareCatalog.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { parseCliArgs, reportCliFailure } from "../cli-args.ts";
import { createSecrets } from "../setup-secrets.ts";
import { applyTemporalSql } from "../bootstrap-temporal.ts";
import { TEMPORAL_DATABASES } from "../init-postconditions.ts";
import { MANIFEST_FORMAT, streamDump, type DumpFile, type Manifest } from "./backup.ts";
import { DATABASE, FOREIGN_KEYS_SQL, ROW_COUNTS_SQL, execArgs, freePort, newRunId, psql, removeOwned, startStack, type ForeignKey } from "../lib.ts";
import { OwnedDir } from "../owned.ts";

// The names a finished backup has (backup.ts): <stamp>-<8 hex>. Only the final manifest counts; a `.partial` is not one.
export const MANIFEST_NAME = /^af-\d{8}T\d{6}Z-[0-9a-f]{8}\.manifest\.json$/;
export const DUMP_NAME = /^af-\d{8}T\d{6}Z-[0-9a-f]{8}\.dump$/;
// The dump of one Temporal database of that backup: af-<stamp>-<8 hex>.<database>.dump (backup.ts, temporalDumpFile).
const temporalDumpName = (database: string): RegExp => new RegExp(`^af-\\d{8}T\\d{6}Z-[0-9a-f]{8}\\.${database}\\.dump$`);

export interface RestoreCheckOptions {
	readonly manifestPath: string;
	// Project names of the scratch stack start with this prefix (tests pass an `af-test-` one).
	readonly prefix?: string;
	// A scratch server shared by several checks (one start instead of one per check); the caller closes it.
	readonly scratch?: ScratchServer;
	readonly hooks?: RestoreDumpHooks;
}

export interface RestoreCheckResult {
	readonly ok: boolean;
	readonly problems: string[];
}

const sha256OfFile = async (file: string): Promise<string> => {
	const hash = createHash("sha256");
	await pipeline(createReadStream(file), async (source) => {
		for await (const chunk of source) hash.update(chunk as Buffer);
	});
	return hash.digest("hex");
};

const readManifest = async (path: string): Promise<Manifest> => {
	const name = basename(path);
	if (name.endsWith(".partial")) throw new Error(`manifest is a .partial file, not a completed backup: ${path}`);
	if (!MANIFEST_NAME.test(name)) throw new Error(`manifest is invalid (${path}): its name is not af-<stamp>-<8 hex>.manifest.json`);
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		throw new Error(`manifest missing or unreadable: ${path}`);
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`manifest is not valid JSON: ${path}`);
	}
	const bad = manifestProblems(value);
	if (bad.length > 0) throw new Error(`manifest is invalid (${path}): ${bad.join("; ")}`);
	return value as Manifest;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Every field of the manifest, by content. The problems are listed; an empty list means the manifest is well formed.
export const manifestProblems = (value: unknown): string[] => {
	if (!isObject(value)) return ["not a JSON object"];
	const problems: string[] = [];
	if (value.format !== MANIFEST_FORMAT) problems.push(`format is not ${MANIFEST_FORMAT}`);
	for (const key of ["createdAt", "serverVersion", "image"]) {
		if (typeof value[key] !== "string" || value[key] === "") problems.push(`${key} is not a non-empty string`);
	}
	if (typeof value.createdAt === "string" && Number.isNaN(Date.parse(value.createdAt))) problems.push("createdAt is not a date");
	if (typeof value.serverVersionNum !== "number" || !Number.isFinite(value.serverVersionNum)) problems.push("serverVersionNum is not a number");
	if (value.database !== DATABASE) problems.push(`database is not ${DATABASE}`);
	problems.push(...dumpProblems("dump", value.dump, DUMP_NAME, "af-<stamp>-<8 hex>.dump"));
	problems.push(...countsProblems("rowCounts", value.rowCounts));
	if (!Array.isArray(value.foreignKeys)) problems.push("foreignKeys is not an array");
	else if (!value.foreignKeys.every((fk) => isObject(fk) && typeof fk.table === "string" && typeof fk.name === "string" && typeof fk.definition === "string" && typeof fk.validated === "boolean")) {
		problems.push("foreignKeys holds an entry without table, name, definition and validated");
	}
	// The Temporal part is optional (a server without Temporal has none), but when it is there it is whole: both databases,
	// in the fixed order, each with its dump and row counts.
	if (value.temporal !== undefined) {
		const temporal = value.temporal;
		if (!isObject(temporal) || !Array.isArray(temporal.databases)) problems.push("temporal.databases is not an array");
		else if (temporal.databases.length !== TEMPORAL_DATABASES.length) problems.push(`temporal.databases does not hold exactly ${TEMPORAL_DATABASES.join(", ")}`);
		else {
			TEMPORAL_DATABASES.forEach((database, index) => {
				const entry = (temporal.databases as unknown[])[index];
				if (!isObject(entry) || entry.database !== database) problems.push(`temporal.databases[${index}] is not ${database}`);
				else {
					problems.push(...dumpProblems(`temporal ${database} dump`, entry.dump, temporalDumpName(database), `af-<stamp>-<8 hex>.${database}.dump`));
					problems.push(...countsProblems(`temporal ${database} rowCounts`, entry.rowCounts));
				}
			});
		}
	}
	return problems;
};

const dumpProblems = (label: string, dump: unknown, namePattern: RegExp, nameText: string): string[] => {
	if (!isObject(dump)) return [`${label} is missing`];
	const problems: string[] = [];
	if (typeof dump.file !== "string" || !namePattern.test(dump.file)) problems.push(`${label}.file is not an ${nameText} file name`);
	if (typeof dump.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(dump.sha256)) problems.push(`${label}.sha256 is not 64 hex digits`);
	if (typeof dump.bytes !== "number" || !Number.isInteger(dump.bytes) || dump.bytes < 0) problems.push(`${label}.bytes is not a non-negative integer`);
	return problems;
};

const countsProblems = (label: string, counts: unknown): string[] => {
	if (!isObject(counts)) return [`${label} is not an object`];
	if (!Object.values(counts).every((count) => typeof count === "number" && Number.isInteger(count) && count >= 0)) return [`${label} holds a value that is not a non-negative integer`];
	return [];
};

export interface TemporalDumpPath {
	readonly database: string;
	readonly path: string;
	readonly dump: DumpFile;
}

export interface VerifiedBackup {
	readonly manifest: Manifest;
	readonly dumpPath: string;
	// Empty when the backup holds no Temporal section.
	readonly temporalDumps: readonly TemporalDumpPath[];
}

// The problems of one dump file against its manifest entry: not empty, size and sha256 as the manifest says, and the
// checksum file (required, exactly "<64 hex>  <dump file>\n", with the real sum). `label` is "" for the main dump and
// "<database> " for a Temporal one. Throws "dump file missing" when the file cannot be read at all.
const dumpFileProblems = async (dumpPath: string, dump: DumpFile, label: string): Promise<string[]> => {
	const problems: string[] = [];
	let actualSum = "";
	let size = 0;
	try {
		size = (await stat(dumpPath)).size;
		actualSum = await sha256OfFile(dumpPath);
	} catch {
		throw new Error(`${label}dump file missing: ${dumpPath}`);
	}
	if (size === 0) problems.push(`the ${label}dump file is empty`);
	if (dump.bytes !== size) problems.push(`${label}dump size differs from the manifest: ${size} bytes, the manifest says ${dump.bytes}`);
	if (dump.sha256 !== actualSum) problems.push(`checksum mismatch: the ${label}dump differs from the manifest`);
	let sidecar: string | undefined;
	try {
		sidecar = await readFile(`${dumpPath}.sha256`, "utf8");
	} catch {
		problems.push(`${label}checksum file missing: ${dumpPath}.sha256`);
	}
	if (sidecar !== undefined) {
		const match = /^([0-9a-f]{64}) {2}(\S+)\n$/.exec(sidecar);
		if (!match) problems.push(`${label}checksum file is malformed: expected '<64 hex digits>  <dump file>' and a newline`);
		else {
			if (match[2] !== basename(dump.file)) problems.push(`${label}checksum file names ${match[2]}, not ${basename(dump.file)}`);
			if (match[1] !== actualSum) problems.push(`checksum mismatch: the ${label}dump differs from its .sha256 file`);
		}
	}
	return problems;
};

// Verifies the files of a backup and returns what restore needs. Rejects with the full list of problems when anything
// is missing or wrong: the manifest (shape and every field), the dump (present, not empty, size and sha256 as the
// manifest says) and the checksum file (required, exactly "<64 hex>  <dump file>\n", with the real sum), and the same
// for each Temporal dump the manifest names. An empty dump is invalid, so it never passes by being the same as an empty
// record. A missing main dump throws at once; a missing Temporal dump is one more problem in the list.
export const verifyBackupFiles = async (manifestPath: string): Promise<VerifiedBackup> => {
	const path = resolve(manifestPath);
	const manifest = await readManifest(path);
	const dumpPath = join(dirname(path), basename(manifest.dump.file));
	const problems = await dumpFileProblems(dumpPath, manifest.dump, "");
	const temporalDumps: TemporalDumpPath[] = [];
	for (const entry of manifest.temporal?.databases ?? []) {
		const temporalPath = join(dirname(path), basename(entry.dump.file));
		try {
			problems.push(...(await dumpFileProblems(temporalPath, entry.dump, `${entry.database} `)));
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
		}
		temporalDumps.push({ database: entry.database, path: temporalPath, dump: entry.dump });
	}
	if (problems.length > 0) throw new Error(problems.join("; "));
	return { manifest, dumpPath, temporalDumps };
};

export interface DumpDigestExpectation {
	readonly sha256: string;
	readonly bytes: number;
}

export interface RestoreDumpHooks {
	// Called right before the dump file is opened for the feed (tests change the file here, after it was verified).
	readonly beforeFeed?: () => Promise<void>;
}

// Streams the dump into pg_restore inside the container (stream pipeline: backpressure, and an error on either side
// ends both) and hashes THE BYTES THAT pg_restore CONSUMES while they pass. The restore counts only when those bytes are
// the ones the manifest names: a file that changed after verifyBackupFiles read it is caught here, because the check
// is on what was consumed, not on an earlier read of the same path. Resolves with an error text ("" on success).
export const restoreDump = async (container: string, dumpPath: string, expected: DumpDigestExpectation, hooks: RestoreDumpHooks = {}, database: string = DATABASE): Promise<string> => {
	const program = `pg_restore --exit-on-error --no-password -U af_bootstrap -d ${database}`;
	await hooks.beforeFeed?.();
	const child = spawn("docker", execArgs(container, "af_bootstrap", program), { stdio: ["pipe", "ignore", "pipe"] });
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const exit = new Promise<number | null>((resolvePromise, reject) => {
		child.on("error", reject);
		child.on("close", resolvePromise);
	});
	exit.catch(() => {});
	const [fed, code] = await Promise.allSettled([streamDump(createReadStream(dumpPath), child.stdin), exit]);
	if (code.status === "rejected") return `pg_restore could not run: ${code.reason instanceof Error ? code.reason.message : String(code.reason)}`;
	if (fed.status === "fulfilled" && (fed.value.sha256 !== expected.sha256 || fed.value.bytes !== expected.bytes)) {
		return `checksum mismatch: the dump changed after it was verified (pg_restore consumed ${fed.value.bytes} bytes with sha256 ${fed.value.sha256}, the manifest says ${expected.bytes} bytes and ${expected.sha256})`;
	}
	if (code.value !== 0) return `pg_restore failed (exit ${code.value}): ${stderr.trim()}`;
	if (fed.status === "rejected") return `the dump could not be fed to pg_restore: ${fed.reason instanceof Error ? fed.reason.message : String(fed.reason)}`;
	return "";
};

// The database-level rights that a dump does not carry (it holds neither CREATE DATABASE nor the database's own ACL),
// exactly as init gives them (postgres/init/10-roles.sh); the schema and default-privilege lines are repeated because
// they are idempotent and keep the result the same whatever the dump held.
//
// The two statement groups touch different databases (the connect right lives in `postgres`, the schema rights in the
// application database) and do not depend on each other, so they run side by side.
export const applyDatabaseGrants = async (container: string): Promise<void> => {
	await Promise.all([
		psql(container, "af_bootstrap", [
			`REVOKE ALL ON DATABASE ${DATABASE} FROM PUBLIC;`,
			`GRANT CONNECT ON DATABASE ${DATABASE} TO af_api, af_control, af_backup, af_reader;`,
		].join("\n"), { database: "postgres" }),
		psql(container, "af_bootstrap", [
			"REVOKE CREATE ON SCHEMA public FROM PUBLIC;",
			"GRANT USAGE ON SCHEMA public TO af_api, af_control, af_backup, af_reader;",
			"ALTER DEFAULT PRIVILEGES FOR ROLE af_migrator IN SCHEMA public GRANT SELECT ON TABLES TO af_backup;",
			"ALTER DEFAULT PRIVILEGES FOR ROLE af_migrator IN SCHEMA public GRANT SELECT ON SEQUENCES TO af_backup;",
		].join("\n")),
	]);
};

// Restores each Temporal dump into its database (made by init, owned by af_temporal; the dump carries the ownership of
// its objects). Resolves with the first error text, "" when all went through.
export const restoreTemporalDumps = async (container: string, dumps: readonly TemporalDumpPath[], hooks: RestoreDumpHooks = {}): Promise<string> => {
	for (const entry of dumps) {
		const error = await restoreDump(container, entry.path, entry.dump, hooks, entry.database);
		if (error) return `${entry.database}: ${error}`;
	}
	return "";
};

const keyOf = (fk: ForeignKey): string => `${fk.table}|${fk.name}|${fk.definition}`;

// Row counts of one database against the manifest's; `label` prefixes each problem ("" for the application database).
const compareRowCounts = (expectedCounts: Record<string, number>, counts: Record<string, number>, label: string): string[] => {
	const problems: string[] = [];
	const tables = new Set([...Object.keys(expectedCounts), ...Object.keys(counts)]);
	for (const table of [...tables].sort()) {
		const expected = expectedCounts[table];
		const actual = counts[table];
		if (expected === undefined) problems.push(`${label}table ${table} exists after restore but not in the manifest`);
		else if (actual === undefined) problems.push(`${label}table ${table} is missing after restore`);
		else if (expected !== actual) problems.push(`${label}table ${table}: ${expected} rows in the backup, ${actual} after restore`);
	}
	return problems;
};

export const compareCatalog = (manifest: Manifest, counts: Record<string, number>, keys: ForeignKey[]): string[] => {
	const problems = compareRowCounts(manifest.rowCounts, counts, "");
	const expectedKeys = new Set(manifest.foreignKeys.map(keyOf));
	const actualKeys = new Set(keys.map(keyOf));
	for (const key of expectedKeys) if (!actualKeys.has(key)) problems.push(`foreign key missing after restore: ${key}`);
	for (const key of actualKeys) if (!expectedKeys.has(key)) problems.push(`foreign key not in the manifest: ${key}`);
	for (const fk of keys) if (!fk.validated) problems.push(`foreign key not validated after restore: ${fk.table} ${fk.name}`);
	return problems;
};

// Compares a restored database (read as the superuser over the socket) with the manifest.
export const compareRestored = async (container: string, manifest: Manifest): Promise<string[]> => {
	const problems: string[] = [];
	const major = (versionNum: number): number => Math.floor(versionNum / 10_000);
	// Three independent reads of the restored database: asked side by side, not one after another.
	const [versionText, countsText, keysText] = await Promise.all([
		psql(container, "af_bootstrap", "SELECT current_setting('server_version_num');"),
		psql(container, "af_bootstrap", ROW_COUNTS_SQL),
		psql(container, "af_bootstrap", FOREIGN_KEYS_SQL),
	]);
	const restoredNum = Number(versionText);
	if (major(restoredNum) !== major(manifest.serverVersionNum)) {
		problems.push(`server major version differs: backup ${manifest.serverVersion}, scratch ${restoredNum}`);
	}
	const counts = JSON.parse(countsText) as Record<string, number>;
	const keys = JSON.parse(keysText) as ForeignKey[];
	problems.push(...compareCatalog(manifest, counts, keys));
	problems.push(...(await compareTemporalRestored(container, manifest)));
	return problems;
};

// The Temporal databases of a restored server against the manifest's row counts (read as the superuser over the socket).
// Nothing to compare when the backup has no Temporal section. A Temporal database that has data the manifest does not
// know, or lost a table it names, is a problem like in the application database.
export const compareTemporalRestored = async (container: string, manifest: Manifest): Promise<string[]> => {
	const problems: string[] = [];
	for (const entry of manifest.temporal?.databases ?? []) {
		const countsText = await psql(container, "af_bootstrap", ROW_COUNTS_SQL, { database: entry.database });
		problems.push(...compareRowCounts(entry.rowCounts, JSON.parse(countsText) as Record<string, number>, `${entry.database}: `));
	}
	return problems;
};

export const restoreCheck = async (options: RestoreCheckOptions): Promise<RestoreCheckResult> => {
	let verified: VerifiedBackup;
	try {
		verified = await verifyBackupFiles(options.manifestPath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/^manifest (missing|is )/.test(message) || message.startsWith("dump file missing")) throw error;
		return { ok: false, problems: message.split("; ") };
	}
	const { manifest, dumpPath, temporalDumps } = verified;

	// A server the caller passes in is theirs to close; otherwise this check starts its own and removes it.
	let own: ScratchServer | undefined;
	try {
		const scratch = options.scratch ?? (own = await startScratch(options.prefix ?? "af-restore-check"));
		await scratch.prepare();
		const restoreError = await restoreDump(scratch.container, dumpPath, manifest.dump, options.hooks);
		if (restoreError) return { ok: false, problems: [restoreError] };
		const temporalError = await restoreTemporalDumps(scratch.container, temporalDumps, options.hooks);
		if (temporalError) return { ok: false, problems: [temporalError] };
		await applyDatabaseGrants(scratch.container);
		const problems = await compareRestored(scratch.container, manifest);
		return { ok: problems.length === 0, problems };
	} catch (error) {
		return { ok: false, problems: [error instanceof Error ? error.message : String(error)] };
	} finally {
		if (own) await own.close();
	}
};

// A throw-away server this process started itself (own run id, own labels, own secrets). Because the run id proves it is
// ours and it holds nothing of any real stack, it may be emptied again between checks: prepare() gives the next restore
// the same empty, init-made database the first one had.
export interface ScratchServer {
	readonly container: string;
	readonly project: string;
	readonly runId: string;
	prepare(): Promise<void>;
	close(): Promise<void>;
}

export const startScratch = async (prefix: string): Promise<ScratchServer> => {
	const runId = newRunId();
	const project = `${prefix}-${runId}`;
	// A private directory (mkdtemp) whose identity is recorded; the secret files createSecrets writes into it are recorded
	// right after it ran, and cleanup removes exactly those, each by identity, never the whole tree by path.
	const secrets = await OwnedDir.make(tmpdir(), `${prefix}-secrets-`);
	const secretsDir = secrets.path;
	let dirty = false;
	let recorded = false;
	const close = async (): Promise<void> => {
		let failure: unknown;
		try {
			await removeOwned(runId);
		} catch (error) {
			failure = error;
		}
		// createSecrets failed halfway: what it wrote so far is still only this run's, in this private directory.
		if (!recorded) await secrets.adoptChildren();
		const problems = await secrets.remove();
		if (failure !== undefined) throw failure;
		if (problems.length > 0) throw new Error(`secrets directory cleanup left: ${problems.join("; ")}`);
	};
	try {
		createSecrets(secretsDir);
		await secrets.adoptChildren();
		recorded = true;
		const container = await startStack({ project, secretsDir, port: await freePort(), runId });
		return {
			container,
			project,
			runId,
			close,
			prepare: async () => {
				if (dirty) {
					await psql(container, "af_bootstrap", `DROP DATABASE ${DATABASE} WITH (FORCE); CREATE DATABASE ${DATABASE} OWNER af_migrator;`, { database: "postgres" });
					await psql(container, "af_bootstrap", "CREATE EXTENSION vector;");
					// The Temporal databases are emptied the same way: dropped, then made again by the one file init runs.
					await psql(container, "af_bootstrap", TEMPORAL_DATABASES.map((database) => `DROP DATABASE IF EXISTS ${database} WITH (FORCE);`).join(" "), { database: "postgres" });
					await applyTemporalSql(container);
				}
				dirty = true;
			},
		};
	} catch (error) {
		await close();
		throw error;
	}
};

if (import.meta.main) {
	const usage = "usage: node deploy/backup/restore-check.ts --manifest <manifest file> [--prefix af-restore-check]";
	try {
		const { values } = parseCliArgs(process.argv.slice(2), { flags: { "--manifest": "value", "--prefix": "value" }, required: ["--manifest"] });
		const result = await restoreCheck({ manifestPath: values["--manifest"] as string, prefix: values["--prefix"] });
		if (result.ok) console.log("restore check passed: checksum, row counts and foreign keys match the backup (the Temporal databases too, when it holds them)");
		else {
			console.error("restore check FAILED:");
			for (const problem of result.problems) console.error(`  - ${problem}`);
			process.exitCode = 1;
		}
	} catch (error) {
		reportCliFailure(error, "restore check FAILED", usage);
	}
}
