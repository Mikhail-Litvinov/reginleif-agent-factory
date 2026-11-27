// One disposable database per test file, cloned from PostgreSQL's empty template database.
import { createHash } from "node:crypto";
import { after } from "node:test";
import postgres from "postgres";
import { psql, type Clock } from "../deploy/lib.ts";
import { BENCH_STACK_ENV, benchStack } from "./helpers.ts";

export interface DatabaseBench {
	readonly database: string;
	readonly runId: string;
	readonly migratorUrl: string;
	readonly apiUrl: string;
	readonly controlUrl: string;
	readonly backupUrl: string;
	readonly clock: Clock;
	dispose(): Promise<void>;
}

export const fakeClock = (initialTime = 0): Clock => {
	let currentTime = initialTime;
	return {
		now: () => currentTime,
		sleep: async (milliseconds) => {
			if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new RangeError("sleep duration must be a finite non-negative number");
			currentTime += milliseconds;
		},
	};
};

export const databaseNameForFile = (runId: string, testFileUrl: string): string => {
	const fileId = createHash("sha256").update(testFileUrl).digest("hex").slice(0, 12);
	return `af_test_${runId}_${fileId}`;
};

const quoteIdentifier = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;

const connectionUrl = (role: string, password: string, port: number, database: string): string =>
	`postgres://${encodeURIComponent(role)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;

export const createDatabaseBench = async (testFileUrl: string): Promise<DatabaseBench> => {
	const stack = await benchStack();
	const database = databaseNameForFile(stack.runId, testFileUrl);
	const quotedDatabase = quoteIdentifier(database);
	const dropDatabase = () => psql(stack.container, "af_bootstrap", `DROP DATABASE IF EXISTS ${quotedDatabase} WITH (FORCE);`, { database: "postgres" });

	try {
		const [migratorPassword, apiPassword, controlPassword, backupPassword] = await Promise.all([stack.secret("af_migrator"), stack.secret("af_api"), stack.secret("af_control"), stack.secret("af_backup")]);
		await psql(stack.container, "af_bootstrap", [
			`CREATE DATABASE ${quotedDatabase} WITH TEMPLATE template0 OWNER af_migrator;`,
			`GRANT CONNECT ON DATABASE ${quotedDatabase} TO af_api, af_control, af_backup;`,
		].join("\n"), { database: "postgres" });
		await psql(stack.container, "af_bootstrap", "CREATE EXTENSION IF NOT EXISTS vector;", { database });
		return makeBench(database, stack, migratorPassword, apiPassword, controlPassword, backupPassword, dropDatabase);
	} catch (error) {
		const cleanupErrors: unknown[] = [];
		await dropDatabase().catch((cleanupError) => cleanupErrors.push(cleanupError));
		if (!process.env[BENCH_STACK_ENV]) await stack.dispose().catch((cleanupError) => cleanupErrors.push(cleanupError));
		if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "database setup failed and cleanup also failed");
		throw error;
	}
};

const makeBench = (database: string, stack: Awaited<ReturnType<typeof benchStack>>, migratorPassword: string, apiPassword: string, controlPassword: string, backupPassword: string, dropDatabase: () => Promise<string>): DatabaseBench => {
	let disposed = false;
	const bench: DatabaseBench = {
		database,
		runId: stack.runId,
		migratorUrl: connectionUrl("af_migrator", migratorPassword.trim(), stack.port, database),
		apiUrl: connectionUrl("af_api", apiPassword.trim(), stack.port, database),
		controlUrl: connectionUrl("af_control", controlPassword.trim(), stack.port, database),
		backupUrl: connectionUrl("af_backup", backupPassword.trim(), stack.port, database),
		clock: fakeClock(),
		dispose: async () => {
			if (disposed) return;
			await disposeBench(!process.env[BENCH_STACK_ENV], dropDatabase, () => stack.dispose());
			disposed = true;
		},
	};
	return bench;
};

// A bench that owns its stack (a file run by hand, no global setup) needs no DROP DATABASE: removing the stack removes the
// database with it. The drop must not run there at all: helpers.ts registers an `after` that removes every live stack
// before this file's hook runs, so the container is already gone ("No such container"). With the shared stack of
// `npm test` the drop is needed, and the container always outlives the hook.
export const disposeBench = async (ownsStack: boolean, dropDatabase: () => Promise<unknown>, disposeStack: () => Promise<void>): Promise<void> => {
	const errors: unknown[] = [];
	if (ownsStack) await disposeStack().catch((error) => errors.push(error));
	else await dropDatabase().catch((error) => errors.push(error));
	if (errors.length > 0) throw new AggregateError(errors, "database bench cleanup failed");
};

// Call during module setup: Node registers the teardown before any tests can fail.
export const databaseBench = (testFileUrl: string): Promise<DatabaseBench> => {
	const bench = createDatabaseBench(testFileUrl);
	after(async () => (await bench).dispose());
	return bench;
};

export const connectBench = (url: string) => postgres(url, { max: 1 });

// A jsonb parameter for a test client: sql`... ${jsonb(value)}::text::jsonb`. drizzle(sql) replaces the json serializers of
// the postgres.js client it wraps, so sql.json() throws ERR_INVALID_ARG_TYPE on it, and a string sent as a jsonb-typed
// parameter is encoded twice on a client it does not wrap. Sending the text as a text parameter and casting it on the
// server gives the same result on every client.
// tests/no-sql-json.test.ts fails when a test calls sql.json() directly.
export const jsonb = (value: unknown): string => JSON.stringify(value);
