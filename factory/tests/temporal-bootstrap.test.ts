// The Postgres side of Temporal on a real stack (docs/agent-factory/deployment.md "Adding Temporal to an existing
// installation"): the objects init made, the isolation of the Temporal role and the application roles in both directions,
// and the bootstrap command (deploy/bootstrap-temporal.ts) that makes the same objects in an existing data directory.
//
// The stack is new, so init made the objects; the bootstrap command is then run on it. What matters of that command is
// what it does to a data directory that already has the objects (nothing, however often it runs) and to one that has them
// wrongly (it repairs them), which is exactly the state of an installation that was bootstrapped, then changed by hand.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { bootstrapTemporal } from "../deploy/bootstrap-temporal.ts";
import { APPLICATION_ROLES, TEMPORAL_DATABASES, TEMPORAL_ROLE } from "../deploy/init-postconditions.ts";
import { psql, tryPsql } from "../deploy/lib.ts";
import { probeRefusedByRules, verifyInit } from "../deploy/verify-init.ts";
import { createTestStack, type TestStack } from "./helpers.ts";

describe("the Temporal role and databases", () => {
	let stack: TestStack;
	let container: string;
	const asBootstrap = (sql: string, database = "postgres"): Promise<string> => psql(container, "af_bootstrap", sql, { database });

	// The whole state the bootstrap is responsible for, as one text: the role with its attributes, each database with owner
	// and privileges, and the settings stored for the role.
	const snapshot = (): Promise<string> =>
		asBootstrap(
			`select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconnlimit from pg_roles where rolname = '${TEMPORAL_ROLE}';
			select datname, pg_get_userbyid(datdba), coalesce(datacl::text, '') from pg_database where datname like 'af\\_temporal%' order by datname;
			select count(*) from pg_roles where rolname like 'af\\_temporal%';`,
		);
	const failedChecks = async (): Promise<string[]> => (await verifyInit({ container })).filter((result) => !result.ok).map((result) => `${result.name}: ${result.detail}`);

	before(async () => {
		stack = await createTestStack();
		container = stack.container;
	});
	after(async () => {
		await stack?.dispose();
	});

	it("init made the role and both databases, and the whole set of checks passes", async () => {
		assert.deepEqual(await failedChecks(), []);
		const owners = await asBootstrap(`select datname || '=' || pg_get_userbyid(datdba) from pg_database where datname like 'af\\_temporal%' order by datname;`);
		assert.equal(owners, TEMPORAL_DATABASES.map((name) => `${name}=${TEMPORAL_ROLE}`).sort().join("\n"));
	});

	it("the Temporal role works in its two databases over TCP, as Temporal connects, and a wrong password does not", async () => {
		for (const database of TEMPORAL_DATABASES) {
			assert.equal(await psql(container, TEMPORAL_ROLE, "select 1;", { database, tcp: true }), "1");
			// It owns the database, so it can create what Temporal's schema tool creates there.
			assert.equal(await psql(container, TEMPORAL_ROLE, "create table af_probe (id int); drop table af_probe; select 'made';", { database, tcp: true }), "made");
			const wrong = await tryPsql(container, TEMPORAL_ROLE, "select 1;", { database, tcp: true, wrongPassword: true });
			assert.notEqual(wrong.code, 0);
			assert.match(wrong.stderr, /password authentication failed/i);
		}
	});

	it("the Temporal role cannot reach the application database or any other database", async () => {
		for (const database of ["agent_factory", "postgres", "template1"]) {
			assert.equal(await probeRefusedByRules(container, TEMPORAL_ROLE, { database }), null, `${TEMPORAL_ROLE} must be refused by the rules in ${database}`);
		}
		// The rules are the first line of defence; the second is that the role holds no right there even where the rules let
		// it in (a rule loosened later): CONNECT is not granted to it and PUBLIC has none.
		for (const database of ["agent_factory", "postgres", "template1"]) {
			assert.equal(await asBootstrap(`select has_database_privilege('${TEMPORAL_ROLE}', '${database}', 'CONNECT');`), "f", `${TEMPORAL_ROLE} holds CONNECT on ${database}`);
		}
	});

	it("no application role can reach a Temporal database", async () => {
		for (const role of APPLICATION_ROLES) {
			for (const database of TEMPORAL_DATABASES) {
				assert.equal(await probeRefusedByRules(container, role, { database }), null, `${role} must be refused by the rules in ${database}`);
				assert.equal(await asBootstrap(`select has_database_privilege('${role}', '${database}', 'CONNECT');`), "f", `${role} holds CONNECT on ${database}`);
			}
		}
	});

	it("the bootstrap command run twice changes nothing: the state is the same, both runs exit clean, the checks pass", async () => {
		const before = await snapshot();
		assert.equal(await bootstrapTemporal({ container }), container);
		const afterFirst = await snapshot();
		assert.equal(await bootstrapTemporal({ container }), container);
		const afterSecond = await snapshot();
		assert.equal(afterFirst, before);
		assert.equal(afterSecond, before);
		assert.deepEqual(await failedChecks(), []);
	});

	it("the bootstrap command repairs a drifted role, a missing database, a wrong owner, a PUBLIC grant and a changed password", async () => {
		await asBootstrap(`alter role ${TEMPORAL_ROLE} createdb superuser; alter role ${TEMPORAL_ROLE} password 'not-the-secret';`);
		await asBootstrap(`drop database af_temporal_visibility;`);
		await asBootstrap(`alter database af_temporal owner to af_api; grant connect on database af_temporal to public;`);
		assert.notDeepEqual(await failedChecks(), [], "the drift must be visible to the checks before the repair");

		await bootstrapTemporal({ container });

		assert.deepEqual(await failedChecks(), []);
		const state = await snapshot();
		assert.match(state, /^af_temporal\|t\|f\|f\|f\|f\|f\|-1$/m);
		for (const database of TEMPORAL_DATABASES) assert.match(state, new RegExp(`^${database}\\|${TEMPORAL_ROLE}\\|`, "m"));
		assert.equal(await psql(container, TEMPORAL_ROLE, "select 1;", { database: TEMPORAL_DATABASES[1], tcp: true }), "1");
	});

	// The upgrade of an installation made before Temporal existed: no role, no databases (the rule in pg_hba.conf is the new
	// file's). --without-temporal judges it as it is, a complete installation of the old policy; without the flag it is
	// incomplete; the bootstrap completes it; and with the flag a database that has the Temporal part still passes (rollback).
	it("--without-temporal leaves the Temporal part out: a legacy-shaped database passes with it and fails without it, a complete one passes with it too", async () => {
		const withFlag = async (): Promise<string[]> => (await verifyInit({ container, withoutTemporal: true })).filter((result) => !result.ok).map((result) => `${result.name}: ${result.detail}`);
		assert.deepEqual(await withFlag(), [], "a complete installation passes with the flag (the rollback after the bootstrap)");

		for (const database of TEMPORAL_DATABASES) await asBootstrap(`drop database ${database} with (force);`);
		await asBootstrap(`drop role ${TEMPORAL_ROLE};`);
		try {
			assert.deepEqual(await withFlag(), [], "a legacy-shaped installation passes with the flag");
			const without = await failedChecks();
			assert.ok(without.some((line) => line.startsWith(`role ${TEMPORAL_ROLE}:`)), `without the flag the missing role must fail:\n${without.join("\n")}`);
			assert.ok(without.some((line) => line.includes(`database ${TEMPORAL_DATABASES[0]} exists`)), without.join("\n"));
		} finally {
			await bootstrapTemporal({ container });
		}
		assert.deepEqual(await failedChecks(), []);
	});

	it("--without-temporal still judges everything else: a broken application role fails with the flag", async () => {
		await asBootstrap("alter role af_api createdb;");
		try {
			const failed = (await verifyInit({ container, withoutTemporal: true })).filter((result) => !result.ok).map((result) => result.name);
			assert.ok(failed.some((name) => name.startsWith("role af_api:")), failed.join("\n"));
		} finally {
			await asBootstrap("alter role af_api nocreatedb;");
		}
		assert.deepEqual(await failedChecks(), []);
	});

	it("the bootstrap command never touches the application database", async () => {
		const state = (): Promise<string> =>
			asBootstrap(`select pg_get_userbyid(datdba) || '|' || coalesce(datacl::text, '') from pg_database where datname = 'agent_factory';`);
		const before = await state();
		await bootstrapTemporal({ container });
		assert.equal(await state(), before);
	});

	it("a container that does not exist fails with the reason, and nothing is applied", async () => {
		await assert.rejects(bootstrapTemporal({ container: "af-no-such-container-47" }), /./);
	});
});
