// Recovery: restores a backup into a NEW compose project (a new volume) beside the old one, proves the result with the
// same comparisons as the restore check, and only then reports it ready to be switched to.
//
//   node deploy/backup/restore.ts --manifest <af-<stamp>-<hex>.manifest.json> --secrets <secrets dir> [--port <free port>]
//
// Ownership: this command never learns that a resource is "its own" by looking at it. It always creates a project with
// a name no one gave it (agent-factory-restored-<run id>), refuses when any container, volume or network of that name
// exists (a failed listing is an error, never "nothing there"), labels everything it creates with the run id, and on
// failure removes only what carries that label. It does not name an existing project, and it never drops or empties a
// database: the new server's init makes an empty application database and the dump is restored into that one. The same
// holds for the Temporal databases of a backup that has them (init makes them empty, the dumps go into them).
//
// The old stack and its volume are never touched, and no command removes the old volume. After success a person
// switches over (docs/agent-factory/recovery.md): stop the old stack, start the new project on the real port.
//
// Passwords: the secrets directory holds them as files; they reach the server only through its secret mounts and
// passfiles in the container (lib.ts), never an environment variable or a command line.
import { resolve } from "node:path";
import { integerValue, parseCliArgs, reportCliFailure } from "../cli-args.ts";
import { secretsReadiness } from "../setup-secrets.ts";
import { applyDatabaseGrants, compareRestored, restoreDump, restoreTemporalDumps, verifyBackupFiles } from "./restore-check.ts";
import { freePort, newRunId, projectResourcesExist, removeOwned, startStack, type StackOptions } from "../lib.ts";

export interface RestoreOptions {
	readonly manifestPath: string;
	readonly secretsDir: string;
	// Loopback port of the new server; a free one when omitted.
	readonly port?: number;
	// Tests only: the run id the project name is built from (lets a test occupy that name first).
	readonly runId?: string;
}

export interface RestoreResult {
	readonly ok: boolean;
	readonly problems: string[];
	readonly project: string;
	readonly port: number;
	readonly runId: string;
}

export const restoredProjectName = (runId: string): string => `agent-factory-restored-${runId}`;

export const restore = async (options: RestoreOptions): Promise<RestoreResult> => {
	const runId = options.runId ?? newRunId();
	const project = restoredProjectName(runId);
	const port = options.port ?? (await freePort());
	const fail = (problems: string[]): RestoreResult => ({ ok: false, problems, project, port, runId });
	// The secrets must be ready (all seven files, valid, protected, outside a git checkout unless git ignores the place)
	// before anything else happens and long before any resource exists: a stack started with a missing or exposed secret
	// would fail late and leave a half-made project to clean up.
	try {
		const unready = secretsReadiness(options.secretsDir);
		if (unready.length > 0) return fail(unready.map((problem) => `secrets are not ready: ${problem}`));
	} catch (error) {
		return fail([`could not check the secrets: ${error instanceof Error ? error.message : String(error)}`]);
	}
	let verified;
	try {
		verified = await verifyBackupFiles(options.manifestPath);
	} catch (error) {
		return fail([error instanceof Error ? error.message : String(error)]);
	}

	// Refuse before creating anything when the name is taken in any way. Nothing carries this run's label yet, so there
	// is nothing to clean up on this path.
	try {
		const taken = await projectResourcesExist(project);
		if (taken.length > 0) return fail([`refused: ${project} already exists (${taken.join(", ")}); nothing was changed`]);
	} catch (error) {
		return fail([`could not check whether ${project} exists: ${error instanceof Error ? error.message : String(error)}`]);
	}

	const stack: StackOptions = { project, secretsDir: resolve(options.secretsDir), port, runId };
	let keep = false;
	try {
		const container = await startStack(stack);
		const restoreError = await restoreDump(container, verified.dumpPath, verified.manifest.dump);
		if (restoreError) throw new Error(restoreError);
		// The Temporal databases the backup holds go into the empty ones the new server's init made (owned by af_temporal).
		const temporalError = await restoreTemporalDumps(container, verified.temporalDumps);
		if (temporalError) throw new Error(temporalError);
		await applyDatabaseGrants(container);
		const problems = await compareRestored(container, verified.manifest);
		if (problems.length > 0) throw new Error(problems.join("; "));
		keep = true;
		return { ok: true, problems: [], project, port, runId };
	} catch (error) {
		return fail([error instanceof Error ? error.message : String(error)]);
	} finally {
		if (!keep) {
			try {
				await removeOwned(runId);
			} catch (cleanup) {
				console.error(`cleanup of run ${runId} failed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`);
				process.exitCode = 1;
			}
		}
	}
};

if (import.meta.main) {
	const usage = "usage: node deploy/backup/restore.ts --manifest <manifest file> --secrets <secrets dir> [--port <port>]";
	try {
		const { values } = parseCliArgs(process.argv.slice(2), {
			flags: { "--manifest": "value", "--secrets": "value", "--port": "value" },
			required: ["--manifest", "--secrets"],
		});
		const port = values["--port"] === undefined ? undefined : integerValue("--port", values["--port"], 1, 65535);
		const result = await restore({ manifestPath: values["--manifest"] as string, secretsDir: values["--secrets"] as string, port });
		if (result.ok) {
			console.log(`restored and verified in project ${result.project} (loopback port ${result.port}); the old stack was not touched`);
		} else {
			console.error("restore FAILED, the old stack was not touched:");
			for (const problem of result.problems) console.error(`  - ${problem}`);
			process.exitCode = 1;
		}
	} catch (error) {
		reportCliFailure(error, "restore FAILED", usage);
	}
}
