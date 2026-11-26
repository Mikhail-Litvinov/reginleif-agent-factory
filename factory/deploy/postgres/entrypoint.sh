#!/bin/bash
# Entrypoint of the Agent Factory database container: gives the image's own entrypoint the bootstrap password without
# putting it into any process environment or command line.
#
# Why this exists. On an empty data directory the image's entrypoint needs the superuser password to start (it refuses
# without POSTGRES_PASSWORD, which it also exports to every child) and its own psql calls on the temporary init server must
# authenticate, because the stack's pg_hba.conf asks for scram-sha-256 on the local socket too. Here the password reaches
# initdb through its --pwfile option (POSTGRES_INITDB_ARGS in compose.yml names the secret file), the entrypoint's
# requirement is met by POSTGRES_HOST_AUTH_METHOD (see compose.yml), and its psql calls authenticate through a libpq
# passfile that this script writes into tmpfs. A passfile is read by libpq from a path (PGPASSFILE), so only a path is in
# the environment. No variable and no argument of any process holds the password: it is copied by `cat` from the secret
# file into the passfile, and the shell never reads it into a variable.
#
# The passfile exists only while the database is initialised: init/99-finish.sh removes it. On an existing data
# directory the image's entrypoint does no initialisation, so none is written.
#
# Started as `bash /etc/agent-factory/entrypoint.sh postgres ...` (a Windows bind mount carries no executable bit).
set -Eeo pipefail

if [ "$(id -u)" = "0" ] && [ ! -s "${PGDATA:-/var/lib/postgresql/data}/PG_VERSION" ]; then
	secret=/run/secrets/af_bootstrap
	[ -s "$secret" ] || { echo "entrypoint: secret af_bootstrap is missing or empty" >&2; exit 1; }
	# The passfile is made by this root script with mode 0600 and then handed to postgres (libpq ignores a file that
	# group or others can access, and a file of another owner is unreadable to the server user).
	passfile=$(umask 077 && mktemp /dev/shm/pgpass.XXXXXX)
	{ printf '*:*:*:%s:' "${POSTGRES_USER:-postgres}"; cat "$secret"; printf '\n'; } > "$passfile"
	chown postgres "$passfile"
	export PGPASSFILE="$passfile"
fi

exec docker-entrypoint.sh "$@"
