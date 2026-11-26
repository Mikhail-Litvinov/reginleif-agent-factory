#!/bin/bash
# Last step of the first-start initialisation (runs after 10-roles.sh, still against the temporary server).
#
# 1. Removes the service file that deploy/postgres/entrypoint.sh wrote for the image entrypoint's own psql calls, so that
#    the bootstrap password does not stay in tmpfs of the running server. (The wrapper's EXIT trap removes it on every
#    failure path; this is the early removal on the way to a running server.)
# 2. Checks that the data directory's pg_hba.conf holds no trust rule. None is ever asked for (the wrapper sets no
#    POSTGRES_HOST_AUTH_METHOD, so the image appends scram-sha-256), and the step is a guard that fails (init fails, the
#    container does not become healthy) if one is there anyway. Nothing is rewritten.
# 3. Only when both are done, creates the marker .af-init-complete in the data directory: the record that this data
#    directory was initialised completely. It is the very last step. deploy/postgres/entrypoint.sh serves a data directory
#    only with the marker (the image's entrypoint would otherwise skip the initialisation of a half-made one), and the
#    healthcheck looks for it too.
#
# The entrypoint sources this file when it is not executable (a Windows bind mount), so no `exit` here.
af_finish_init() {
	local hba="$PGDATA/pg_hba.conf"
	[ -z "${PGSERVICEFILE:-}" ] || rm -f -- "$PGSERVICEFILE"
	if grep -Eq '^[[:space:]]*(local|host|hostssl|hostnossl|hostgssenc|hostnogssenc)[[:space:]].*[[:space:]]trust([[:space:]]|$)' "$hba"; then
		echo "init: pg_hba.conf of the data directory still holds a trust rule" >&2
		return 1
	fi
	: > "$PGDATA/.af-init-complete" || return 1
}

af_finish_init
