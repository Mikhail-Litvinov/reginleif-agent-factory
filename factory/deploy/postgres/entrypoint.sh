#!/bin/bash
# Entrypoint of the Agent Factory database container. It does three things around the image's own entrypoint.
#
# 1. A data directory is served only after a RECORDED complete initialisation. The last step of the init scripts
#    (init/99-finish.sh) creates the marker file .af-init-complete in the data directory. The image's entrypoint skips the
#    initialisation whenever PG_VERSION exists, so a first start that was interrupted halfway (the container killed, the
#    host rebooted, a failing init script) would, on the restart that `restart: unless-stopped` performs, serve a database
#    without its roles and report healthy. Here a data directory that holds PG_VERSION but no marker is refused: the
#    script exits non-zero with a message and the server is never started, so the container never becomes healthy.
#    The refusal changes nothing in the data directory. A data directory made before the marker existed is refused too,
#    until its owner creates the marker once (see docs/agent-factory/deployment.md "A start that refuses"); it is never
#    repaired or marked automatically.
#
# 2. The image's entrypoint needs a superuser password on an empty data directory (it refuses without POSTGRES_PASSWORD
#    or POSTGRES_HOST_AUTH_METHOD=trust, and it exports the password to every child), and its own psql calls on the
#    temporary init server must authenticate, because the stack's pg_hba.conf asks for scram-sha-256 on the local socket
#    too. A trust rule is NEVER asked for: the image appends `host all all all $POSTGRES_HOST_AUTH_METHOD` to the data
#    directory's pg_hba.conf, scram-sha-256 when that variable is unset, so a kill at any instant (this script's own
#    SIGKILL included) leaves nothing to close. Instead:
#      - the password reaches initdb through its --pwfile option (POSTGRES_INITDB_ARGS in compose.yml names the secret
#        file; a later --pwfile wins over the one the image passes first);
#      - the image's requirement of a password variable is met by a constant that is not the secret and is accepted by
#        no role (POSTGRES_PASSWORD is set here, in this process only, never in the container's configuration);
#      - the image's psql calls authenticate through a libpq service file (PGSERVICEFILE and PGSERVICE) that this script
#        writes into tmpfs; libpq prefers a password from a service file to the PGPASSWORD the image exports. The file
#        holds the real password; the shell copies it from the secret file with `cat` and never reads it into a variable,
#        so no variable and no argument of any process holds it.
#
# The service file and every other temporary file of the initialisation live in one directory in tmpfs (AF_INIT_DIR, which
# init/10-roles.sh uses too). While the database is initialised this script stays the parent of the image's entrypoint
# instead of replacing itself with it, so that its EXIT trap runs on EVERY way out: success, a failing init script, a
# signal, a crash of the image's entrypoint. The trap removes the directory (the service file with it). Only a kill of this
# script itself (SIGKILL) skips the trap; then the file is in tmpfs, which the container's stop discards, and no trust
# rule exists in the volume. After the initialisation the server is that same child process (the image's entrypoint ends
# by exec of postgres), and this script stays as PID 1 forwarding signals to it. On an existing, completed data directory
# this script replaces itself with the image's entrypoint (exec), as before.
#
# 3. The healthcheck (compose.yml) logs in as af_backup. Its password comes from ONE fixed passfile in tmpfs,
#    /dev/shm/af-healthcheck.pgpass (mode 0600), that this script rewrites at every start of the container from the
#    secret file (a temporary name, then an atomic rename). The check itself makes no file: docker kills a check that runs
#    past its timeout with SIGKILL, and a per-check file would be left behind each time. A same-user process that reads or
#    swaps that file is the accepted residual risk of the tools (security.md T8).
#
# Started as `bash /etc/agent-factory/entrypoint.sh postgres ...` (a Windows bind mount carries no executable bit).
set -Eeo pipefail

data="${PGDATA:-/var/lib/postgresql/data}"
marker="$data/.af-init-complete"

if [ -e "$data/PG_VERSION" ] && [ ! -e "$marker" ]; then
	echo "entrypoint: refusing to start: $data holds a database (PG_VERSION) but no record of a completed initialisation ($marker)." >&2
	echo "entrypoint: an interrupted first start, or a database made before the marker existed; it is not served. See docs/agent-factory/deployment.md \"A start that refuses\"." >&2
	exit 1
fi

# The healthcheck's passfile (see 3 above). A missing or empty secret stops the container: the check could never pass.
health_secret=/run/secrets/af_backup
health_passfile=/dev/shm/af-healthcheck.pgpass
[ -s "$health_secret" ] || { echo "entrypoint: secret af_backup is missing or empty" >&2; exit 1; }
rm -f -- "$health_passfile.new"
( umask 077; { printf '*:*:*:af_backup:'; cat "$health_secret"; printf '\n'; } > "$health_passfile.new" )
mv -f -- "$health_passfile.new" "$health_passfile"

if [ -e "$data/PG_VERSION" ]; then
	exec docker-entrypoint.sh "$@"
fi

# No database yet: the image's entrypoint initialises one (the init scripts end by creating the marker).
init_dir=$(umask 077 && mktemp -d /dev/shm/af-init.XXXXXX)
# The image's check that a password is given; see 2 above. Not the secret, so it opens nothing.
export POSTGRES_PASSWORD=placeholder-not-secret
if [ "$(id -u)" = "0" ]; then
	chown postgres "$init_dir"
	secret=/run/secrets/af_bootstrap
	[ -s "$secret" ] || { rm -rf -- "$init_dir"; echo "entrypoint: secret af_bootstrap is missing or empty" >&2; exit 1; }
	# The service file is made by this root script with mode 0600 and then handed to postgres (libpq ignores a file that
	# group or others can access, and a file of another owner is unreadable to the server user).
	service_file=$(umask 077 && mktemp "$init_dir/service.XXXXXX")
	{ printf '[af]\npassword='; cat "$secret"; printf '\n'; } > "$service_file"
	chown postgres "$service_file"
	export PGSERVICEFILE="$service_file" PGSERVICE=af
fi
export AF_INIT_DIR="$init_dir"

# Runs on every way out; it must not change the exit status, so nothing in it can fail the script.
af_cleanup() {
	rm -rf -- "$init_dir" || true
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
