#!/bin/bash
# Entrypoint of the Agent Factory database container. It does two things around the image's own entrypoint.
#
# 1. A data directory is served only after a RECORDED complete initialisation. The last step of the init scripts
#    (init/99-finish.sh) creates the marker file .af-init-complete in the data directory. The image's entrypoint skips the
#    initialisation whenever PG_VERSION exists, so a first start that was interrupted halfway (the container killed, the
#    host rebooted, a failing init script) would, on the restart that `restart: unless-stopped` performs, serve a database
#    without its roles and report healthy. Here a data directory that holds PG_VERSION but no marker is refused: the
#    script exits non-zero with a message and the server is never started, so the container never becomes healthy.
#    The refusal also closes the trust rule that an interrupted initialisation may have left in the volume's pg_hba.conf.
#    A data directory made before the marker existed is refused too, until its owner creates the marker once (see
#    docs/agent-factory/deployment.md "A start that refuses"); it is never repaired or marked automatically.
#
# 2. The image's entrypoint needs the superuser password on an empty data directory (it refuses without POSTGRES_PASSWORD,
#    which it also exports to every child) and its own psql calls on the temporary init server must authenticate, because
#    the stack's pg_hba.conf asks for scram-sha-256 on the local socket too. Here the password reaches initdb through its
#    --pwfile option (POSTGRES_INITDB_ARGS in compose.yml names the secret file), the entrypoint's requirement is met by
#    POSTGRES_HOST_AUTH_METHOD (see compose.yml), and its psql calls authenticate through a libpq passfile that this script
#    writes into tmpfs. A passfile is read by libpq from a path (PGPASSFILE), so only a path is in the environment. No
#    variable and no argument of any process holds the password: it is copied by `cat` from the secret file into the
#    passfile, and the shell never reads it into a variable.
#
# The passfile and every other temporary file of the initialisation live in one directory in tmpfs (AF_INIT_DIR, which
# init/10-roles.sh uses too). While the database is initialised this script stays the parent of the image's entrypoint
# instead of replacing itself with it, so that its EXIT trap runs on EVERY way out: success, a failing init script, a
# signal, a crash of the image's entrypoint. The trap removes the directory (the passfile with it), and closes the trust
# rule when the initialisation did not complete. Only a kill of this script itself (SIGKILL) skips the trap; then the
# passfile is in tmpfs, which the container's stop discards, and the trust rule is closed by the refusal on the next start.
# After the initialisation the server is that same child process (the image's entrypoint ends by exec of postgres), and this
# script stays as PID 1 forwarding signals to it. On an existing, completed data directory this script replaces itself with
# the image's entrypoint (exec), as before.
#
# Started as `bash /etc/agent-factory/entrypoint.sh postgres ...` (a Windows bind mount carries no executable bit).
set -Eeo pipefail

data="${PGDATA:-/var/lib/postgresql/data}"
marker="$data/.af-init-complete"
hba="$data/pg_hba.conf"

# The same rule as init/99-finish.sh uses to find, and to close, a trust rule of the data directory's pg_hba.conf. It is
# repeated here (a sourced init script and this script share no code), so a change to one is a change to both.
trust_rule='^[[:space:]]*(local|host|hostssl|hostnossl|hostgssenc|hostnogssenc)[[:space:]].*[[:space:]]trust([[:space:]]|$)'

# Rewrites the image's trust rule to scram-sha-256 and drops its two warning comments. A file without a trust rule is not
# rewritten at all (an existing database's file stays byte for byte as it is).
af_close_trust() {
	[ -f "$hba" ] || return 0
	grep -Eq "$trust_rule" "$hba" || return 0
	sed -i -e '/^# warning trust is enabled/d' -e '/^# see https:\/\/www.postgresql.org\/docs\/.*auth-trust/d' -e 's/^\(host[[:space:]]\+all[[:space:]]\+all[[:space:]]\+all[[:space:]]\+\)trust[[:space:]]*$/\1scram-sha-256/' "$hba"
}

if [ -e "$data/PG_VERSION" ]; then
	if [ ! -e "$marker" ]; then
		af_close_trust || true
		echo "entrypoint: refusing to start: $data holds a database (PG_VERSION) but no record of a completed initialisation ($marker)." >&2
		echo "entrypoint: an interrupted first start, or a database made before the marker existed; it is not served. See docs/agent-factory/deployment.md \"A start that refuses\"." >&2
		exit 1
	fi
	exec docker-entrypoint.sh "$@"
fi

# No database yet: the image's entrypoint initialises one (the init scripts end by creating the marker).
init_dir=$(umask 077 && mktemp -d /dev/shm/af-init.XXXXXX)
if [ "$(id -u)" = "0" ]; then
	chown postgres "$init_dir"
	secret=/run/secrets/af_bootstrap
	[ -s "$secret" ] || { rm -rf -- "$init_dir"; echo "entrypoint: secret af_bootstrap is missing or empty" >&2; exit 1; }
	# The passfile is made by this root script with mode 0600 and then handed to postgres (libpq ignores a file that
	# group or others can access, and a file of another owner is unreadable to the server user).
	passfile=$(umask 077 && mktemp "$init_dir/pgpass.XXXXXX")
	{ printf '*:*:*:%s:' "${POSTGRES_USER:-postgres}"; cat "$secret"; printf '\n'; } > "$passfile"
	chown postgres "$passfile"
	export PGPASSFILE="$passfile"
fi
export AF_INIT_DIR="$init_dir"

# Runs on every way out; it must not change the exit status, so nothing in it can fail the script.
af_cleanup() {
	rm -rf -- "$init_dir" || true
	[ -e "$marker" ] || af_close_trust || true
}
trap af_cleanup EXIT

child=
got_signal=
af_forward() {
	if [ -n "$child" ]; then kill -s "$1" "$child" 2>/dev/null || true; else got_signal=$1; fi
}
for sig in TERM INT QUIT HUP; do
	# shellcheck disable=SC2064
	trap "af_forward $sig" "$sig"
done

docker-entrypoint.sh "$@" &
child=$!
[ -z "$got_signal" ] || af_forward "$got_signal"

# `wait` returns early when a trapped signal arrives; the child's status is final only once it is gone.
status=0
while :; do
	wait "$child" && status=0 || status=$?
	kill -0 "$child" 2>/dev/null || break
done
exit "$status"
