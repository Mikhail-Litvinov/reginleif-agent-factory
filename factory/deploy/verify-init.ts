// Checks that a RUNNING database of this stack is completely initialised: every statement of init/10-roles.sh and
// init/lib/temporal.sql (the role and databases of Temporal) and every step of init/99-finish.sh left its result (the list is deploy/init-postconditions.ts, which a test keeps equal to the
// init scripts). It only reads. Used before marking a database that was made before the marker existed
// (docs/agent-factory/deployment.md "A start that refuses"): the marker is created only when every check passes.
//
//   node deploy/verify-init.ts [--project agent-factory | --container <container name>] [--with-marker] [--without-temporal]
//
// --container names the container directly, for one made by hand that belongs to no compose project (the upgrade and the
// restart-loop procedures); it cannot be combined with --project.
//
// Prints one line per check, `ok   <name>` or `FAIL <name>: <detail>`, and exits 0 when all pass, 1 when any fails, 2 on a
// wrong argument. --with-marker adds the check that the marker .af-init-complete exists (a database not yet marked fails
// that one by definition, so it is asked for only after marking). --without-temporal leaves the Temporal part out: the role
// af_temporal, its databases and its rule in pg_hba.conf are neither required nor forbidden, so a database made before
// Temporal existed passes before deploy/bootstrap-temporal.ts has run, and one that has it passes too (the rollback to
// the old revision). It is for the upgrade of such a stack, never for a new installation.
import { APPLICATION_ROLES, BOOTSTRAP_ROLE, CHECKS, HBA_RULES_SQL, buildChecks, hbaRuleProblems, type Check, type HbaRule, type SqlCheck } from "./init-postconditions.ts";
import { UsageError, parseCliArgs, reportCliFailure } from "./cli-args.ts";
import { DATABASE, findContainer, run, tryPsql } from "./lib.ts";

export interface CheckResult {
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
}

export interface VerifyOptions {
	readonly project?: string;
	// The container to check; found from the project when absent.
	readonly container?: string;
	readonly withMarker?: boolean;
	// Leave the Temporal part out: its role, databases and pg_hba rule are neither required nor forbidden (none is probed).
	// For the upgrade of a stack made before Temporal existed, and for the rollback of one that has it.
	readonly withoutTemporal?: boolean;
}

// The role whose login runs the catalog checks: the one the healthcheck uses anyway, with no rights beyond reading.
const CHECKING_ROLE = "af_backup";

const batchSql = (checks: readonly SqlCheck[]): string =>
	checks.map((check, index) => `select '${index}|' || coalesce((${check.expression})::text, 'false');`).join("\n") + "\n";

const failure = (check: Check, detail: string): CheckResult => ({ name: check.name, ok: false, detail });
const success = (check: Check): CheckResult => ({ name: check.name, ok: true, detail: "" });
const firstLine = (text: string, fallback: string): string => (text.trim() || fallback).split(/\r?\n/)[0] as string;

export interface ServerOptions {
	// A server other than the stack's own on this port (tests only: a scratch server in the same container).
	readonly port?: number;
	readonly database?: string;
}

// The problems of the rules the server really uses. Read as the bootstrap role over the socket (the only way that role may
// connect), from pg_hba_file_rules, so the file named by the server's hba_file is the one judged, not the data directory's.
export const checkActiveHba = async (container: string, options: ServerOptions & { readonly withoutTemporal?: boolean } = {}): Promise<string[]> => {
	const read = await tryPsql(container, BOOTSTRAP_ROLE, HBA_RULES_SQL, { database: "postgres", port: options.port });
	if (read.code !== 0) return [`could not read the active rules: ${firstLine(read.stderr || read.stdout, `exit ${read.code}`)}`];
	let parsed: { file: string; stale: boolean | null; rules: HbaRule[] };
	try {
		parsed = JSON.parse(read.stdout.trim()) as { file: string; stale: boolean | null; rules: HbaRule[] };
	} catch {
		return [`could not read the active rules: unexpected answer ${firstLine(read.stdout, "(empty)")}`];
	}
	// pg_hba_file_rules is the file on disk. It is the loaded set only when the file is not newer than the last load; the
	// logins prove the loaded set from inside the container (loopback) only, so a rule for another source (the Docker
	// subnet) is judged by the file, which must therefore be the loaded one. Anything but a plain false fails.
	const problems = hbaRuleProblems(parsed.rules, options.withoutTemporal !== true);
	if (parsed.stale !== false) problems.push("the file was modified after the server last loaded it (or its age is unknown): the rules shown are not proven to be the ones the server runs; reload or restart the server");
	return problems.map((problem) => `${problem} (active file ${parsed.file})`);
};

// One login over TCP with a password that is in no secret file. null when the server refuses it, as it must; the problem
// when it lets the login in (a rule that does not ask for the password is active) or fails for another reason.
export const probeWrongPassword = async (container: string, role: string, options: ServerOptions = {}): Promise<string | null> => {
	const attempt = await tryPsql(container, role, "select 1;", { database: options.database ?? DATABASE, tcp: true, port: options.port, wrongPassword: true });
	if (attempt.code === 0) return `the server accepted a login as ${role} with a password that is not in its secret file: an active rule does not ask for the password`;
	if (/password authentication failed/i.test(attempt.stderr)) return null;
	return `the login as ${role} with a wrong password failed, but not for the password: ${firstLine(attempt.stderr, `exit ${attempt.code}`)}`;
};

// One login over TCP as `role` with the password of its own secret file, which the rules must refuse (the bootstrap role:
// "host all af_bootstrap all reject"). null when the server refuses it because of pg_hba.conf, as it must; the problem when it
// lets the login in (a legacy rule, or a file changed on disk that the server never loaded) or fails for another reason
// (a wrong password would also refuse, but that is no proof of the rules).
export const probeRefusedByRules = async (container: string, role: string, options: ServerOptions = {}): Promise<string | null> => {
	const attempt = await tryPsql(container, role, "select 1;", { database: options.database ?? DATABASE, tcp: true, port: options.port });
	if (attempt.code === 0) return `the server accepted a login as ${role} over TCP: no active rule refuses it`;
	if (/pg_hba\.conf/i.test(attempt.stderr)) return null;
	return `the login as ${role} over TCP failed, but not because of the rules: ${firstLine(attempt.stderr, `exit ${attempt.code}`)}`;
};

export const verifyInit = async (options: VerifyOptions = {}): Promise<CheckResult[]> => {
	const container = options.container ?? (await findContainer(options.project ?? "agent-factory"));
	const checks = (options.withoutTemporal ? buildChecks(false) : CHECKS).filter((check) => !(check.kind === "shell" && check.isMarker && !options.withMarker));
	const sqlChecks = checks.filter((check): check is SqlCheck => check.kind === "sql");

	// All catalog checks in one session; the answer is one line per check. A failing session (the role cannot log in, the
	// database is gone) fails every one of them with the server's words, never a pass.
	const runBatch = async (): Promise<{ verdicts: Map<number, string>; sqlProblem: string }> => {
		const verdicts = new Map<number, string>();
		const batch = await tryPsql(container, CHECKING_ROLE, batchSql(sqlChecks), { database: DATABASE, tcp: true });
		if (batch.code !== 0) {
			return { verdicts, sqlProblem: `could not run the catalog checks as ${CHECKING_ROLE}: ${firstLine(batch.stderr || batch.stdout, `exit ${batch.code}`)}` };
		}
		for (const line of batch.stdout.split(/\r?\n/)) {
			const match = /^(\d+)\|(.*)$/.exec(line.trim());
			if (match) verdicts.set(Number(match[1]), match[2] as string);
		}
		return { verdicts, sqlProblem: "" };
	};
	const batchResult = runBatch();

	// The catalog batch, the logins, the rule check and the shell checks are independent reads (one docker exec each), so
	// they run together; the results keep the order of CHECKS.
	const resultOf = async (check: Check): Promise<CheckResult> => {
		if (check.kind === "sql") {
			const { verdicts, sqlProblem } = await batchResult;
			const index = sqlChecks.indexOf(check);
			const verdict = verdicts.get(index);
			return sqlProblem ? failure(check, sqlProblem) : verdict === "true" ? success(check) : failure(check, verdict === undefined ? "no answer" : "the postcondition does not hold");
		}
		if (check.kind === "hba") {
			const problems = await checkActiveHba(container, { withoutTemporal: options.withoutTemporal });
			return problems.length === 0 ? success(check) : failure(check, problems.join("; "));
		}
		if (check.kind === "refused") {
			const answers = await Promise.all(check.databases.map(async (database) => {
				const problem = await probeRefusedByRules(container, check.role, { database });
				return problem === null ? null : `database ${database}: ${problem}`;
			}));
			const problems = answers.filter((problem): problem is string => problem !== null);
			return problems.length === 0 ? success(check) : failure(check, problems.join("; "));
		}
		if (check.kind === "login" && check.wrongPassword) {
			const problem = await probeWrongPassword(container, check.role, { database: check.database });
			return problem === null ? success(check) : failure(check, problem);
		}
		if (check.kind === "login") {
			const attempt = await tryPsql(container, check.role, "select 1;", { database: check.database ?? DATABASE, tcp: true });
			return attempt.code === 0 && attempt.stdout.trim() === "1" ? success(check) : failure(check, firstLine(attempt.stderr, `exit ${attempt.code}`));
		}
		const attempt = await run("docker", ["exec", "-u", "postgres", container, "sh", "-c", check.script]);
		return attempt.code === 0 ? success(check) : failure(check, firstLine(attempt.stdout || attempt.stderr, `exit ${attempt.code}`));
	};
	return Promise.all(checks.map(resultOf));
};

export const formatResults = (results: readonly CheckResult[]): string[] =>
	results.map((result) => (result.ok ? `ok   ${result.name}` : `FAIL ${result.name}: ${result.detail}`));

if (import.meta.main) {
	try {
		const { values, present } = parseCliArgs(process.argv.slice(2), { flags: { "--project": "value", "--container": "value", "--with-marker": "boolean", "--without-temporal": "boolean" } });
		if (values["--project"] !== undefined && values["--container"] !== undefined) throw new UsageError("--container and --project cannot be used together");
		const results = await verifyInit({ project: values["--project"] ?? "agent-factory", container: values["--container"], withMarker: present.has("--with-marker"), withoutTemporal: present.has("--without-temporal") });
		for (const line of formatResults(results)) console.log(line);
		const failed = results.filter((result) => !result.ok).length;
		if (failed > 0) {
			console.error(`${failed} of ${results.length} checks failed: this database is not completely initialised; do not mark it, restore from a known-good backup.`);
			process.exitCode = 1;
		} else {
			console.log(present.has("--without-temporal") ? `all ${results.length} checks passed (${APPLICATION_ROLES.length} application roles; Temporal not checked).` : `all ${results.length} checks passed (${APPLICATION_ROLES.length} application roles and the Temporal role).`);
		}
	} catch (error) {
		reportCliFailure(error, "verify-init failed", "usage: node deploy/verify-init.ts [--project agent-factory | --container <container name>] [--with-marker] [--without-temporal]");
	}
}
