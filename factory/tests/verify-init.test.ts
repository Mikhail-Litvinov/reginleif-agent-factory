// deploy/verify-init.ts: the check that a database made before the marker existed is completely initialised.
//
//  - Coverage (no database): every statement of init/10-roles.sh and every step of init/99-finish.sh has a check in
//    deploy/init-postconditions.ts, and no check names a statement that is gone, so the script and the check cannot drift.
//  - A private stack: a complete database passes (the command line included); then, one at a time, each postcondition is
//    broken as the bootstrap superuser, the check that proves it must fail and the command must exit 1, and after the
//    repair the whole set passes again. The last case drops the application database, which is what an initialisation
//    interrupted after the roles looks like to the check.
//
// Nothing here removes a file: a file is moved aside and moved back.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CHECKS, FINISH_MARKER, FINISH_NO_TRUST_RULE, FINISH_REMOVES_SERVICE_FILE, MARKER_NAME, TRUST_RULE_PATTERN, statementsOfRolesScript, type Check } from "../deploy/init-postconditions.ts";
import { psql, run } from "../deploy/lib.ts";
import { formatResults, verifyInit, type CheckResult } from "../deploy/verify-init.ts";
import { createTestStack, type TestStack } from "./helpers.ts";

const factoryDir = fileURLToPath(new URL("..", import.meta.url));
const rolesScript = fileURLToPath(new URL("../deploy/postgres/init/10-roles.sh", import.meta.url));
const finishScript = fileURLToPath(new URL("../deploy/postgres/init/99-finish.sh", import.meta.url));
const FINISH_STEPS = [FINISH_REMOVES_SERVICE_FILE, FINISH_NO_TRUST_RULE, FINISH_MARKER];

// What a statement list and a check list leave unmatched, in both directions.
const mismatch = (statements: readonly string[], checks: readonly Check[]): { uncovered: string[]; stale: string[] } => {
	const covered = new Set(checks.flatMap((check) => check.covers));
	const wanted = new Set([...statements, ...FINISH_STEPS]);
	return { uncovered: [...wanted].filter((s) => !covered.has(s)), stale: [...covered].filter((s) => !wanted.has(s)) };
};

describe("every statement of the init scripts has a check", () => {
	it("10-roles.sh: each statement is covered by a check and each cover is a statement of the script", async () => {
		const source = await readFile(rolesScript, "utf8");
		const statements = statementsOfRolesScript(source);
		// The parser must not silently skip a statement: count the statement lines of the script independently.
		const statementLines = source.split(/\r?\n/).filter((line) => /^\s*(printf )?"(CREATE|ALTER|REVOKE|GRANT|DROP) [A-Z]/.test(line));
		assert.equal(statements.length, statementLines.length, "the parser found a different number of statements than the script has lines of them");
		assert.equal(statements.length, 17);
		assert.deepEqual(mismatch(statements, CHECKS), { uncovered: [], stale: [] });
	});

	it("the comparison itself notices a new statement and a removed one", () => {
		const grown = mismatch([...statementsOfRolesScript('\t\t"REVOKE ALL ON SCHEMA public FROM PUBLIC;" \\\n'), "GRANT CONNECT ON DATABASE agent_factory TO af_api, af_control, af_backup, af_reader"], CHECKS);
		assert.deepEqual(grown.uncovered, [FINISH_REMOVES_SERVICE_FILE, FINISH_NO_TRUST_RULE, FINISH_MARKER].filter((s) => !CHECKS.some((c) => c.covers.includes(s))).concat("REVOKE ALL ON SCHEMA public FROM PUBLIC"));
		assert.ok(grown.stale.includes("CREATE EXTENSION vector"), "a statement that left the script leaves a stale cover");
	});

	it("99-finish.sh: the checks use the same trust pattern and marker name as the script, and name its steps", async () => {
		const source = await readFile(finishScript, "utf8");
		assert.ok(source.includes(`'${TRUST_RULE_PATTERN}'`), "the trust pattern of the check differs from the one in 99-finish.sh");
		assert.ok(source.includes(`"$PGDATA/${MARKER_NAME}"`));
		assert.ok(/rm -f -- "\$PGSERVICEFILE"/.test(source));
		for (const step of FINISH_STEPS) assert.equal(CHECKS.filter((c) => c.covers.includes(step)).length, 1, step);
		assert.equal(CHECKS.filter((c) => c.kind === "shell" && c.isMarker).length, 1);
	});

	it("check names are unique and the batch separator never appears in one", () => {
		const names = CHECKS.map((c) => c.name);
		assert.equal(new Set(names).size, names.length);
		assert.ok(names.every((n) => !n.includes("|")));
	});
});

const byName = (results: readonly CheckResult[], part: string): CheckResult[] => results.filter((r) => r.name.includes(part));
const failed = (results: readonly CheckResult[]): string[] => results.filter((r) => !r.ok).map((r) => r.name);

describe("verify-init against a real database", { concurrency: false }, () => {
	let stack: TestStack;
	let container: string;
	const verify = (withMarker = false): Promise<CheckResult[]> => verifyInit({ container, withMarker });
	const asBootstrap = (sql: string, database = "agent_factory"): Promise<string> => psql(container, "af_bootstrap", sql, { database });
	const asPostgresUser = async (script: string): Promise<void> => {
		const result = await run("docker", ["exec", "-u", "postgres", container, "sh", "-c", script]);
		assert.equal(result.code, 0, `${script}: ${result.stderr}`);
	};
	const cli = (...extra: string[]) => run("node", ["deploy/verify-init.ts", "--project", stack.project, ...extra], { cwd: factoryDir });
	const hba = '"${PGDATA:-/var/lib/postgresql/data}/pg_hba.conf"';
	const marker = `"\${PGDATA:-/var/lib/postgresql/data}/${MARKER_NAME}"`;

	before(async () => {
		stack = await createTestStack();
		container = stack.container;
	});
	after(async () => {
		await stack?.dispose();
	});

	it("a completely initialised database passes every check, with and without the marker, on the command line too", async () => {
		const results = await verify(true);
		assert.deepEqual(failed(results), [], formatResults(results).join("\n"));
		assert.equal(results.length, CHECKS.length);
		assert.equal((await verify(false)).length, CHECKS.length - 1, "without --with-marker the marker check is not asked");

		const ok = await cli("--with-marker");
		assert.equal(ok.code, 0, ok.stdout + ok.stderr);
		assert.match(ok.stdout, new RegExp(`all ${CHECKS.length} checks passed`));
		assert.match(ok.stdout, /^ok {3}role af_reader: login/m);
	});

	it("a wrong argument exits 2 and checks nothing", async () => {
		const bad = await cli("--nonsense");
		assert.equal(bad.code, 2, bad.stdout + bad.stderr);
		assert.match(bad.stderr, /unknown argument/);
	});

	interface Mutation {
		readonly name: string;
		readonly breakIt: () => Promise<unknown>;
		readonly repair: () => Promise<unknown>;
		// Parts of the names of the checks that must fail.
		readonly fails: readonly string[];
		readonly withMarker?: boolean;
	}
	const mutations: Mutation[] = [
		{ name: "a role that may create databases", breakIt: () => asBootstrap("ALTER ROLE af_api CREATEDB;"), repair: () => asBootstrap("ALTER ROLE af_api NOCREATEDB;"), fails: ["role af_api:"] },
		{ name: "a role that may bypass row security", breakIt: () => asBootstrap("ALTER ROLE af_control BYPASSRLS;"), repair: () => asBootstrap("ALTER ROLE af_control NOBYPASSRLS;"), fails: ["role af_control:"] },
		{ name: "a second superuser", breakIt: () => asBootstrap("ALTER ROLE af_migrator SUPERUSER;"), repair: () => asBootstrap("ALTER ROLE af_migrator NOSUPERUSER;"), fails: ["no other role is a superuser", "role af_migrator:"] },
		{ name: "a wrong connection limit of the reader", breakIt: () => asBootstrap("ALTER ROLE af_reader CONNECTION LIMIT 7;"), repair: () => asBootstrap("ALTER ROLE af_reader CONNECTION LIMIT 5;"), fails: ["role af_reader:"] },
		{ name: "a reader without the statement timeout", breakIt: () => asBootstrap("ALTER ROLE af_reader RESET statement_timeout;"), repair: () => asBootstrap("ALTER ROLE af_reader SET statement_timeout = '30s';"), fails: ["af_reader: statement_timeout"] },
		{ name: "a reader that may write", breakIt: () => asBootstrap("ALTER ROLE af_reader RESET default_transaction_read_only;"), repair: () => asBootstrap("ALTER ROLE af_reader SET default_transaction_read_only = on;"), fails: ["af_reader: default_transaction_read_only"] },
		{ name: "PUBLIC may connect to template1", breakIt: () => asBootstrap("GRANT CONNECT ON DATABASE template1 TO PUBLIC;", "postgres"), repair: () => asBootstrap("REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;", "postgres"), fails: ["database template1: PUBLIC cannot connect"] },
		{ name: "PUBLIC may connect to postgres", breakIt: () => asBootstrap("GRANT CONNECT ON DATABASE postgres TO PUBLIC;", "postgres"), repair: () => asBootstrap("REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;", "postgres"), fails: ["database postgres: PUBLIC cannot connect"] },
		{ name: "PUBLIC may connect to the application database", breakIt: () => asBootstrap("GRANT CONNECT ON DATABASE agent_factory TO PUBLIC;"), repair: () => asBootstrap("REVOKE ALL ON DATABASE agent_factory FROM PUBLIC;"), fails: ["database agent_factory: PUBLIC holds no right"] },
		{ name: "a reader that may not connect", breakIt: () => asBootstrap("REVOKE CONNECT ON DATABASE agent_factory FROM af_reader;"), repair: () => asBootstrap("GRANT CONNECT ON DATABASE agent_factory TO af_reader;"), fails: ["may connect", "login as af_reader"] },
		{ name: "the application database owned by someone else", breakIt: () => asBootstrap("ALTER DATABASE agent_factory OWNER TO af_api;", "postgres"), repair: () => asBootstrap("ALTER DATABASE agent_factory OWNER TO af_migrator; GRANT CONNECT ON DATABASE agent_factory TO af_api;", "postgres"), fails: ["af_migrator owns it"] },
		{ name: "PUBLIC may create in schema public", breakIt: () => asBootstrap("GRANT CREATE ON SCHEMA public TO PUBLIC;"), repair: () => asBootstrap("REVOKE CREATE ON SCHEMA public FROM PUBLIC;"), fails: ["schema public: PUBLIC cannot create"] },
		{ name: "a role without usage of schema public", breakIt: () => asBootstrap("REVOKE USAGE ON SCHEMA public FROM af_control;"), repair: () => asBootstrap("GRANT USAGE ON SCHEMA public TO af_control;"), fails: ["hold usage"] },
		{ name: "no default select on new sequences for the backup role", breakIt: () => asBootstrap("ALTER DEFAULT PRIVILEGES FOR ROLE af_migrator IN SCHEMA public REVOKE SELECT ON SEQUENCES FROM af_backup;"), repair: () => asBootstrap("ALTER DEFAULT PRIVILEGES FOR ROLE af_migrator IN SCHEMA public GRANT SELECT ON SEQUENCES TO af_backup;"), fails: ["new sequences"] },
		{ name: "no default select on new tables for the backup role", breakIt: () => asBootstrap("ALTER DEFAULT PRIVILEGES FOR ROLE af_migrator IN SCHEMA public REVOKE SELECT ON TABLES FROM af_backup;"), repair: () => asBootstrap("ALTER DEFAULT PRIVILEGES FOR ROLE af_migrator IN SCHEMA public GRANT SELECT ON TABLES TO af_backup;"), fails: ["new tables"] },
		{ name: "the backup role may write to new tables", breakIt: () => asBootstrap("ALTER DEFAULT PRIVILEGES FOR ROLE af_migrator IN SCHEMA public GRANT INSERT ON TABLES TO af_backup;"), repair: () => asBootstrap("ALTER DEFAULT PRIVILEGES FOR ROLE af_migrator IN SCHEMA public REVOKE INSERT ON TABLES FROM af_backup;"), fails: ["new tables"] },
		{ name: "the vector extension missing", breakIt: () => asBootstrap("DROP EXTENSION vector;"), repair: () => asBootstrap("CREATE EXTENSION vector;"), fails: ["extension vector"] },
		{ name: "a password that is not the one of the secret file", breakIt: () => asBootstrap("ALTER ROLE af_api PASSWORD 'not-the-secret';"), repair: async () => asBootstrap(`ALTER ROLE af_api PASSWORD '${(await stack.secret("af_api")).trim()}';`), fails: ["login as af_api"] },
		{
			name: "a trust rule in the data directory's pg_hba.conf",
			breakIt: () => asPostgresUser(`cp ${hba} ${hba}.aside && printf '\\nhost all all all trust\\n' >> ${hba}`),
			repair: () => asPostgresUser(`mv ${hba}.aside ${hba}`),
			fails: [FINISH_NO_TRUST_RULE],
		},
		{
			name: "a service file left in tmpfs",
			breakIt: () => asPostgresUser("mkdir -p /dev/shm/af-init.probe && : > /dev/shm/af-init.probe/service.probe"),
			repair: () => asPostgresUser("mv /dev/shm/af-init.probe/service.probe /dev/shm/af-init.probe/moved-aside"),
			fails: [FINISH_REMOVES_SERVICE_FILE],
		},
		{
			name: "a missing marker",
			breakIt: () => asPostgresUser(`mv ${marker} ${marker}.aside`),
			repair: () => asPostgresUser(`mv ${marker}.aside ${marker}`),
			fails: [FINISH_MARKER],
			withMarker: true,
		},
	];

	for (const mutation of mutations) {
		it(`fails, and passes again after the repair: ${mutation.name}`, async () => {
			await mutation.breakIt();
			let repaired = false;
			try {
				const broken = await verify(mutation.withMarker ?? false);
				for (const part of mutation.fails) {
					const hits = byName(broken, part);
					assert.ok(hits.length > 0, `no check named like "${part}"`);
					assert.ok(hits.some((h) => !h.ok), `"${part}" did not fail:\n${formatResults(broken).join("\n")}`);
				}
				const command = await cli(...(mutation.withMarker ? ["--with-marker"] : []));
				assert.equal(command.code, 1, command.stdout + command.stderr);
				assert.match(command.stderr, /restore from a known-good backup/);
				await mutation.repair();
				repaired = true;
			} finally {
				if (!repaired) await mutation.repair();
			}
			const after = await verify(true);
			assert.deepEqual(failed(after), [], formatResults(after).join("\n"));
		});
	}

	it("an initialisation interrupted after the roles (the application database is missing) fails every catalog check", async () => {
		await asBootstrap("DROP DATABASE agent_factory WITH (FORCE);", "postgres");
		const results = await verify(true);
		const sql = results.filter((r) => /^(role|database|schema|extension|default privileges|no other)/.test(r.name));
		assert.ok(sql.length > 10);
		assert.ok(sql.every((r) => !r.ok && /could not run the catalog checks as af_backup/.test(r.detail)), formatResults(results).join("\n"));
		assert.ok(byName(results, "login as af_api").every((r) => !r.ok));
		const command = await cli("--with-marker");
		assert.equal(command.code, 1);
		assert.match(command.stderr, /do not mark it, restore from a known-good backup/);
	});
});
