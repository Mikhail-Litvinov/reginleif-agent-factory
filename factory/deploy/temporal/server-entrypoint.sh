#!/bin/sh
# Wrapper of the Temporal server container (phase 3, package 48). It exists so that no password is ever in the
# environment or in an argument of the container (docs/agent-factory/deployment.md, "No password in any environment"):
#  1. it reads the secret af_temporal with the shell builtin `read` (no process holds the password in its arguments),
#  2. copies the template config.yaml.tmpl line by line into tmpfs (mode 0600) and puts the password in place of the one
#     word __AF_TEMPORAL_PASSWORD__ (parameter expansion and builtin printf only),
#  3. hands the file to the image's user `temporal` and starts the server as that user.
# The container starts as root only because a secret file of mode 0600 that belongs to the host user cannot be read by
# the image's uid 1000 on Linux; root reads it here and the server itself never runs as root.
set -eu

secret=/run/secrets/af_temporal
template=/etc/temporal/config.yaml.tmpl
dir=/run/af-temporal
config=$dir/config.yaml
marker=__AF_TEMPORAL_PASSWORD__

umask 077

# `read` returns non-zero at the end of a file without a final newline but still sets the variable.
password=
IFS= read -r password < "$secret" || [ -n "$password" ]
# The generator (deploy/setup-secrets.ts) writes base64url text; anything else would also break the quoted YAML value.
case "$password" in
	"" | *[!A-Za-z0-9_-]*) echo "af-temporal: the secret af_temporal is empty or holds a character outside A-Z a-z 0-9 _ -" >&2; exit 1 ;;
esac

# A file that exists only complete: written beside the final name, then renamed.
replaced=0
while IFS= read -r line || [ -n "$line" ]; do
	case "$line" in
		*"$marker"*)
			line="${line%%"$marker"*}${password}${line#*"$marker"}"
			replaced=$((replaced + 1))
			;;
	esac
	printf '%s\n' "$line"
done < "$template" > "$config.new"
password=
if [ "$replaced" -ne 2 ]; then
	# Two datastores (persistence and visibility) each carry the marker once; any other count is a broken template.
	rm -f "$config.new"
	echo "af-temporal: the template $template holds the password marker $replaced times, expected 2" >&2
	exit 1
fi
# The tmpfs directory is mode 0700 and root's: the server (user temporal) needs the directory as well as the file.
chown temporal:temporal "$config.new" "$(dirname "$config")"
mv "$config.new" "$config"

# busybox `su` keeps the environment and needs no password for root; `exec` inside replaces the shell by the server, so the
# server is the only process left and receives the stop signal of docker directly.
exec su -s /bin/sh temporal -c 'exec temporal-server --config-file /run/af-temporal/config.yaml start'
