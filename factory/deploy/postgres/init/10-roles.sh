#!/bin/bash
# First-start initialisation of the Agent Factory database (docker-entrypoint runs it once, on an empty data directory,
# against a temporary server that listens on the unix socket only).
#
# Creates the application database and the five application roles of docs/agent-factory/database.md "Accounts and
# rights". The only superuser is the bootstrap role af_bootstrap that the image makes from POSTGRES_USER; it is used by
# this script and by recovery, never by a service, a script or a person in daily work, and pg_hba.conf refuses it
# over the network.
#
# Passwords come from the secret files in /run/secrets (compose secrets). They go to psql through its standard input,
# never through a command line or an environment variable, and error statements are not logged (see below).
#
# Extensions: pg_trgm is marked trusted, so af_migrator (owner of the database, so it holds CREATE on it) creates it in
# a phase 2 migration. vector is NOT trusted (its control file has no `trusted = true`), so it is created here by the
# superuser; the migration step needs nothing more for it.

# The entrypoint sources this file when it is not executable (a Windows bind mount), so no `exit` here.
# af_password and af_psql_bootstrap are shared with 20-temporal.sh.
. /docker-entrypoint-initdb.d/lib/bootstrap.sh

af_init_roles() {
	local migrator api control backup reader
	af_password af_migrator && migrator="$REPLY" || return 1
	af_password af_api && api="$REPLY" || return 1
	af_password af_control && control="$REPLY" || return 1
	af_password af_backup && backup="$REPLY" || return 1
	af_password af_reader && reader="$REPLY" || return 1

	{
		# A failing CREATE ROLE would otherwise log its statement, password included.
		printf 'SET log_min_error_statement = panic;\n'
		printf "CREATE ROLE af_migrator LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;\n" "$migrator"
		printf "CREATE ROLE af_api LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;\n" "$api"
		printf "CREATE ROLE af_control LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;\n" "$control"
		printf "CREATE ROLE af_backup LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;\n" "$backup"
		printf "CREATE ROLE af_reader LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5;\n" "$reader"
		# Rights: nobody connects to the maintenance databases but the superuser. af_api and af_control get table rights
		# with the phase 2 migrations; pg_dump needs select on tables and sequences, nothing more. af_reader gets none
		# by default, so that token and key hashes stay out of its sight: read-only sessions and a statement timeout
		# are comfort, the guard is that it holds no table right at all.
		printf '%s\n' \
			"ALTER ROLE af_reader SET default_transaction_read_only = on;" \
			"ALTER ROLE af_reader SET statement_timeout = '30s';" \
			"REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;" \
			"REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;" \
			"CREATE DATABASE agent_factory OWNER af_migrator;" \
			"REVOKE ALL ON DATABASE agent_factory FROM PUBLIC;" \
			"GRANT CONNECT ON DATABASE agent_factory TO af_api, af_control, af_backup, af_reader;" \
			'\connect agent_factory' \
			"CREATE EXTENSION vector;" \
			"REVOKE CREATE ON SCHEMA public FROM PUBLIC;" \
			"GRANT USAGE ON SCHEMA public TO af_api, af_control, af_backup, af_reader;" \
			"ALTER DEFAULT PRIVILEGES FOR ROLE af_migrator IN SCHEMA public GRANT SELECT ON TABLES TO af_backup;" \
			"ALTER DEFAULT PRIVILEGES FOR ROLE af_migrator IN SCHEMA public GRANT SELECT ON SEQUENCES TO af_backup;"
	} | af_psql_bootstrap
}

af_init_roles
