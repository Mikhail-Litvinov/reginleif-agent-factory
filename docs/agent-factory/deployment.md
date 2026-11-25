# Deployment of the Agent Factory database

How the PostgreSQL server of the factory is installed, started and stopped on the owner's Windows machine. The design
is in `database.md`; recovery is in `recovery.md`. All commands are PowerShell, run from the repository root unless
noted. The commands below were run on this machine against the real stack (project `agent-factory`).

## What runs

One container from `pgvector/pgvector:0.8.7-pg16-bookworm` (pinned by digest in `factory/deploy/compose.yml`), PostgreSQL
16.16 with pgvector 0.8.7. Compose project name `agent-factory`, so the container is `agent-factory-postgres-1`, the
data volume `agent-factory_pgdata` and the network `agent-factory_default`. The server listens on `127.0.0.1:55432`
only (`AF_PG_PORT` changes the port). Restart policy `unless-stopped`. Idle memory of the running container: about 35 MiB.

Nothing else on the machine is touched: the stack neither uses nor removes other containers, volumes or networks.

## Install

1. Install the node dependencies once: `cd factory; npm install` (no runtime packages, only the TypeScript checker).
2. Make the secrets directory. It holds one file per account (`af_bootstrap`, `af_migrator`, `af_api`, `af_control`,
   `af_backup`, `af_reader`), each a random 43-character password, and is limited to the current Windows user with
   `icacls`. Existing files are never overwritten, so the command is safe to repeat:

   `node factory/deploy/setup-secrets.ts E:/agent-factory/secrets`

   Back these files up apart from the database backup (see "Not covered"): without them a restored database cannot be
   reached by anyone but the bootstrap role of a scratch server.
3. Start:

   `$env:AF_SECRETS_DIR='E:/agent-factory/secrets'; docker compose -p agent-factory -f factory/deploy/compose.yml up -d`

   The first start creates the roles and the `agent_factory` database (`factory/deploy/postgres/init/10-roles.sh`). The
   server restarts once at the end of init, so for a minute the container reports `starting`. Wait for it:

   `docker inspect --format '{{.State.Health.Status}}' agent-factory-postgres-1`

   It must print `healthy` before the first connection or backup.

## Stop and start

- Stop, keep the data: `$env:AF_SECRETS_DIR='E:/agent-factory/secrets'; docker compose -p agent-factory -f factory/deploy/compose.yml stop`
- Start again: the same line with `start`, or `up -d`.
- Remove the container, keep the data volume: the same line with `down`.
- Never add `-v` to `down` unless the data is to be destroyed: it deletes the volume `agent-factory_pgdata`.

The restart policy brings the server back after a crash of the server process (tested: `kill -QUIT 1` inside the
container, the container restarts and becomes healthy). It does not bring back a container that was stopped by hand,
and `docker kill` counts as a manual stop. A machine reboot and a restart of Docker Desktop were not tested here (the
Docker daemon was not to be restarted); with `unless-stopped` Docker starts the container with its daemon.

## Accounts

The six accounts and their rights are in `database.md` "Accounts and rights". Only the application database is reachable
over the network and only by the five application accounts; `af_bootstrap` (the superuser) works only on the container's
local socket, for init and recovery.

The `pg_hba.conf` host lines for the application accounts use the address `samenet`: a connection is accepted only
from a subnet the server itself is attached to, which is the project's own docker network (`agent-factory_default`; in
general `<project>_default`). A container on another docker network is not admitted. The server listens on the
container's interfaces (`listen_addresses = '*'`) because the published port reaches it through the container interface;
the rule above, not the listener, is the boundary, and the published port itself is bound to `127.0.0.1` on the host.

## No password in any environment

No password is in the environment of any process of the running server, in `docker inspect`, in logs or in a command
line. The container gets file references only (`POSTGRES_PASSWORD_FILE`); init and the tools use passfiles made with
`umask 077` and removed on exit. The healthcheck is a TCP `pg_isready -h 127.0.0.1`, which needs no login: the init
server of the image has no TCP listener, so a TCP answer means the final server is up, which is exactly what must be
known. One thing cannot be avoided: the image's entrypoint hands the password to its temporary init server through the
environment during first-start init; that process ends before the final server starts. `factory/tests/hardening.test.ts`
scans inspect output, logs and the command lines and environments of all processes during a running dump.

## Backup

Reads through `af_backup` (select only) over the published port:

`$env:AF_SECRETS_DIR='E:/agent-factory/secrets'; node factory/deploy/backup/backup.ts --target E:/agent-factory/backups`

It writes `af-<UTC stamp>-<8 hex>.dump`, `.dump.sha256` and `.manifest.json`. The name is the UTC time plus a random
part, so two runs never share a name, also when started at once into one directory; every file is created exclusively
(an existing file is never overwritten or removed), and the manifest is written last, by rename, so only a backup with a
manifest is complete. A failed write or a dying `pg_dump` removes this run's own partial files and exits non-zero. Row
counts and foreign keys in the manifest come from the same snapshot as the dump, so a backup taken while the application
writes is still consistent. The command first waits for a healthy server (bounded, 60 s by default) instead of
failing on a starting one. No password is in any command line or environment: each tool gets a passfile that exists
only while it runs.

## Restore check

Proves a backup restores and equals what was backed up, without touching the real stack:

`node factory/deploy/backup/restore-check.ts --manifest E:/agent-factory/backups/af-<UTC stamp>.manifest.json`

It verifies the checksums, starts a scratch server (own project `af-restore-check-<hex>`, own throw-away secrets, a free
loopback port), restores into it, compares major version, row counts and foreign keys, and removes the scratch server
and its volume whatever happened. It takes about 25 seconds. Exit code 0 means all matched; 1 lists the differences.

On the first real run the database was still empty (phase 2 adds the tables), so the check covered the checksum, the
restore of the roles-independent schema objects and the extension, and zero tables.

## Restore

Restoring goes into a new project and never destroys the old data: `cd factory; npm run restore -- --manifest <file>
--secrets <dir>`. The whole procedure is in `recovery.md`.

## Tests

`cd factory; npm test` runs the integration tests, each file with its own disposable stack named `af-test-<random>`
(a random project name, removed also on failure; every cleanup is registered before its resource is created). A file
shares one started server across its tests where they do not change it; `streams.test.ts` needs no docker and uses an
injected clock, so nothing waits in real time. `npm run typecheck` checks the types. The root `bun test tests/factory-isolation.test.ts`
checks that the factory package does not reach into the product code.

## Not covered

- A schedule: backups run only when someone runs the command. No Task Scheduler entry exists.
- Encryption of backups and of the secrets directory (the secrets are protected by Windows file rights only).
- An off-host copy: backups and secrets are on the same machine and the same disk as the data.
- Retention: old backups are never deleted.
- The Temporal pair (server and its database) of the architecture: not part of phase 1.
- Reboot and Docker restart behaviour: not tested.
