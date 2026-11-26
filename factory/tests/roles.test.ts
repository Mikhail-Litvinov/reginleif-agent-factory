// What each database account can and cannot do (docs/agent-factory/database.md "Accounts and rights").
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PsqlSession, psql, run, tryPsql } from "../deploy/lib.ts";
import { sharedStack, type TestStack } from "./helpers.ts";

const APP_ROLES = ["af_migrator", "af_api", "af_control", "af_backup", "af_reader"] as const;

describe("database accounts", () => {
	let stack: TestStack;
	let c: string;

	before(async () => {
		// The run-wide stack: this file only reads it and writes its own tables (granted, secret) and never changes it.
		stack = await sharedStack();
		c = stack.container;
		// A table made the way phase 2 migrations will: by af_migrator, in public.
		await psql(c, "af_migrator", "CREATE TABLE granted (id int PRIMARY KEY); CREATE TABLE secret (id int PRIMARY KEY);\n" +
			"INSERT INTO granted VALUES (1); INSERT INTO secret VALUES (1);\n" +
			"GRANT SELECT ON granted TO af_reader;");
	});
	after(async () => {
		await stack?.dispose();
	});

	const denied = async (role: string, sql: string, pattern: RegExp, tcp = false): Promise<void> => {
		const result = await tryPsql(c, role, sql, { tcp });
		assert.notEqual(result.code, 0, `${role} should have been refused: ${sql}`);
		assert.match(result.stderr, pattern, `${role}: ${sql}`);
	};

	it("only the bootstrap role is a superuser or holds any special attribute", async () => {
		const rows = await psql(c, "af_backup", "SELECT rolname FROM pg_roles WHERE rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls ORDER BY 1;");
		assert.equal(rows, "af_bootstrap");
		const all = await psql(c, "af_backup", "SELECT rolname FROM pg_roles WHERE rolname LIKE 'af\\_%' ORDER BY 1;");
		assert.equal(all, ["af_api", "af_backup", "af_bootstrap", "af_control", "af_migrator", "af_reader"].join("\n"));
	});

	it("the superuser is refused over TCP with the right password, accepted on the local socket", async () => {
		for (const database of ["postgres", "agent_factory"]) {
			const result = await tryPsql(c, "af_bootstrap", "SELECT 1;", { database, tcp: true });
			assert.notEqual(result.code, 0, `superuser over TCP to ${database} was accepted`);
			assert.match(result.stderr, /pg_hba\.conf rejects/);
		}
		assert.equal(await psql(c, "af_bootstrap", "SELECT current_user;", { database: "postgres" }), "af_bootstrap");
	});

	it("trust authentication is not used anywhere", async () => {
		const methods = await psql(c, "af_bootstrap", "SELECT DISTINCT auth_method FROM pg_hba_file_rules ORDER BY 1;", { database: "postgres" });
		assert.equal(methods, "reject\nscram-sha-256");
		assert.equal(await psql(c, "af_bootstrap", "SHOW password_encryption;", { database: "postgres" }), "scram-sha-256");
	});

	for (const role of APP_ROLES) {
		it(`${role} is accepted on agent_factory only (socket and TCP)`, async () => {
			for (const tcp of [false, true]) {
				assert.equal(await psql(c, role, "SELECT current_database();", { tcp }), "agent_factory");
			}
			for (const database of ["postgres", "template1", "template0"]) {
				const socket = await tryPsql(c, role, "SELECT 1;", { database });
				assert.notEqual(socket.code, 0, `${role} on ${database} over the socket`);
				const tcp = await tryPsql(c, role, "SELECT 1;", { database, tcp: true });
				assert.notEqual(tcp.code, 0, `${role} on ${database} over TCP`);
				assert.match(tcp.stderr, /no pg_hba\.conf entry/);
			}
		});
	}

	it("a wrong or an empty password is refused, over TCP and over the socket", async () => {
		// The wrong password goes in a passfile (as the code does), never an environment variable; "no password" is an
		// empty passfile. The script text holds only a made-up wrong value, not a real secret.
		const withPassfile = (line: string, host: string): string[] => [
			"exec", c, "sh", "-c",
			`umask 077; f=$(mktemp /dev/shm/pgpass.XXXXXX); trap 'rm -f "$f"' EXIT; printf '%b' '${line}' > "$f"; ` +
			`PGPASSFILE="$f" psql -w ${host} -U af_api -d agent_factory -c 'select 1'`,
		];
		for (const line of ["*:*:*:af_api:wrong-password\\n", ""]) {
			for (const host of ["-h 127.0.0.1", ""]) {
				const result = await run("docker", withPassfile(line, host));
				assert.notEqual(result.code, 0, `passfile "${line}" via ${host || "socket"}`);
				assert.match(result.stderr, /password authentication failed|no password supplied/);
			}
		}
	});

	it("af_migrator owns the database, creates tables and may create pg_trgm; vector is already there", async () => {
		await psql(c, "af_migrator", "CREATE EXTENSION IF NOT EXISTS pg_trgm;");
		const extensions = await psql(c, "af_backup", "SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm') ORDER BY 1;");
		assert.equal(extensions, "pg_trgm\nvector");
		await psql(c, "af_migrator", "CREATE TABLE scratch (id int); DROP TABLE scratch;");
	});

	it("nobody but af_migrator may create anything in public", async () => {
		for (const role of ["af_api", "af_control", "af_backup"]) {
			await denied(role, "CREATE TABLE nope (id int);", /permission denied for schema public/);
		}
		await denied("af_reader", "CREATE TABLE nope (id int);", /read-only transaction/);
	});

	it("af_api and af_control hold no table right until a migration grants one", async () => {
		for (const role of ["af_api", "af_control"]) {
			await denied(role, "SELECT * FROM granted;", /permission denied for table granted/);
			await denied(role, "INSERT INTO granted VALUES (2);", /permission denied for table granted/);
		}
	});

	it("af_backup reads tables made by af_migrator (default privileges) and can do nothing else", async () => {
		assert.equal(await psql(c, "af_backup", "SELECT count(*) FROM granted;"), "1");
		assert.equal(await psql(c, "af_backup", "SELECT count(*) FROM secret;"), "1");
		await denied("af_backup", "INSERT INTO granted VALUES (3);", /permission denied for table granted/);
		await denied("af_backup", "UPDATE granted SET id = 9;", /permission denied for table granted/);
		await denied("af_backup", "DELETE FROM granted;", /permission denied for table granted/);
		await denied("af_backup", "TRUNCATE granted;", /permission denied for table granted/);
		await denied("af_backup", "DROP TABLE granted;", /must be owner of table granted/);
		await denied("af_backup", "CREATE ROLE x;", /permission denied to create role/);
		const writable = await psql(c, "af_backup", "SELECT has_table_privilege('af_backup', 'granted', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER');");
		assert.equal(writable, "f");
	});

	it("af_reader is read-only by default and reads only the tables it was granted", async () => {
		assert.equal(await psql(c, "af_reader", "SHOW default_transaction_read_only;"), "on");
		assert.equal(await psql(c, "af_reader", "SHOW statement_timeout;"), "30s");
		assert.equal(await psql(c, "af_backup", "SELECT rolconnlimit FROM pg_roles WHERE rolname = 'af_reader';"), "5");
		assert.equal(await psql(c, "af_reader", "SELECT count(*) FROM granted;"), "1");
		await denied("af_reader", "SELECT * FROM secret;", /permission denied for table secret/);
	});

	it("af_reader stays unable to write, create or read an ungranted table after leaving read-only mode", async () => {
		const off = "SET default_transaction_read_only = off;\n";
		await denied("af_reader", `${off}INSERT INTO granted VALUES (4);`, /permission denied for table granted/);
		await denied("af_reader", `${off}UPDATE granted SET id = 5;`, /permission denied for table granted/);
		await denied("af_reader", `${off}DELETE FROM granted;`, /permission denied for table granted/);
		await denied("af_reader", `${off}CREATE TABLE mine (id int);`, /permission denied for schema public/);
		await denied("af_reader", `${off}SELECT * FROM secret;`, /permission denied for table secret/);
		await denied("af_reader", `${off}CREATE ROLE y;`, /permission denied to create role/);
		assert.equal(await psql(c, "af_backup", "SELECT count(*) FROM granted;"), "1");
	});

	it("af_reader's connection limit is enforced", async () => {
		const sessions = [];
		try {
			// Five sessions hold the five slots (psql waits on its standard input); the sixth is refused.
			for (let i = 0; i < 5; i += 1) {
				const session = new PsqlSession(c, "af_reader");
				sessions.push(session);
				assert.equal(await session.query("SELECT 1;"), "1");
			}
			await denied("af_reader", "SELECT 1;", /too many connections for role "af_reader"/);
		} finally {
			for (const session of sessions) await session.close();
		}
	});
});
