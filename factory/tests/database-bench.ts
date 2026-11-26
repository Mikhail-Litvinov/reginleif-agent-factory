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
		const [migratorPassword, apiPassword] = await Promise.all([stack.secret("af_migrator"), stack.secret("af_api")]);
		await psql(stack.container, "af_bootstrap", [
			`CREATE DATABASE ${quotedDatabase} WITH TEMPLATE template0 OWNER af_migrator;`,
			`GRANT CONNECT ON DATABASE ${quotedDatabase} TO af_api;`,
		].join("\n"), { database: "postgres" });
		return makeBench(database, stack, migratorPassword, apiPassword, dropDatabase);
	} catch (error) {
		const cleanupErrors: unknown[] = [];
		await dropDatabase().catch((cleanupError) => cleanupErrors.push(cleanupError));
		if (!process.env[BENCH_STACK_ENV]) await stack.dispose().catch((cleanupError) => cleanupErrors.push(cleanupError));
		if (cleanupErrors.length > 0) throw new AggregateError([error, ...cleanupErrors], "database setup failed and cleanup also failed");
		throw error;
	}
};

const makeBench = (database: string, stack: Awaited<ReturnType<typeof benchStack>>, migratorPassword: string, apiPassword: string, dropDatabase: () => Promise<string>): DatabaseBench => {
	let disposed = false;
	const bench: DatabaseBench = {
		database,
		runId: stack.runId,
		migratorUrl: connectionUrl("af_migrator", migratorPassword.trim(), stack.port, database),
		apiUrl: connectionUrl("af_api", apiPassword.trim(), stack.port, database),
		clock: fakeClock(),
		dispose: async () => {
			if (disposed) return;
			const errors: unknown[] = [];
			await dropDatabase().catch((error) => errors.push(error));
			if (!process.env[BENCH_STACK_ENV]) await stack.dispose().catch((error) => errors.push(error));
			if (errors.length > 0) throw new AggregateError(errors, "database bench cleanup failed");
			disposed = true;
		},
	};
	return bench;
};

// Call during module setup: Node registers the teardown before any tests can fail.
export const databaseBench = (testFileUrl: string): Promise<DatabaseBench> => {
	const bench = createDatabaseBench(testFileUrl);
	after(async () => (await bench).dispose());
	return bench;
};

export const connectBench = (url: string) => postgres(url, { max: 1 });
