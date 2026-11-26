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
// A real login with the password from the role's secret file.
export interface LoginCheck extends CheckBase {
	readonly kind: "login";
	readonly role: string;
}
export type Check = SqlCheck | ShellCheck | LoginCheck;

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

export const CHECKS: readonly Check[] = [
	{
		kind: "sql",
		name: "role af_bootstrap exists and is a superuser",
		covers: [],
		expression: `exists (select 1 from pg_roles where rolname = '${BOOTSTRAP_ROLE}' and rolsuper)`,
	},
	{
		kind: "sql",
		name: "no other role is a superuser",
		covers: [],
		expression: `not exists (select 1 from pg_roles where rolsuper and rolname <> '${BOOTSTRAP_ROLE}')`,
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
	// What the statements above cannot show: the passwords, and the connect grant itself as the server enforces it.
	...APPLICATION_ROLES.map((role): LoginCheck => ({ kind: "login", name: `login as ${role} to agent_factory with the password of its secret file`, covers: [], role })),
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
