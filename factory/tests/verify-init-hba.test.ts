// The authentication part of deploy/verify-init.ts. A login that succeeds is not proof of the password in the secret file:
// a trust rule that is ACTIVE lets any password in. So the check reads the rules the running server really uses
// (pg_hba_file_rules, as the bootstrap role) instead of the file in the data directory, and one login with a wrong password
// must be refused.
//
//  - Unit: which rule lists are a problem (no database).
//  - The real stack (shared, read-only): the rules of the stack are clean, the wrong password is refused, and both are
//    part of the full check.
//  - A scratch server with a trust rule, started inside the stack's container on another port as the postgres OS user and
//    stopped and removed at the end: the check must report the trust rule, and the wrong password must be accepted there,
//    which the probe must report. The running stack is not touched (its hba_file is a start-time setting, so it cannot be
//    changed by a test anyway).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { CHECKS, hbaRuleProblems, type HbaRule } from "../deploy/init-postconditions.ts";
import { run } from "../deploy/lib.ts";
import { checkActiveHba, probeWrongPassword, verifyInit } from "../deploy/verify-init.ts";
import { sharedStack, type TestStack } from "./helpers.ts";

const rule = (over: Partial<HbaRule>): HbaRule => ({
	line_number: 1,
	type: "host",
	database: ["agent_factory"],
	user_name: ["af_api"],
	address: "samenet",
	auth_method: "scram-sha-256",
	error: null,
	...over,
});

describe("hbaRuleProblems", () => {
	it("accepts scram-sha-256 and reject rules", () => {
		assert.deepEqual(hbaRuleProblems([rule({}), rule({ line_number: 2, auth_method: "reject", user_name: ["af_bootstrap"] }), rule({ line_number: 3, type: "local", address: null })]), []);
	});

	it("reports a trust rule, naming the line and the method", () => {
		const problems = hbaRuleProblems([rule({}), rule({ line_number: 7, type: "local", address: null, auth_method: "trust" })]);
		assert.equal(problems.length, 1);
		assert.match(problems[0] ?? "", /line 7/);
		assert.match(problems[0] ?? "", /trust/);
	});

	it("reports every other method that does not prove a password: peer, ident, md5, password, cert", () => {
		for (const method of ["peer", "ident", "md5", "password", "cert", "gss"]) {
			const problems = hbaRuleProblems([rule({ auth_method: method })]);
			assert.equal(problems.length, 1, method);
			assert.match(problems[0] ?? "", new RegExp(method));
		}
	});

	it("reports a rule the server could not parse, and an empty list", () => {
		assert.match(hbaRuleProblems([rule({ auth_method: null, error: "invalid authentication method" })]).join("\n"), /invalid authentication method/);
		assert.match(hbaRuleProblems([]).join("\n"), /no rule is active/);
	});
});

describe("the active authentication rules of the real stack", () => {
	let stack: TestStack;
	before(async () => {
		stack = await sharedStack();
	});
	after(async () => {
		await stack?.dispose();
	});

	it("are only scram-sha-256 and reject, and a wrong password is refused over TCP", async () => {
		assert.deepEqual(await checkActiveHba(stack.container), []);
		for (const role of ["af_api", "af_reader"]) assert.equal(await probeWrongPassword(stack.container, role), null, role);
	});

	it("both are part of the full check, and pass there", async () => {
		const results = await verifyInit({ container: stack.container });
		const names = results.filter((r) => /^authentication/.test(r.name));
		assert.equal(names.length, 2, results.map((r) => r.name).join("\n"));
		assert.deepEqual(names.filter((r) => !r.ok), []);
		assert.equal(CHECKS.filter((c) => /^authentication/.test(c.name)).length, 2);
	});
});

describe("a scratch server whose active rules are trust", () => {
	const PORT = 5499;
	const PG_BIN = "/usr/lib/postgresql/16/bin";
	let stack: TestStack;
	let dir = "";
	const asPostgres = (script: string) => run("docker", ["exec", "-u", "postgres", stack.container, "sh", "-c", script]);

	before(async () => {
		stack = await sharedStack();
		const made = await asPostgres("mktemp -d");
		assert.equal(made.code, 0, made.stderr);
		dir = made.stdout.trim();
		try {
			// Small, because it lives next to the real server in the same container.
			const started = await asPostgres(
				`${PG_BIN}/initdb -D ${dir}/data -U af_bootstrap --auth=trust >/dev/null && ` +
					`${PG_BIN}/pg_ctl -D ${dir}/data -w -l ${dir}/log -o "-p ${PORT} -c listen_addresses=127.0.0.1 -c max_connections=10 -c shared_buffers=16MB" start >/dev/null`,
			);
			assert.equal(started.code, 0, started.stderr + started.stdout);
			const made2 = await asPostgres(`${PG_BIN}/psql -X -q -At -p ${PORT} -U af_bootstrap -d postgres -c "CREATE ROLE af_api LOGIN PASSWORD 'unrelated'"`);
			assert.equal(made2.code, 0, made2.stderr);
		} catch (error) {
			await stop();
			throw error;
		}
	});

	// Only the server is stopped. The scratch directory (made by mktemp inside the container) is not deleted by a command of
	// the test, because no test deletes on its own (removal-guard). It lives in the container's writable layer, so removeOwned
	// deletes it with the container when the shared stack is disposed.
	const stop = async (): Promise<void> => {
		if (dir === "") return;
		await asPostgres(`${PG_BIN}/pg_ctl -D ${dir}/data stop -m immediate >/dev/null 2>&1; true`);
		dir = "";
	};
	after(async () => {
		await stop();
		await stack?.dispose();
	});

	it("the check reports the trust rule and names the file the server reads", async () => {
		const problems = await checkActiveHba(stack.container, { port: PORT });
		assert.ok(problems.length > 0, "a trust rule that is active must fail the check");
		assert.match(problems.join("\n"), /trust/);
		assert.match(problems.join("\n"), /pg_hba\.conf/);
	});

	it("the wrong-password login is accepted there, and the probe reports it", async () => {
		const problem = await probeWrongPassword(stack.container, "af_api", { database: "postgres", port: PORT });
		assert.notEqual(problem, null);
		assert.match(problem ?? "", /accepted/);
	});
});
