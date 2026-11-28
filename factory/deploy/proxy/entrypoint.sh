#!/usr/bin/env bash
# Wrapper of the proxy container (phase 3, package 49). The container starts as root only because the secret files (mode
# 0600, owned by the host user) cannot be read by the image's user `envoy` on Linux; this script
#  1. copies the CA certificate, the server certificate and the server key from /run/secrets into tmpfs (mode 0700, owned by
#     envoy), so Envoy reads them as itself and the key never leaves memory,
#  2. renders envoy.yaml.tmpl into tmpfs, putting the API port in place of the one word __AF_API_PORT__,
#  3. hands over to the image's own entrypoint, which drops to `envoy` and starts it (it is the only process left).
# No key is in the environment or in an argument (docs/agent-factory/deployment.md, "No password in any environment").
set -eu

dir=/run/af-proxy
template=/etc/agent-factory/envoy.yaml.tmpl
marker=__AF_API_PORT__

umask 077

case "${AF_API_PORT:-}" in
	"" | *[!0-9]* | 0*) echo "af-proxy: AF_API_PORT must be a port number without leading zeros, got '${AF_API_PORT:-}'" >&2; exit 1 ;;
esac
if [ "$AF_API_PORT" -gt 65535 ]; then
	echo "af-proxy: AF_API_PORT $AF_API_PORT is above 65535" >&2
	exit 1
fi

for name in ca.crt server.crt server.key; do
	secret=/run/secrets/af_proxy_$(printf '%s' "$name" | tr . _)
	if [ ! -s "$secret" ]; then
		echo "af-proxy: $secret is missing or empty; make it with: npm run proxy-certs -- ca|server (docs/agent-factory/deployment.md, \"TLS proxy\")" >&2
		exit 1
	fi
	cat "$secret" > "$dir/$name"
done

replaced=0
while IFS= read -r line || [ -n "$line" ]; do
	case "$line" in
		*"$marker"*)
			line="${line%%"$marker"*}${AF_API_PORT}${line#*"$marker"}"
			replaced=$((replaced + 1))
			;;
	esac
	printf '%s\n' "$line"
done < "$template" > "$dir/envoy.yaml"
if [ "$replaced" -ne 1 ]; then
	echo "af-proxy: the template $template holds the API port marker $replaced times, expected 1" >&2
	exit 1
fi

chown envoy:envoy "$dir" "$dir"/ca.crt "$dir"/server.crt "$dir"/server.key "$dir"/envoy.yaml
exec /docker-entrypoint.sh envoy -c "$dir/envoy.yaml"
