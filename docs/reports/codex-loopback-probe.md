# Codex loopback probe

## Environment

- Node.js: `v24.16.0`
- Codex CLI: `codex-cli 0.171.0-alpha.13.2`

Commands and outputs:

```text
> node --version
v24.16.0

> codex --version
codex-cli 0.171.0-alpha.13.2
```

## Probe

The probe started a small HTTP server on `127.0.0.1` with an OS-assigned port. While that server was running, the script launched a separate Node.js process which used `fetch` to request it. The script then opened and immediately closed a TCP connection to `127.0.0.1:55432`. It sent no PostgreSQL protocol data and performed no login.

Command:

```text
> node .tmp/loopback-probe.mjs
```

Exact output:

```text
HTTP server listening at http://127.0.0.1:54818/
HTTP status=200 body=loopback-ok
HTTP child exit=0
TCP 127.0.0.1:55432 CONNECTED
```

## Conclusion

- Same-sandbox loopback HTTP works: a child process reached the HTTP server started by the probe process and received status 200.
- TCP reachability to the existing stack service on loopback port 55432 works: the connection was accepted. This confirms reachability to the server outside the probe process; this check was TCP-only, not an HTTP request.
