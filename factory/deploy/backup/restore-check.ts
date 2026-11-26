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
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createSecrets } from "../setup-secrets.ts";
import { MANIFEST_FORMAT, streamDump, type Manifest } from "./backup.ts";
import { DATABASE, FOREIGN_KEYS_SQL, ROW_COUNTS_SQL, execArgs, freePort, newRunId, psql, removeOwned, startStack, type ForeignKey } from "../lib.ts";

// The names a finished backup has (backup.ts): <stamp>-<8 hex>. Only the final manifest counts; a `.partial` is not one.
export const MANIFEST_NAME = /^af-\d{8}T\d{6}Z-[0-9a-f]{8}\.manifest\.json$/;
export const DUMP_NAME = /^af-\d{8}T\d{6}Z-[0-9a-f]{8}\.dump$/;

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
	const dump = value.dump;
	if (!isObject(dump)) problems.push("dump is missing");
	else {
		if (typeof dump.file !== "string" || !DUMP_NAME.test(dump.file)) problems.push("dump.file is not an af-<stamp>-<8 hex>.dump file name");
		if (typeof dump.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(dump.sha256)) problems.push("dump.sha256 is not 64 hex digits");
		if (typeof dump.bytes !== "number" || !Number.isInteger(dump.bytes) || dump.bytes < 0) problems.push("dump.bytes is not a non-negative integer");
	}
	const counts = value.rowCounts;
	if (!isObject(counts)) problems.push("rowCounts is not an object");
	else if (!Object.values(counts).every((count) => typeof count === "number" && Number.isInteger(count) && count >= 0)) {
		problems.push("rowCounts holds a value that is not a non-negative integer");
	}
	if (!Array.isArray(value.foreignKeys)) problems.push("foreignKeys is not an array");
	else if (!value.foreignKeys.every((fk) => isObject(fk) && typeof fk.table === "string" && typeof fk.name === "string" && typeof fk.definition === "string" && typeof fk.validated === "boolean")) {
		problems.push("foreignKeys holds an entry without table, name, definition and validated");
	}
	return problems;
};

export interface VerifiedBackup {
	readonly manifest: Manifest;
	readonly dumpPath: string;
}

// Verifies the files of a backup and returns what restore needs. Rejects with the full list of problems when anything
// is missing or wrong: the manifest (shape and every field), the dump (present, not empty, size and sha256 as the
// manifest says) and the checksum file (required, exactly "<64 hex>  <dump file>\n", with the real sum). An empty dump
// is invalid, so it never passes by being the same as an empty record.
export const verifyBackupFiles = async (manifestPath: string): Promise<VerifiedBackup> => {
	const path = resolve(manifestPath);
	const manifest = await readManifest(path);
	const dumpPath = join(dirname(path), basename(manifest.dump.file));
	const problems: string[] = [];
	let actualSum = "";
	let size = 0;
	try {
		size = (await stat(dumpPath)).size;
		actualSum = await sha256OfFile(dumpPath);
	} catch {
		throw new Error(`dump file missing: ${dumpPath}`);
	}
	if (size === 0) problems.push("the dump file is empty");
	if (manifest.dump.bytes !== size) problems.push(`dump size differs from the manifest: ${size} bytes, the manifest says ${manifest.dump.bytes}`);
	if (manifest.dump.sha256 !== actualSum) problems.push("checksum mismatch: the dump differs from the manifest");
	let sidecar: string | undefined;
	try {
		sidecar = await readFile(`${dumpPath}.sha256`, "utf8");
	} catch {
		problems.push(`checksum file missing: ${dumpPath}.sha256`);
	}
	if (sidecar !== undefined) {
		const match = /^([0-9a-f]{64}) {2}(\S+)\n$/.exec(sidecar);
		if (!match) problems.push("checksum file is malformed: expected '<64 hex digits>  <dump file>' and a newline");
		else {
			if (match[2] !== basename(manifest.dump.file)) problems.push(`checksum file names ${match[2]}, not ${basename(manifest.dump.file)}`);
			if (match[1] !== actualSum) problems.push("checksum mismatch: the dump differs from its .sha256 file");
		}
	}
	if (problems.length > 0) throw new Error(problems.join("; "));
	return { manifest, dumpPath };
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
export const restoreDump = async (container: string, dumpPath: string, expected: DumpDigestExpectation, hooks: RestoreDumpHooks = {}): Promise<string> => {
	const program = `pg_restore --exit-on-error --no-password -U af_bootstrap -d ${DATABASE}`;
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

const keyOf = (fk: ForeignKey): string => `${fk.table}|${fk.name}|${fk.definition}`;

export const compareCatalog = (manifest: Manifest, counts: Record<string, number>, keys: ForeignKey[]): string[] => {
	const problems: string[] = [];
	const tables = new Set([...Object.keys(manifest.rowCounts), ...Object.keys(counts)]);
	for (const table of [...tables].sort()) {
		const expected = manifest.rowCounts[table];
		const actual = counts[table];
		if (expected === undefined) problems.push(`table ${table} exists after restore but not in the manifest`);
		else if (actual === undefined) problems.push(`table ${table} is missing after restore`);
		else if (expected !== actual) problems.push(`table ${table}: ${expected} rows in the backup, ${actual} after restore`);
	}
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
	const { manifest, dumpPath } = verified;

	// A server the caller passes in is theirs to close; otherwise this check starts its own and removes it.
	let own: ScratchServer | undefined;
	try {
		const scratch = options.scratch ?? (own = await startScratch(options.prefix ?? "af-restore-check"));
		await scratch.prepare();
		const restoreError = await restoreDump(scratch.container, dumpPath, manifest.dump, options.hooks);
		if (restoreError) return { ok: false, problems: [restoreError] };
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
	const secretsDir = await mkdtemp(join(tmpdir(), `${prefix}-secrets-`));
	let dirty = false;
	const close = async (): Promise<void> => {
		try {
			await removeOwned(runId);
		} finally {
			await rm(secretsDir, { recursive: true, force: true });
		}
	};
	try {
		createSecrets(secretsDir);
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
	let manifestPath = "";
	let prefix: string | undefined;
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--manifest") manifestPath = argv[++i] ?? "";
		else if (argv[i] === "--prefix") prefix = argv[++i];
		else console.error(`unknown argument: ${argv[i]}`);
	}
	if (!manifestPath) {
		console.error("usage: node deploy/backup/restore-check.ts --manifest <manifest file> [--prefix af-restore-check]");
		process.exitCode = 2;
	} else {
		try {
			const result = await restoreCheck({ manifestPath, prefix });
			if (result.ok) console.log("restore check passed: checksum, row counts and foreign keys match the backup");
			else {
				console.error("restore check FAILED:");
				for (const problem of result.problems) console.error(`  - ${problem}`);
				process.exitCode = 1;
			}
		} catch (error) {
			console.error(`restore check FAILED: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
		}
	}
}
