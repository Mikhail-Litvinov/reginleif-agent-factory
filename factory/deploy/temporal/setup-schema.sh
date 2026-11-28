#!/bin/sh
# One-shot schema step of the Temporal stack (phase 3, package 48): creates the schema of both Temporal databases on the
# first start and brings it to the version of the installed admin-tools image on every later start. Forward only:
# `update-schema` applies the versioned files above the stored version and nothing else, and `--overwrite` (which drops
# the tables) is never used. The server waits for this container to finish (compose.yml, depends_on).
#
# No password in the container's environment or in any argument (docs/agent-factory/deployment.md, "No password in any
# environment"): the secret af_temporal is read with the shell builtin `read`. temporal-sql-tool takes its password only from
# the flag --password or the variable SQL_PASSWORD (it does not read a libpq passfile: it always sends the password it was
# given, empty if none, so PGPASSFILE is ignored; measured in the smoke run of package 48). The variable is therefore set on
# the one command that needs it (`SQL_PASSWORD=... temporal-sql-tool`), so it is in that process's environment for the few
# seconds it runs and nowhere else: not in `docker inspect`, not in the shell's environment, not in any argv.
# The container starts as root only because a secret file of mode 0600 that belongs to the host user is not readable by
# uid 1000 on Linux; the tool runs as the image's user `temporal`, with the password handed over in a tmpfs file of mode 0600.
set -eu

secret=/run/secrets/af_temporal
dir=/run/af-temporal-setup
handover=$dir/password
schema_root=/etc/temporal/schema/postgresql/v12

if [ "${1:-}" != "run" ]; then
	umask 077
	password=
	IFS= read -r password < "$secret" || [ -n "$password" ]
	case "$password" in
		"" | *[!A-Za-z0-9_-]*) echo "af-temporal-setup: the secret af_temporal is empty or holds a character outside A-Z a-z 0-9 _ -" >&2; exit 1 ;;
	esac
	printf '%s\n' "$password" > "$handover"
	password=
	# The tmpfs directory is mode 0700 and root's: the tool's user needs the directory as well as the file.
	chown temporal:temporal "$dir" "$handover"
	exec su -s /bin/sh temporal -c 'exec sh /etc/temporal/setup-schema.sh run'
fi

# Phase 2, as `temporal`. Each database: create the versioning tables if they are missing (an existing schema is left as it
# is), then apply every versioned file above the stored version.
password=
IFS= read -r password < "$handover"
rm -f "$handover"

tool() {
	database=$1
	shift
	SQL_PASSWORD=$password temporal-sql-tool --plugin postgres12 --endpoint postgres --port 5432 --user af_temporal --database "$database" "$@"
}

for pair in "af_temporal temporal" "af_temporal_visibility visibility"; do
	# shellcheck disable=SC2086
	set -- $pair
	database=$1
	kind=$2
	tool "$database" setup-schema --version 0.0
	tool "$database" update-schema --schema-dir "$schema_root/$kind/versioned"
done
echo "af-temporal-setup: both Temporal schemas are at the version of this image"
