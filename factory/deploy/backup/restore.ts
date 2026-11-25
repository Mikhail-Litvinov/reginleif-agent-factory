// Recovery: restores a backup into a NEW compose project (a new volume) beside the old one, proves the result with the
// same comparisons as the restore check, and only then reports it ready to be switched to.
//
//   node deploy/backup/restore.ts --manifest <af-<stamp>.manifest.json> --secrets <secrets dir>
//        [--project agent-factory-restored] [--port <free port>]
//
// The old stack and its volume are never touched: this command does not stop, change or remove them, so a failed
// recovery loses nothing. It refuses (exit 1, nothing changed) when the target database already holds any object of its
// own: it fills an empty database and never overwrites data. If it created the project itself and the restore or the
// verification fails, it removes that project (its containers and volume); a project that existed before is left as it
// was. After success a person switches over (docs/agent-factory/recovery.md): stop the old stack, start the new
// project on the real port, and remove the old volume only when satisfied.
//
// Passwords: the secrets directory holds them as files; they reach the server only through its secret mounts and
// passfiles in the container (lib.ts), never an environment variable or a command line.
import { resolve } from "node:path";
import {
	applyDatabaseGrants,
	compareRestored,
	recreateDatabase,
	restoreDump,
	verifyBackupFiles,
} from "./restore-check.ts";
import { DATABASE, freePort, psql, removeStack, runChecked, startStack, type StackOptions } from "../lib.ts";

export interface RestoreOptions {
	readonly manifestPath: string;
	readonly secretsDir: string;
	readonly project: string;
	// Loopback port of the new server; a free one when omitted.
	readonly port?: number;
}

export interface RestoreResult {
	readonly ok: boolean;
	readonly problems: string[];
	readonly project: string;
	readonly port: number;
}

// Objects of the database's own (tables, views, sequences, indexes, ...) outside the system schemas and extensions.
const OWN_OBJECTS_SQL = [
	"select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace",
	"where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'",
	"and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e');",
].join(" ");

const projectExists = async (project: string): Promise<boolean> =>
	(await runChecked("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`])).trim() !== "";

export const restore = async (options: RestoreOptions): Promise<RestoreResult> => {
	const port = options.port ?? (await freePort());
	const fail = (problems: string[]): RestoreResult => ({ ok: false, problems, project: options.project, port });
	let verified;
	try {
		verified = await verifyBackupFiles(options.manifestPath);
	} catch (error) {
		return fail([error instanceof Error ? error.message : String(error)]);
	}

	const stack: StackOptions = { project: options.project, secretsDir: resolve(options.secretsDir), port };
	const existed = await projectExists(options.project);
	let created = false;
	try {
		created = !existed;
		const container = await startStack(stack);
		const own = Number(await psql(container, "af_bootstrap", OWN_OBJECTS_SQL));
		if (own > 0) {
			// Refuse before anything is dropped; the project (new or not) is left as found, but one that this call
			// just created from nothing cannot hold data, so it cannot get here.
			created = false;
			return fail([`refused: database ${DATABASE} in project ${options.project} already holds ${own} object(s); restore fills an empty database only`]);
		}
		await recreateDatabase(container);
		const restoreError = await restoreDump(container, verified.dumpPath);
		if (restoreError) throw new Error(restoreError);
		await applyDatabaseGrants(container);
		const problems = await compareRestored(container, verified.manifest);
		if (problems.length > 0) throw new Error(problems.join("; "));
		created = false;
		return { ok: true, problems: [], project: options.project, port };
	} catch (error) {
		return fail([error instanceof Error ? error.message : String(error)]);
	} finally {
		if (created) await removeStack(stack);
	}
};

if (import.meta.main) {
	let manifestPath = "";
	let secretsDir = "";
	let project = "agent-factory-restored";
	let port: number | undefined;
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === "--manifest") manifestPath = argv[++i] ?? "";
		else if (argv[i] === "--secrets") secretsDir = argv[++i] ?? "";
		else if (argv[i] === "--project") project = argv[++i] ?? project;
		else if (argv[i] === "--port") port = Number(argv[++i]);
		else console.error(`unknown argument: ${argv[i]}`);
	}
	if (!manifestPath || !secretsDir || (port !== undefined && !Number.isInteger(port))) {
		console.error("usage: node deploy/backup/restore.ts --manifest <manifest file> --secrets <secrets dir> [--project <name>] [--port <port>]");
		process.exitCode = 2;
	} else {
		const result = await restore({ manifestPath, secretsDir, project, port });
		if (result.ok) {
			console.log(`restored and verified in project ${result.project} (loopback port ${result.port}); the old stack was not touched`);
		} else {
			console.error("restore FAILED, the old stack was not touched:");
			for (const problem of result.problems) console.error(`  - ${problem}`);
			process.exitCode = 1;
		}
	}
}
