// What a completely initialised database looks like: one check for every statement of init/10-roles.sh and every step of
// init/99-finish.sh. deploy/verify-init.ts runs them; tests/verify-init.test.ts proves that no statement of the init
// scripts is left without a check (and no check names a statement that is gone), so the two cannot drift apart.
//
// Every check only reads: a SQL expression over the catalogs (they are readable by any role, so the check logs in as
// af_backup, whose login the healthcheck uses anyway), or a read-only shell test in the container. The password of a
// role is not in the catalogs (pg_authid is superuser-only), so each application role gets a real login check instead.

export const APPLICATION_ROLES = ["af_migrator", "af_api", "af_control", "af_backup", "af_reader"] as const;
export const BOOTSTRAP_ROLE = "af_bootstrap";
// Roles that get CONNECT on the application database (the owner, af_migrator, holds it as owner).
const CONNECTING_ROLES = ["af_api", "af_control", "af_backup", "af_reader"] as const;
const READER_CONNECTION_LIMIT = 5;

// The pattern init/99-finish.sh greps the data directory's pg_hba.conf with (a test keeps the two equal).
export const TRUST_RULE_PATTERN = "^[[:space:]]*(local|host|hostssl|hostnossl|hostgssenc|hostnogssenc)[[:space:]].*[[:space:]]trust([[:space:]]|$)";
export const MARKER_NAME = ".af-init-complete";

interface CheckBase {
	readonly name: string;
	// The statements (init/10-roles.sh, normalised: no password clause, no trailing semicolon) or steps (init/99-finish.sh,
	// as written below) this check proves. Empty for a check that proves context rather than a statement.
	readonly covers: readonly string[];
}
// `expression` is a SQL boolean evaluated in the application database.
export interface SqlCheck extends CheckBase {
	readonly kind: "sql";
	readonly expression: string;
}
// `script` runs with `sh -c` as the server user in the container and passes on exit status 0.
export interface ShellCheck extends CheckBase {
	readonly kind: "shell";
	readonly script: string;
	// The check belongs to the last step of the init (the marker); it is run on request only (see verify-init.ts).
	readonly isMarker?: boolean;
}
// A real login with the password from the role's secret file; with `wrongPassword` the opposite: a login with a password
// that is no role's secret must be REFUSED (a trust rule in the active configuration would let it in, and then a
// successful login with the right password proves nothing).
export interface LoginCheck extends CheckBase {
	readonly kind: "login";
	readonly role: string;
	readonly wrongPassword?: boolean;
}
// The rules the running server really uses (pg_hba_file_rules, read as the bootstrap role over the socket), not the file
// in the data directory, which may not be the active one (the stack starts the server with hba_file=/etc/...).
export interface HbaCheck extends CheckBase {
	readonly kind: "hba";
}
// A login over TCP as `role` with the password of its secret file that the server must REFUSE because of its rules (a
// reject rule, or no rule at all), not because of a wrong password: a rule that would let the role in by its password fails
// it. The rules in pg_hba_file_rules are read from the file on disk; this is what the running server really does.
export interface RefusalCheck extends CheckBase {
	readonly kind: "refused";
	readonly role: string;
	// Every database of the cluster that accepts connections: a loaded rule may let the role into one of them only.
	readonly databases: readonly string[];
}
export type Check = SqlCheck | ShellCheck | LoginCheck | HbaCheck | RefusalCheck;

export const FINISH_REMOVES_SERVICE_FILE = "99-finish: the bootstrap service file is removed";
export const FINISH_NO_TRUST_RULE = "99-finish: no trust rule in the data directory's pg_hba.conf";
export const FINISH_MARKER = "99-finish: the marker .af-init-complete exists";

const attributes = "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS";

const roleCheck = (role: string): SqlCheck => {
	const limit = role === "af_reader" ? READER_CONNECTION_LIMIT : -1;
	return {
		kind: "sql",
		name: `role ${role}: login, no superuser, no createdb, no createrole, no replication, no bypassrls, connection limit ${limit}`,
		covers: [`CREATE ROLE ${role} ${attributes}${role === "af_reader" ? ` CONNECTION LIMIT ${READER_CONNECTION_LIMIT}` : ""}`],
		expression: `exists (select 1 from pg_roles where rolname = '${role}' and rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole and not rolreplication and not rolbypassrls and rolconnlimit = ${limit})`,
	};
};

const roleSetting = (role: string, setting: string, value: string, statement: string): SqlCheck => ({
	kind: "sql",
	name: `role ${role}: ${setting} = ${value}`,
	covers: [statement],
	expression: `exists (select 1 from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname = '${role}' and s.setdatabase = 0 and s.setconfig @> array['${setting}=${value}'])`,
});

// The rights of PUBLIC (grantee 0) on a database, the built-in default included for a database nobody ever granted on.
const publicOnDatabase = (database: string, privilege?: string): string =>
	`exists (select 1 from pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a where d.datname = '${database}' and a.grantee = 0${privilege ? ` and a.privilege_type = '${privilege}'` : ""})`;

const publicOnPublicSchema = (privilege: string): string =>
	`exists (select 1 from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a where n.nspname = 'public' and a.grantee = 0 and a.privilege_type = '${privilege}')`;

const roleList = (roles: readonly string[]): string => roles.map((r) => `'${r}'`).join(", ");

// `kind` is the pg_default_acl object type: r tables, S sequences. Exactly SELECT, nothing more.
const defaultSelectOnly = (kind: "r" | "S", statement: string, label: string): SqlCheck => ({
	kind: "sql",
	name: `default privileges: af_backup gets exactly select on new ${label} of af_migrator in schema public`,
	covers: [statement],
	expression: `(select coalesce(array_agg(a.privilege_type order by a.privilege_type), '{}') from pg_default_acl d join pg_roles o on o.oid = d.defaclrole join pg_namespace n on n.oid = d.defaclnamespace join lateral aclexplode(d.defaclacl) a on true join pg_roles g on g.oid = a.grantee where o.rolname = 'af_migrator' and n.nspname = 'public' and d.defaclobjtype = '${kind}' and g.rolname = 'af_backup') = array['SELECT']::text[]`,
});

// ---- the whole intended policy, not only the grants init writes ----
// What every role may do right after the init, as one definition the checks below are built from. An extra membership,
// an extra grant, a schema or table nobody intended is a difference from it. Later phases that add objects or grants
// (migrations) extend this definition together with their grants.
const OWNER_ROLE = "af_migrator";
const BACKUP_ROLE = "af_backup";
const PRIVILEGES = {
	database: ["CONNECT", "CREATE", "TEMPORARY"],
	schema: ["USAGE", "CREATE"],
	table: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"],
	sequence: ["USAGE", "SELECT", "UPDATE"],
	function: ["EXECUTE"],
} as const;
type ObjectKind = keyof typeof PRIVILEGES;

// Does `role` hold `privilege` on an object of that kind, in the application database (the database itself, schema public,
// and the objects of schema public)? The owner holds everything; the others only what init grants them: CONNECT and USAGE,
// SELECT on tables and sequences for the backup role (its default privileges), EXECUTE on functions (PUBLIC's default).
export const intendedPrivilege = (kind: ObjectKind, role: string, privilege: string): boolean => {
	if (kind === "function") return true;
	if (role === OWNER_ROLE) return true;
	if (kind === "database") return privilege === "CONNECT";
	if (kind === "schema") return privilege === "USAGE";
	return role === BACKUP_ROLE && privilege === "SELECT";
};

// Rows (role, privilege, allowed) joined to the roles that exist (a missing role is a failure of the role checks, not of this).
const wanted = (kind: ObjectKind, allowed: (role: string, privilege: string) => boolean = (role, privilege) => intendedPrivilege(kind, role, privilege)): string => {
	const rows = APPLICATION_ROLES.flatMap((role) => PRIVILEGES[kind].map((privilege) => `('${role}', '${privilege}', ${allowed(role, privilege)})`));
	return `(values ${rows.join(", ")}) as w(role, priv, allowed) join pg_roles r on r.rolname = w.role`;
};

const notExtensionMember = (alias: string, catalog: "pg_class" | "pg_proc"): string =>
	`not exists (select 1 from pg_depend d where d.classid = '${catalog}'::regclass and d.objid = ${alias}.oid and d.deptype = 'e')`;
const RELATIONS = "c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')";
const SEQUENCES = "c.relnamespace = 'public'::regnamespace and c.relkind = 'S'";
const ownerOid = `(select oid from pg_roles where rolname = '${OWNER_ROLE}')`;

// Sorted the way the database sorts under COLLATE "C" (plain byte order), so the two lists compare equal.
const sortedC = (values: readonly string[]): string[] => [...values].sort();
const textArray = (values: readonly string[]): string => `array[${sortedC(values).map((v) => `'${v}'`).join(", ")}]::text[]`;

const ALL_ROLE_NAMES = [BOOTSTRAP_ROLE, ...APPLICATION_ROLES];

// The only default-privilege entries of the database, written `owner|schema|object type|grantee|privilege`; the owner's own
// entry (it always has one once a default is set) is not a grant to anyone else and is left out.
const INTENDED_DEFAULT_ENTRIES = ["r", "S"].map((kind) => `${OWNER_ROLE}|public|${kind}|${BACKUP_ROLE}|SELECT`);

const policyChecks: readonly SqlCheck[] = [
	{
		kind: "sql",
		name: "role set: only af_bootstrap and the five application roles exist (besides the predefined pg_ roles)",
		covers: [],
		expression: `(select coalesce(array_agg(rolname::text order by rolname::text collate "C"), '{}') from pg_roles where rolname !~ '^pg_') = ${textArray(ALL_ROLE_NAMES)}`,
	},
	{
		kind: "sql",
		name: "role attributes: no role besides af_bootstrap is a superuser, may create roles or databases, replicate or bypass row security",
		covers: [],
		expression: `not exists (select 1 from pg_roles where rolname <> '${BOOTSTRAP_ROLE}' and (rolsuper or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls))`,
	},
	{
		kind: "sql",
		name: "role memberships: no role that is not a predefined pg_ role is a member of a role or has members",
		covers: [],
		expression: "not exists (select 1 from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member where g.rolname !~ '^pg_' or u.rolname !~ '^pg_')",
	},
	{
		kind: "sql",
		name: "schema ownership: public belongs to pg_database_owner, pg_catalog and information_schema to af_bootstrap, no other schema exists",
		covers: [],
		expression:
			"(select count(*) from pg_namespace where nspname = 'public' and pg_get_userbyid(nspowner) = 'pg_database_owner') = 1" +
			` and not exists (select 1 from pg_namespace where nspname in ('pg_catalog', 'information_schema') and pg_get_userbyid(nspowner) <> '${BOOTSTRAP_ROLE}')` +
			" and not exists (select 1 from pg_namespace where nspname not in ('public', 'information_schema') and nspname !~ '^pg_')",
	},
	{
		kind: "sql",
		name: "database ownership: af_migrator owns agent_factory, af_bootstrap owns postgres, template0 and template1",
		covers: [],
		expression:
			`(select count(*) from pg_database where datname = 'agent_factory' and pg_get_userbyid(datdba) = '${OWNER_ROLE}') = 1` +
			` and not exists (select 1 from pg_database where datname in ('postgres', 'template0', 'template1') and pg_get_userbyid(datdba) <> '${BOOTSTRAP_ROLE}')`,
	},
	{
		kind: "sql",
		name: "database privileges: the application roles hold exactly the intended rights on agent_factory, and cannot connect to postgres or template1",
		covers: [],
		expression:
			`not exists (select 1 from ${wanted("database")} where has_database_privilege(r.oid, 'agent_factory', w.priv) <> w.allowed)` +
			` and not exists (select 1 from ${wanted("database", () => false)} cross join (values ('postgres'), ('template1')) as db(name) where w.priv = 'CONNECT' and has_database_privilege(r.oid, db.name, 'CONNECT'))`,
	},
	{
		kind: "sql",
		name: "schema privileges: the application roles hold exactly the intended rights on schema public",
		covers: [],
		expression: `not exists (select 1 from ${wanted("schema")} where has_schema_privilege(r.oid, 'public', w.priv) <> w.allowed)`,
	},
	{
		kind: "sql",
		name: "schema public: every table, view, sequence and function that is not part of an extension is owned by af_migrator",
		covers: [],
		expression:
			`not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and ${notExtensionMember("c", "pg_class")} and c.relowner is distinct from ${ownerOid})` +
			` and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and ${notExtensionMember("p", "pg_proc")} and p.proowner is distinct from ${ownerOid})`,
	},
	{
		kind: "sql",
		name: "schema public: effective privileges on tables and views are exactly the intended ones",
		covers: [],
		expression: `not exists (select 1 from ${wanted("table")}, pg_class c where ${RELATIONS} and ${notExtensionMember("c", "pg_class")} and has_table_privilege(r.oid, c.oid, w.priv) <> w.allowed)`,
	},
	{
		kind: "sql",
		name: "schema public: effective privileges on sequences are exactly the intended ones",
		covers: [],
		expression: `not exists (select 1 from ${wanted("sequence")}, pg_class c where ${SEQUENCES} and ${notExtensionMember("c", "pg_class")} and has_sequence_privilege(r.oid, c.oid, w.priv) <> w.allowed)`,
	},
	{
		kind: "sql",
		name: "schema public: effective privileges on functions are exactly the intended ones",
		covers: [],
		expression: `not exists (select 1 from ${wanted("function")}, pg_proc p where p.pronamespace = 'public'::regnamespace and ${notExtensionMember("p", "pg_proc")} and has_function_privilege(r.oid, p.oid, w.priv) <> w.allowed)`,
	},
	{
		kind: "sql",
		name: "schema public: no column-level privileges on any table or view",
		covers: [],
		expression: `not exists (select 1 from pg_attribute a join pg_class c on c.oid = a.attrelid where ${RELATIONS} and ${notExtensionMember("c", "pg_class")} and a.attacl is not null)`,
	},
	{
		kind: "sql",
		name: "default privileges: no entry beyond af_backup select on new tables and sequences of af_migrator in schema public",
		covers: [],
		expression:
			"(select coalesce(array_agg(e order by e collate \"C\"), '{}') from (select pg_get_userbyid(d.defaclrole) || '|' || coalesce((select nspname::text from pg_namespace where oid = d.defaclnamespace), '*') || '|' || d.defaclobjtype::text || '|' || case a.grantee when 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end || '|' || a.privilege_type as e from pg_default_acl d, aclexplode(d.defaclacl) a where a.grantee <> d.defaclrole) x)" +
			` = ${textArray(INTENDED_DEFAULT_ENTRIES)}`,
	},
];

// ---- authentication ----
// A row of pg_hba_file_rules, the rules the running server uses.
export interface HbaRule {
	readonly line_number: number;
	readonly type: string;
	readonly database: string[] | null;
	readonly user_name: string[] | null;
	readonly address: string | null;
	readonly auth_method: string | null;
	readonly error: string | null;
}
// The rules of deploy/postgres/pg_hba.conf, in file order (the first matching rule decides, so the order is part of the
// policy). A test keeps this list equal to the file. Every method is a password proven by scram, or a rejection: trust,
// peer, ident, md5, password, cert, gss... would let a login in without proving the password of the secret file. The
// bootstrap superuser works over the socket only (the first rule), its network rule is a reject, and the application roles
// reach only the application database from the server's own subnet.
export interface IntendedHbaRule {
	readonly type: string;
	readonly database: readonly string[];
	readonly user_name: readonly string[];
	readonly address: string | null;
	readonly auth_method: string;
}
export const INTENDED_HBA_RULES: readonly IntendedHbaRule[] = [
	{ type: "local", database: ["all"], user_name: ["all"], address: null, auth_method: "scram-sha-256" },
	{ type: "host", database: ["all"], user_name: [BOOTSTRAP_ROLE], address: "all", auth_method: "reject" },
	{ type: "host", database: ["agent_factory"], user_name: APPLICATION_ROLES, address: "samenet", auth_method: "scram-sha-256" },
];
// One JSON line: the file the server reads, whether that file was modified after the server last loaded its configuration
// (`stale`: pg_hba_file_rules then shows rules the server does not run), and its rules.
export const HBA_RULES_SQL =
	"select jsonb_build_object('file', current_setting('hba_file'), 'stale', (pg_stat_file(current_setting('hba_file'))).modification > pg_conf_load_time(), 'rules', coalesce((select jsonb_agg(to_jsonb(r) order by r.line_number) from (select line_number, type, database, user_name, address, auth_method, error from pg_hba_file_rules) r), '[]'::jsonb))::text;";

const describeRule = (rule: { type: string; database: readonly string[] | null; user_name: readonly string[] | null; address: string | null; auth_method: string | null }): string =>
	[rule.type, (rule.database ?? []).join(",") || "(none)", (rule.user_name ?? []).join(",") || "(none)", rule.address, rule.auth_method ?? "(none)"].filter((part) => part !== null).join(" ");

const sameList = (a: readonly string[] | null, b: readonly string[]): boolean => a !== null && a.length === b.length && a.every((value, index) => value === b[index]);

// The rules the server reports, compared in order with INTENDED_HBA_RULES: a legacy rule, a missing reject, a reordering
// or a different method each show as a difference at the line where it happens.
export const hbaRuleProblems = (rules: readonly HbaRule[]): string[] => {
	if (rules.length === 0) return ["no rule is active (pg_hba_file_rules is empty)"];
	const problems: string[] = [];
	rules.forEach((rule, index) => {
		if (rule.error) {
			problems.push(`line ${rule.line_number}: the server cannot use this rule: ${rule.error}`);
			return;
		}
		const intended = INTENDED_HBA_RULES[index];
		if (intended === undefined) {
			problems.push(`line ${rule.line_number}: an unexpected rule after the intended ones: "${describeRule(rule)}"`);
		} else if (rule.type !== intended.type || !sameList(rule.database, intended.database) || !sameList(rule.user_name, intended.user_name) || rule.address !== intended.address || rule.auth_method !== intended.auth_method) {
			problems.push(`line ${rule.line_number}: the rule number ${index + 1} must be "${describeRule(intended)}" but is "${describeRule(rule)}"`);
		}
	});
	for (const missing of INTENDED_HBA_RULES.slice(rules.length)) problems.push(`the intended rule "${describeRule(missing)}" is missing`);
	return problems;
};

export const CHECKS: readonly Check[] = [
	{
		kind: "sql",
		name: "role af_bootstrap exists and is a superuser",
		covers: [],
		expression: `exists (select 1 from pg_roles where rolname = '${BOOTSTRAP_ROLE}' and rolsuper)`,
	},
	...APPLICATION_ROLES.map(roleCheck),
	roleSetting("af_reader", "default_transaction_read_only", "on", "ALTER ROLE af_reader SET default_transaction_read_only = on"),
	roleSetting("af_reader", "statement_timeout", "30s", "ALTER ROLE af_reader SET statement_timeout = '30s'"),
	{
		kind: "sql",
		name: "database postgres: PUBLIC cannot connect",
		covers: ["REVOKE CONNECT ON DATABASE postgres FROM PUBLIC"],
		expression: `not ${publicOnDatabase("postgres", "CONNECT")}`,
	},
	{
		kind: "sql",
		name: "database template1: PUBLIC cannot connect",
		covers: ["REVOKE CONNECT ON DATABASE template1 FROM PUBLIC"],
		expression: `not ${publicOnDatabase("template1", "CONNECT")}`,
	},
	{
		kind: "sql",
		name: "database agent_factory exists and af_migrator owns it",
		covers: ["CREATE DATABASE agent_factory OWNER af_migrator"],
		expression: "exists (select 1 from pg_database d join pg_roles o on o.oid = d.datdba where d.datname = 'agent_factory' and o.rolname = 'af_migrator')",
	},
	{
		kind: "sql",
		name: "database agent_factory: PUBLIC holds no right",
		covers: ["REVOKE ALL ON DATABASE agent_factory FROM PUBLIC"],
		expression: `not ${publicOnDatabase("agent_factory")}`,
	},
	{
		kind: "sql",
		name: "database agent_factory: af_api, af_control, af_backup and af_reader may connect",
		covers: ["GRANT CONNECT ON DATABASE agent_factory TO af_api, af_control, af_backup, af_reader"],
		expression: `(select count(distinct r.rolname) from pg_database d, aclexplode(d.datacl) a join pg_roles r on r.oid = a.grantee where d.datname = 'agent_factory' and a.privilege_type = 'CONNECT' and r.rolname in (${roleList(CONNECTING_ROLES)})) = ${CONNECTING_ROLES.length}`,
	},
	{
		kind: "sql",
		name: "extension vector is installed in agent_factory",
		covers: ["CREATE EXTENSION vector"],
		expression: "exists (select 1 from pg_extension where extname = 'vector')",
	},
	{
		kind: "sql",
		name: "schema public: PUBLIC cannot create",
		covers: ["REVOKE CREATE ON SCHEMA public FROM PUBLIC"],
		expression: `not ${publicOnPublicSchema("CREATE")}`,
	},
	{
		kind: "sql",
		name: "schema public: af_api, af_control, af_backup and af_reader hold usage",
		covers: ["GRANT USAGE ON SCHEMA public TO af_api, af_control, af_backup, af_reader"],
		expression: `(select count(distinct r.rolname) from pg_namespace n, aclexplode(n.nspacl) a join pg_roles r on r.oid = a.grantee where n.nspname = 'public' and a.privilege_type = 'USAGE' and r.rolname in (${roleList(CONNECTING_ROLES)})) = ${CONNECTING_ROLES.length}`,
	},
	defaultSelectOnly("r", "ALTER DEFAULT PRIVILEGES FOR ROLE af_migrator IN SCHEMA public GRANT SELECT ON TABLES TO af_backup", "tables"),
	defaultSelectOnly("S", "ALTER DEFAULT PRIVILEGES FOR ROLE af_migrator IN SCHEMA public GRANT SELECT ON SEQUENCES TO af_backup", "sequences"),
	// Everything beyond the statements above: the whole intended policy (memberships, ownership, effective privileges).
	...policyChecks,
	// What the statements above cannot show: the passwords, and the connect grant itself as the server enforces it.
	...APPLICATION_ROLES.map((role): LoginCheck => ({ kind: "login", name: `login as ${role} to agent_factory with the password of its secret file`, covers: [], role })),
	// A login that works proves the password only when no active rule lets any password in. The rules the server reports
	// are compared with the intended ones; because that report comes from the file on disk (not necessarily what the
	// server loaded), the server's behaviour is proven too: the bootstrap role is refused over TCP, and every role that
	// may log in is refused with a wrong password (its right password is accepted by the login checks above).
	{
		kind: "hba",
		name: "authentication: the active rules are exactly the intended ones (pg_hba_file_rules)",
		covers: [],
	},
	{
		kind: "refused",
		name: `authentication: a login as ${BOOTSTRAP_ROLE} over TCP is refused by the rules in every database even with the right password`,
		covers: [],
		role: BOOTSTRAP_ROLE,
		// All databases of the cluster that accept connections (template0 does not): initdb makes postgres and template1, init/10-roles.sh agent_factory.
		databases: ["postgres", "agent_factory", "template1"],
	},
	...APPLICATION_ROLES.map((role): LoginCheck => ({
		kind: "login",
		name: `authentication: a login as ${role} over TCP with a password that is in no secret file is refused`,
		covers: [],
		role,
		wrongPassword: true,
	})),
	{
		kind: "shell",
		name: FINISH_REMOVES_SERVICE_FILE,
		covers: [FINISH_REMOVES_SERVICE_FILE],
		// The wrapper's service file lives in /dev/shm/af-init.*; an unmatched glob stays literal and is not a file.
		script: 'for f in /dev/shm/af-init.*/service.*; do if [ -e "$f" ]; then echo "$f exists"; exit 1; fi; done',
	},
	{
		kind: "shell",
		name: FINISH_NO_TRUST_RULE,
		covers: [FINISH_NO_TRUST_RULE],
		// grep: 0 = a trust rule is there, 1 = none, 2 = the file cannot be read (which is a failure too).
		script: `grep -Eq '${TRUST_RULE_PATTERN}' "\${PGDATA:-/var/lib/postgresql/data}/pg_hba.conf"; [ $? -eq 1 ]`,
	},
	{
		kind: "shell",
		name: FINISH_MARKER,
		covers: [FINISH_MARKER],
		script: `test -e "\${PGDATA:-/var/lib/postgresql/data}/${MARKER_NAME}"`,
		isMarker: true,
	},
];

// Every statement of init/10-roles.sh as `covers` writes it: the quoted statements of the script, and the CREATE ROLE
// printf lines without their password clause. Used by the test that every statement has a check.
export const statementsOfRolesScript = (source: string): string[] => {
	const found: string[] = [];
	for (const line of source.split(/\r?\n/)) {
		const create = /^\s*printf "(CREATE ROLE \w+ LOGIN) PASSWORD '%s' ([^"]*?);\\n"/.exec(line);
		if (create) {
			found.push(`${create[1]} ${create[2]}`.replace(/;$/, ""));
			continue;
		}
		const quoted = /^\s*"((?:ALTER|REVOKE|GRANT|CREATE|DROP) [^"]*);"/.exec(line);
		if (quoted) found.push(quoted[1] as string);
	}
	return found;
};
