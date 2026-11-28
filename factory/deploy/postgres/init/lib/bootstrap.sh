# Shared by the init scripts (sourced, never run on its own; the entrypoint ignores this subdirectory).
#
# Passwords come from the secret files in /run/secrets (compose secrets). They go to psql through its standard input,
# never through a command line or an environment variable.

af_password() {
	local name="$1" value
	[ -s "/run/secrets/$name" ] || { echo "init: secret $name is missing or empty" >&2; return 1; }
	value=$(<"/run/secrets/$name")
	case "$value" in
		*[!A-Za-z0-9_-]*) echo "init: secret $name may hold only A-Z a-z 0-9 _ -" >&2; return 1 ;;
	esac
	REPLY="$value"
}

# psql as the bootstrap role with its own passfile (mode 0600, removed on return). The entrypoint wrapper
# (../../entrypoint.sh) exports no real password variable, only the path of its libpq service file, which 99-finish.sh
# removes at the end; this passfile is separate so the role statements do not depend on that file (libpq prefers the
# service file's password where both exist; both hold the same one). A passfile path is a path, not a secret.
# The passfile lives in the wrapper's tmpfs directory AF_INIT_DIR, which the wrapper's EXIT trap removes on every way out
# (a signal or a failing step between the write and the removal below included); it is never made anywhere else.
af_psql_bootstrap() {
	local passfile status
	af_password af_bootstrap || return 1
	[ -n "${AF_INIT_DIR:-}" ] && [ -d "$AF_INIT_DIR" ] || { echo "init: AF_INIT_DIR (the wrapper's temporary directory) is not set" >&2; return 1; }
	passfile=$(umask 077 && mktemp "$AF_INIT_DIR/pgpass.XXXXXX") || return 1
	printf '*:*:*:%s:%s\n' "$POSTGRES_USER" "$REPLY" > "$passfile"
	( unset PGPASSWORD; PGPASSFILE="$passfile" exec psql -v ON_ERROR_STOP=1 --quiet --no-psqlrc -w --username "$POSTGRES_USER" --dbname postgres )
	status=$?
	rm -f "$passfile"
	return $status
}
