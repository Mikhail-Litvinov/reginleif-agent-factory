#!/bin/bash
# Last step of the first-start initialisation (runs after 10-roles.sh, still against the temporary server).
#
# 1. Removes the passfile that deploy/postgres/entrypoint.sh wrote for the image entrypoint's own psql calls, so that the
#    bootstrap password does not stay in tmpfs of the running server. (The wrapper's EXIT trap removes it on every failure
#    path; this is the early removal on the way to a running server.)
# 2. Closes the "trust" rule that the image entrypoint appends to the data directory's pg_hba.conf because compose.yml sets
#    POSTGRES_HOST_AUTH_METHOD=trust (that setting only satisfies the entrypoint's check that a password is given; the
#    password itself comes from initdb --pwfile). The server does not read that file, it reads the mounted
#    /etc/agent-factory/pg_hba.conf (hba_file in the command), but a rule that opens everything must not stay on the volume
#    for the day somebody starts the server without that option. The rule becomes scram-sha-256, and the step fails (init
#    fails, the container does not become healthy) when any trust rule is left.
# 3. Only when both are done, creates the marker .af-init-complete in the data directory: the record that this data
#    directory was initialised completely. It is the very last step. deploy/postgres/entrypoint.sh serves a data directory
#    only with the marker (the image's entrypoint would otherwise skip the initialisation of a half-made one), and the
#    healthcheck looks for it too.
#
# The entrypoint sources this file when it is not executable (a Windows bind mount), so no `exit` here.
af_finish_init() {
	local hba="$PGDATA/pg_hba.conf"
	[ -z "${PGPASSFILE:-}" ] || rm -f -- "$PGPASSFILE"
	sed -i -e '/^# warning trust is enabled/d' -e '/^# see https:\/\/www.postgresql.org\/docs\/.*auth-trust/d' -e 's/^\(host[[:space:]]\+all[[:space:]]\+all[[:space:]]\+all[[:space:]]\+\)trust[[:space:]]*$/\1scram-sha-256/' "$hba" || return 1
	if grep -Eq '^[[:space:]]*(local|host|hostssl|hostnossl|hostgssenc|hostnogssenc)[[:space:]].*[[:space:]]trust([[:space:]]|$)' "$hba"; then
		echo "init: pg_hba.conf of the data directory still holds a trust rule" >&2
		return 1
	fi
	: > "$PGDATA/.af-init-complete" || return 1
}

af_finish_init
