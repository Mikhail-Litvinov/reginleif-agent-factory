// Adds the Postgres side of Temporal (the role af_temporal and the databases af_temporal and af_temporal_visibility) to a
// data directory that already exists. A new install gets the same objects from init/20-temporal.sh; both run the one file
// init/lib/temporal.sql, so the two paths cannot drift apart (docs/agent-factory/deployment.md "Adding Temporal to an
// existing installation").
//
//   node deploy/bootstrap-temporal.ts [--project agent-factory | --container <container name>]
//
// Order: make the secret (node deploy/setup-secrets.ts, which adds only the missing af_temporal file), recreate the stack so
// the container mounts it and the new pg_hba.conf (docker compose up -d), then run this. It runs as af_bootstrap over the
// local socket, the only way that role may connect. Idempotent: a second run changes nothing but re-applies the password of
// the secret file, so it is also how a rotated af_temporal secret reaches the server. It never touches agent_factory.
// Exit 0 when the objects exist and the role can log in to its database; 1 on a failure; 2 on a wrong argument.
import { readFile } from "node:fs/promises";
import { UsageError, parseCliArgs, reportCliFailure } from "./cli-args.ts";
import { TEMPORAL_DATABASES, TEMPORAL_ROLE } from "./init-postconditions.ts";
import { findContainer, psql, run, tryPsql } from "./lib.ts";

const SQL_FILE = new URL("./postgres/init/lib/temporal.sql", import.meta.url);
const SECRET_PATH = `/run/secrets/${TEMPORAL_ROLE}`;

export interface BootstrapOptions {
	readonly project?: string;
	readonly container?: string;
}

const firstLine = (text: string, fallback: string): string => (text.trim() || fallback).split(/\r?\n/)[0] as string;

// Runs temporal.sql in the container as af_bootstrap over the local socket (the file reads the secret itself, so the
// container must mount it). The one place both this command and the restore check's scratch server apply it.
export const applyTemporalSql = async (container: string): Promise<void> => {
	const sql = await readFile(SQL_FILE, "utf8");
	await psql(container, "af_bootstrap", sql, { database: "postgres" });
};

// Returns the container that was bootstrapped. Throws with the reason on any failure.
export const bootstrapTemporal = async (options: BootstrapOptions = {}): Promise<string> => {
	const container = options.container ?? (await findContainer(options.project ?? "agent-factory"));

	// A container made before the secret existed does not mount it: say what to do instead of failing inside psql.
	const mounted = await run("docker", ["exec", container, "test", "-s", SECRET_PATH]);
	if (mounted.code !== 0) {
		throw new Error(`the container does not have the secret ${SECRET_PATH}: make it with node deploy/setup-secrets.ts and recreate the stack with docker compose up -d, then run this again`);
	}

	await applyTemporalSql(container);

	// The proof that the result works: the role logs in over TCP (the path Temporal takes) to its own database with the
	// password of its secret file. This also proves the pg_hba.conf line, so a container that still runs the old file fails here.
	const login = await tryPsql(container, TEMPORAL_ROLE, "select 1;", { database: TEMPORAL_DATABASES[0], tcp: true });
	if (login.code !== 0 || login.stdout.trim() !== "1") {
		throw new Error(`the objects exist, but ${TEMPORAL_ROLE} cannot log in to ${TEMPORAL_DATABASES[0]} over TCP: ${firstLine(login.stderr, `exit ${login.code}`)} (the stack must run the pg_hba.conf of this version: docker compose up -d --force-recreate)`);
	}
	return container;
};

const USAGE = "usage: node deploy/bootstrap-temporal.ts [--project agent-factory | --container <container name>]";

if (import.meta.main) {
	try {
		const { values } = parseCliArgs(process.argv.slice(2), { flags: { "--project": "value", "--container": "value" } });
		if (values["--project"] !== undefined && values["--container"] !== undefined) throw new UsageError("--container and --project cannot be used together");
		const container = await bootstrapTemporal({ project: values["--project"], container: values["--container"] });
		console.log(`ok   ${TEMPORAL_ROLE} and ${TEMPORAL_DATABASES.join(", ")} are in place in ${container}; ${TEMPORAL_ROLE} logs in to ${TEMPORAL_DATABASES[0]}`);
	} catch (error) {
		reportCliFailure(error, "bootstrap-temporal failed", USAGE);
	}
}
