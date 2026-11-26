// The authentication part of deploy/verify-init.ts. A login that succeeds is not proof of the password in the secret file:
// a rule that lets any password in (trust), or one that lets a role in that must not come in over the network (the bootstrap
// superuser), makes the other checks meaningless. So the check has two halves:
//
//  - the rules the server reports (pg_hba_file_rules, read from the file on disk) are compared, in order, with the intended
//    rules (INTENDED_HBA_RULES, which a test keeps equal to deploy/postgres/pg_hba.conf);
//  - because that report is the file on disk and not necessarily what the running server loaded, the server's behaviour is
//    proven by logins: the bootstrap role is refused over TCP by the rules, and for every role that may log in the right
//    password is accepted and a wrong one refused.
//
// Sections:
//  - Unit: which rule lists are a problem (no database), and the intended list equals pg_hba.conf.
//  - The real stack (shared, read-only): clean rules, refusals, and every probe is part of the full check.
//  - A scratch server in the stack's container on another port as the postgres OS user, whose rules the tests set and
//    reload (or deliberately do not reload): the problems of each kind of bad rule set are reported, and where the file and
//    the loaded rules differ the live logins decide. The running stack is not touched (its hba_file is a start-time setting).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { APPLICATION_ROLES, BOOTSTRAP_ROLE, CHECKS, INTENDED_HBA_RULES, hbaRuleProblems, type HbaRule } from "../deploy/init-postconditions.ts";
import { run, tryPsql } from "../deploy/lib.ts";
import { checkActiveHba, probeRefusedByRules, probeWrongPassword, verifyInit } from "../deploy/verify-init.ts";
import { sharedStack, type TestStack } from "./helpers.ts";

const asReported = (rules: readonly (typeof INTENDED_HBA_RULES)[number][]): HbaRule[] =>
	rules.map((intended, index) => ({
		line_number: index + 1,
		type: intended.type,
		database: [...intended.database],
		user_name: [...intended.user_name],
		address: intended.address,
		auth_method: intended.auth_method,
		error: null,
	}));
const intendedReport = (): HbaRule[] => asReported(INTENDED_HBA_RULES);
const legacyBootstrap: HbaRule = { line_number: 99, type: "host", database: ["all"], user_name: [BOOTSTRAP_ROLE], address: "samenet", auth_method: "scram-sha-256", error: null };

describe("hbaRuleProblems", () => {
	it("accepts exactly the intended rules", () => {
		assert.deepEqual(hbaRuleProblems(intendedReport()), []);
	});

	it("INTENDED_HBA_RULES is the rule list of deploy/postgres/pg_hba.conf, line by line", () => {
		const file = readFileSync(new URL("../deploy/postgres/pg_hba.conf", import.meta.url), "utf8");
		const parsed = file
			.split(/\r?\n/)
			.map((line) => line.replace(/#.*/, "").trim())
			.filter((line) => line !== "")
			.map((line) => {
				const fields = line.split(/\s+/);
				const [type, database, user] = fields;
				const method = fields[fields.length - 1] as string;
				return { type, database: (database as string).split(","), user_name: (user as string).split(","), address: type === "local" ? null : (fields[3] as string), auth_method: method };
			});
		assert.deepEqual(parsed, INTENDED_HBA_RULES.map((rule) => ({ ...rule, database: [...rule.database], user_name: [...rule.user_name] })));
	});

	it("reports a legacy scram rule that lets af_bootstrap in over the network, whatever its method", () => {
		const rules = intendedReport();
		rules.splice(1, 0, legacyBootstrap);
		const problems = hbaRuleProblems(rules);
		assert.ok(problems.length > 0);
		assert.match(problems.join("\n"), /af_bootstrap/);
		assert.match(problems.join("\n"), /unexpected rule|must be/);
	});

	it("reports a missing bootstrap reject", () => {
		const rules = intendedReport();
		rules.splice(1, 1);
		const problems = hbaRuleProblems(rules);
		assert.ok(problems.length > 0);
		assert.match(problems.join("\n"), /reject/);
	});

	it("reports a reordering, an extra trailing rule, a missing last rule, and a changed role list", () => {
		const swapped = intendedReport();
		[swapped[1], swapped[2]] = [swapped[2] as HbaRule, swapped[1] as HbaRule];
		assert.ok(hbaRuleProblems(swapped).length > 0, "reordered");

		const extra = [...intendedReport(), { ...legacyBootstrap, line_number: 4 }];
		assert.match(hbaRuleProblems(extra).join("\n"), /line 4.*unexpected rule/);

		assert.match(hbaRuleProblems(intendedReport().slice(0, 2)).join("\n"), /is missing/);

		const widened = intendedReport();
		widened[2] = { ...(widened[2] as HbaRule), user_name: [...APPLICATION_ROLES, "af_bootstrap"] };
		assert.ok(hbaRuleProblems(widened).length > 0, "an extra role in the list");

		const otherNetwork = intendedReport();
		otherNetwork[2] = { ...(otherNetwork[2] as HbaRule), address: "all" };
		assert.ok(hbaRuleProblems(otherNetwork).length > 0, "a wider address");
	});

	it("reports every method that does not prove a password, on any of the rules: trust, peer, ident, md5, password, cert, gss", () => {
		for (const method of ["trust", "peer", "ident", "md5", "password", "cert", "gss"]) {
			for (const index of [0, 2]) {
				const rules = intendedReport();
				rules[index] = { ...(rules[index] as HbaRule), auth_method: method };
				const problems = hbaRuleProblems(rules);
				assert.equal(problems.length, 1, `${method} at rule ${index + 1}`);
				assert.match(problems[0] ?? "", new RegExp(method));
			}
		}
	});

	it("reports a rule the server could not parse, and an empty list", () => {
		const rules = intendedReport();
		rules[1] = { ...(rules[1] as HbaRule), auth_method: null, error: "invalid authentication method" };
		assert.match(hbaRuleProblems(rules).join("\n"), /invalid authentication method/);
		assert.match(hbaRuleProblems([]).join("\n"), /no rule is active/);
	});
});

describe("the authentication checks in the list of checks", () => {
	it("one wrong-password probe per role that may log in, one refusal probe for the bootstrap role, one rule comparison", () => {
		const authentication = CHECKS.filter((check) => /^authentication/.test(check.name));
		assert.equal(authentication.length, 2 + APPLICATION_ROLES.length, authentication.map((c) => c.name).join("\n"));
		for (const role of APPLICATION_ROLES) {
			assert.equal(authentication.filter((c) => c.kind === "login" && c.role === role && c.wrongPassword === true).length, 1, role);
		}
		assert.equal(authentication.filter((c) => c.kind === "refused" && c.role === BOOTSTRAP_ROLE).length, 1);
		assert.equal(authentication.filter((c) => c.kind === "hba").length, 1);
	});

	it("the superuser check of the role attributes is not repeated by a second check", () => {
		assert.equal(CHECKS.filter((c) => c.name === "no other role is a superuser").length, 0, "derived from the role attributes check");
		assert.equal(CHECKS.filter((c) => c.name.startsWith("role attributes:")).length, 1);
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

	it("are the intended ones, the bootstrap role is refused over TCP, and a wrong password is refused for every role", async () => {
		assert.deepEqual(await checkActiveHba(stack.container), []);
		assert.equal(await probeRefusedByRules(stack.container, BOOTSTRAP_ROLE, { database: "postgres" }), null);
		for (const role of APPLICATION_ROLES) assert.equal(await probeWrongPassword(stack.container, role), null, role);
	});

	it("all of them are part of the full check, and pass there", async () => {
		const results = await verifyInit({ container: stack.container });
		const names = results.filter((r) => /^authentication/.test(r.name));
		assert.equal(names.length, 2 + APPLICATION_ROLES.length, results.map((r) => r.name).join("\n"));
		assert.deepEqual(names.filter((r) => !r.ok), []);
	});
});

describe("a scratch server whose rules the tests set", () => {
	const PORT = 5499;
	const PG_BIN = "/usr/lib/postgresql/16/bin";
	const LOCAL = "local all all scram-sha-256";
	const BOOTSTRAP_REJECT = `host all ${BOOTSTRAP_ROLE} all reject`;
	const APPLICATION = `host agent_factory ${APPLICATION_ROLES.join(",")} samenet scram-sha-256`;
	const LEGACY_BOOTSTRAP = `host all ${BOOTSTRAP_ROLE} samenet scram-sha-256`;
	const INTENDED = [LOCAL, BOOTSTRAP_REJECT, APPLICATION];
	let stack: TestStack;
	let dir = "";
	const asPostgres = (script: string) => run("docker", ["exec", "-u", "postgres", stack.container, "sh", "-c", script]);
	const asRoot = (script: string) => run("docker", ["exec", stack.container, "sh", "-c", script]);
	const scratchPsql = `${PG_BIN}/psql -X -q -At -p ${PORT} -U ${BOOTSTRAP_ROLE} -d postgres`;

	// The file on disk only: the running server keeps the rules it loaded.
	const writeFile = async (lines: readonly string[]): Promise<void> => {
		const written = await asPostgres(`printf '%s\\n' ${lines.map((line) => `'${line}'`).join(" ")} > ${dir}/data/pg_hba.conf`);
		assert.equal(written.code, 0, written.stderr);
	};
	// The file, then a restart: the server really uses these rules.
	const load = async (lines: readonly string[]): Promise<void> => {
		await writeFile(lines);
		const restarted = await asPostgres(`${PG_BIN}/pg_ctl -D ${dir}/data -w -l ${dir}/log restart >/dev/null`);
		assert.equal(restarted.code, 0, restarted.stderr + restarted.stdout);
	};

	before(async () => {
		stack = await sharedStack();
		const made = await asPostgres("mktemp -d");
		assert.equal(made.code, 0, made.stderr);
		dir = made.stdout.trim();
		try {
			// Small, because it lives next to the real server in the same container.
			const started = await asPostgres(
				`${PG_BIN}/initdb -D ${dir}/data -U ${BOOTSTRAP_ROLE} --auth=trust >/dev/null && ` +
					`${PG_BIN}/pg_ctl -D ${dir}/data -w -l ${dir}/log -o "-p ${PORT} -c listen_addresses=127.0.0.1 -c max_connections=10 -c shared_buffers=16MB" start >/dev/null`,
			);
			assert.equal(started.code, 0, started.stderr + started.stdout);
			// The roles with the passwords of their secret files (read as root, which may read them), while the server still
			// trusts everyone; the tests then set the rules.
			const statements = [
				`ALTER ROLE ${BOOTSTRAP_ROLE} PASSWORD '$(cat /run/secrets/${BOOTSTRAP_ROLE})'`,
				...APPLICATION_ROLES.map((role) => `CREATE ROLE ${role} LOGIN PASSWORD '$(cat /run/secrets/${role})'`),
				"CREATE DATABASE agent_factory",
			];
			const prepared = await asRoot(statements.map((statement) => `${scratchPsql} -c "${statement}"`).join(" && "));
			assert.equal(prepared.code, 0, prepared.stderr);
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

	const refusedBootstrap = () => probeRefusedByRules(stack.container, BOOTSTRAP_ROLE, { database: "postgres", port: PORT });
	const wrongPassword = (role: string) => probeWrongPassword(stack.container, role, { database: "agent_factory", port: PORT });

	it("the intended rules: nothing is reported, the bootstrap role is refused, every role gets in with its password and not with another", async () => {
		await load(INTENDED);
		assert.deepEqual(await checkActiveHba(stack.container, { port: PORT }), []);
		assert.equal(await refusedBootstrap(), null);
		for (const role of APPLICATION_ROLES) {
			const right = await tryPsql(stack.container, role, "select 1;", { database: "agent_factory", tcp: true, port: PORT });
			assert.equal(right.code, 0, `${role}: ${right.stderr}`);
			assert.equal(await wrongPassword(role), null, role);
		}
	});

	it("a legacy scram rule for af_bootstrap: the rule comparison reports it, and the bootstrap login that gets in is reported", async () => {
		await load([LOCAL, LEGACY_BOOTSTRAP, BOOTSTRAP_REJECT, APPLICATION]);
		const problems = await checkActiveHba(stack.container, { port: PORT });
		assert.ok(problems.length > 0, "a rule that lets af_bootstrap in over the network must fail the check");
		assert.match(problems.join("\n"), /af_bootstrap/);
		assert.match(problems.join("\n"), /pg_hba\.conf/);
		assert.match((await refusedBootstrap()) ?? "", /accepted a login as af_bootstrap/);
	});

	it("a missing bootstrap reject: the rule comparison reports it", async () => {
		await load([LOCAL, APPLICATION]);
		const problems = await checkActiveHba(stack.container, { port: PORT });
		assert.ok(problems.length > 0, "the missing reject must fail the check");
		assert.match(problems.join("\n"), /reject/);
	});

	it("the file on disk is intended but the server still runs an older rule set: the rule comparison cannot see it, the logins do", async () => {
		await load([LOCAL, LEGACY_BOOTSTRAP, APPLICATION]);
		await writeFile(INTENDED);
		assert.deepEqual(await checkActiveHba(stack.container, { port: PORT }), [], "pg_hba_file_rules shows the file on disk");
		assert.match((await refusedBootstrap()) ?? "", /accepted a login as af_bootstrap/);
	});

	it("a loaded rule that lets one role in with any password, the file on disk being intended: the probe of that role reports it, the others pass", async () => {
		await load([LOCAL, BOOTSTRAP_REJECT, "host agent_factory af_reader samenet trust", APPLICATION]);
		await writeFile(INTENDED);
		assert.deepEqual(await checkActiveHba(stack.container, { port: PORT }), []);
		assert.match((await wrongPassword("af_reader")) ?? "", /accepted/);
		for (const role of APPLICATION_ROLES.filter((r) => r !== "af_reader")) assert.equal(await wrongPassword(role), null, role);
	});

	it("a trust rule: the rule comparison reports it, and a wrong password is accepted", async () => {
		await load([LOCAL, BOOTSTRAP_REJECT, "host agent_factory af_api,af_control,af_backup,af_reader,af_migrator samenet trust"]);
		const problems = await checkActiveHba(stack.container, { port: PORT });
		assert.match(problems.join("\n"), /trust/);
		assert.match((await wrongPassword("af_api")) ?? "", /accepted/);
	});
});
