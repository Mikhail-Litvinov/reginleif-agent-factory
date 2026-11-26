# Deployment of the Agent Factory database

How the PostgreSQL server of the factory is installed, started and stopped on the owner's Windows machine. The design
is in `database.md`; recovery is in `recovery.md`. All commands are Windows PowerShell 5.1 (no `&&`; one command per
line, run them one after the other). How to read them:

- Every command runs from the repository root, in one PowerShell window, and can be pasted as it stands once the
  placeholders below are filled in. `node factory/...` and `docker compose ... -f factory/deploy/compose.yml` need the
  root because the paths are relative to it.
- The package scripts run from the root too, as `npm --prefix factory run` followed by the script name, `--` and its
  arguments; `npm --prefix` makes npm work inside `factory/`, so no `cd` is needed. The script then runs with `factory/` as its working
  directory, so a path given to it must be absolute.
- A placeholder in angle brackets is written once, into a PowerShell variable, as a quoted string: replace the whole
  `<...>` with the value and keep the single quotes, which also make a path with spaces safe. Paths are absolute and
  outside the repository. The variables live as long as the window does:

  `$secrets = '<secrets dir>'` (the secrets directory of Install step 2)

  `$backups = '<backups dir>'` (the directory that holds the backups)

  `$project = '<project>'` (the project name of the server to dump: `agent-factory`, or the restored project after a
  switch-over; used by the backup command only)

- An optional argument is a separate command, never an `[optional]` part of one.

Every command in this document was executed as written on a scratch project (its own random project name, its own
secrets directory, a free loopback port in place of 55432), except `restore.ts` against the real stack and the real
switch-over, which were checked against the code only.

## Threat model of these tools

A process of the same Windows user is undefended in version one (`security.md` T8). The tools defend against mistakes,
crashes, kills, stale state, wrong targets and concurrency between our own runs, not against an active adversary that
holds the owner's rights and races our operations: such a process can read the secrets directory, swap a file between
a check and its use, or replace a directory under a running command. Where a code comment names a residual race, it
points to T8.

## What runs

One container from `pgvector/pgvector:0.8.7-pg16-bookworm` (pinned by digest in `factory/deploy/compose.yml`), PostgreSQL
16.16 with pgvector 0.8.7. Compose project name `agent-factory`, so the container is `agent-factory-postgres-1`, the
data volume `agent-factory_pgdata` and the network `agent-factory_default`. The server listens on `127.0.0.1:55432`
only (`AF_PG_PORT` changes the port). Restart policy `unless-stopped`. Idle memory of the running container: about
50 MiB.

Nothing else on the machine is touched: the stack neither uses nor removes other containers, volumes or networks.

## Install

1. Install the node dependencies once, from the repository root: `npm --prefix factory install` (no runtime packages,
   only the TypeScript checker). Node 24 or newer runs the TypeScript files directly.
2. Make the secrets directory. It holds one file per account (`af_bootstrap`, `af_migrator`, `af_api`, `af_control`,
   `af_backup`, `af_reader`), each a random 43-character password. Existing files are never overwritten, so the
   command is safe to repeat:

   `node factory/deploy/setup-secrets.ts $secrets`

   Access is limited to the current Windows user, SYSTEM and Administrators with `icacls`, and the result is read back
   by SID (so a localized system does not matter): the directory and every secret file must hold exactly those three
   and no other entry. A directory that already holds secrets is never restricted silently: when its access is wider,
   the command refuses, names the entry and changes nothing. To verify an existing directory without writing anything:

   `node factory/deploy/setup-secrets.ts --check $secrets`

   It prints `secrets access ok` and exits 0, or lists the offending entries and exits 1 (2 on a usage error).

   Back these files up apart from the database backup (see "Not covered"): without them a restored database cannot be
   reached by anyone but the bootstrap role of a scratch server.
3. Start:

   `$env:AF_SECRETS_DIR = $secrets; docker compose -p agent-factory -f factory/deploy/compose.yml up -d`

   The first start creates the roles and the `agent_factory` database (`factory/deploy/postgres/init/10-roles.sh`). The
   server restarts once at the end of init, so for a minute the container reports `starting`. Wait for it, by running
   this line again until it prints `healthy` (if the container stops instead, see "A start that refuses"):

   `docker inspect --format '{{.State.Health.Status}}' agent-factory-postgres-1`

   It must print `healthy` before the first connection or backup. Running the start command again on a running stack
   changes nothing. The port 55432 on `127.0.0.1` is the default; to use another one set it before the start line and
   keep it set for every later `docker compose` line of this window, otherwise compose recreates the container on
   55432:

   `$env:AF_PG_PORT = '55433'`

## Stop and start

All lines run from the repository root and need `AF_SECRETS_DIR` set (compose refuses to read the file without it);
set it once per window (and `AF_PG_PORT` too when the stack runs on another port, see Install step 3):

`$env:AF_SECRETS_DIR = $secrets`

- Stop, keep the data:

  `docker compose -p agent-factory -f factory/deploy/compose.yml stop`

- Wait until the daemon has recorded the stop (it returns at once when the container is already exited):

  `docker wait agent-factory-postgres-1`

  `compose stop` returns when the stop request is done, about a quarter of a second before the daemon marks the
  container exited; a `start` or `up -d` issued in that window is silently ignored (the daemon still sees a running
  container) and the container then ends up exited. On a scratch project this lost 11 of 12 immediate starts; with
  `docker wait` in between, 0 of 12. The same holds after `docker stop` and `docker kill`: always `docker wait` before
  a start.
- Start again:

  `docker compose -p agent-factory -f factory/deploy/compose.yml start`

  Check the result, it must print `running` (then wait for `healthy` as in Install step 3):

  `docker inspect --format '{{.State.Status}}' agent-factory-postgres-1`

  If it prints `exited`, run the start line again (after a `docker wait`).
- Remove the container, keep the data volume:

  `docker compose -p agent-factory -f factory/deploy/compose.yml down`

- Never add `-v` to `down` unless the data is to be destroyed: it deletes the volume `agent-factory_pgdata`.

The restart policy `unless-stopped` brings the container back after its main process dies (not re-run for this
document; the earlier test sent `kill -QUIT 1` inside the container and it restarted and became healthy). It does not bring back a container that was stopped by hand,
and `docker kill` counts as a manual stop. A machine reboot and a restart of Docker Desktop were not tested here (the
Docker daemon was not to be restarted); with `unless-stopped` Docker starts the container with its daemon.

A restart never turns a half-made first start into a served database: a data directory that holds a database but no
record of a completed initialisation is refused (see "A start that refuses" below), so the restart that
`unless-stopped` performs after an interrupted first start ends in a stopped container, not in a healthy one.

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

No password is in the environment or the command line of any process, at any time: not during the first-start init, not
in the running server, not in `docker inspect`, not in logs. The container gets file references only. The image's
entrypoint would read the bootstrap password into an environment variable to hand it to its temporary init server, so it
is not used as it is. The container starts through a wrapper (`factory/deploy/postgres/entrypoint.sh`, run as
`bash /etc/agent-factory/entrypoint.sh`, since a Windows bind mount has no exec bit):

- `initdb` gets the password as a file, `--pwfile=/run/secrets/af_bootstrap`, set in `POSTGRES_INITDB_ARGS`.
- The image's own `psql` calls on its temporary init server authenticate through a libpq service file. The wrapper
  writes it into one private directory in tmpfs, `/dev/shm/af-init.*` (mode 0600, owned by the postgres user), and
  exports only its path as `PGSERVICEFILE` with `PGSERVICE` (a path is not a secret) and the directory as
  `AF_INIT_DIR`. The file holds the real password, which the shell copies from the secret file with `cat`: no variable
  and no argument of any process holds it. The passfile that `init/10-roles.sh` makes for its own `psql` is made in the
  same directory and nowhere else. During the first start the wrapper stays the parent of the image's entrypoint (and
  forwards signals to it), so its exit trap removes the directory, and with it every file in it, on every way out:
  success, a failing init script, a signal, a crash. Only a SIGKILL of the wrapper skips the trap; the files are in
  tmpfs, which the stop of the container discards.
- No `POSTGRES_HOST_AUTH_METHOD` and no `POSTGRES_PASSWORD` is ever set in the container's configuration, so the image
  appends only its `scram-sha-256` rule to the data directory's `pg_hba.conf` and no trust rule is ever written, at any
  instant, a kill included. The image's check that a password is given is met by a constant inside the wrapper process
  that is not the secret and opens no role. The server reads the mounted `/etc/agent-factory/pg_hba.conf`
  (`-c hba_file=...`), not the one of the data directory.
- `init/99-finish.sh` is the last init script: it removes the service file early, only guards against a trust rule (it
  fails the init when one is found and rewrites nothing), and only then creates the marker `.af-init-complete` (see
  "A start that refuses").

The healthcheck proves a usable database, in three steps that must all hold: a TCP `pg_isready -h 127.0.0.1` (the init
server of the image has no TCP listener, so a TCP answer means the final server is up), the marker `.af-init-complete`
in the data directory, and a real login as `af_backup` with `select 1`. The login reads the password from one fixed
passfile, `/dev/shm/af-healthcheck.pgpass` (tmpfs, mode 0600), which the wrapper rewrites from the secret file at every
start of the container. The check makes no file of its own, because docker kills a check that runs past its timeout and
a per-check file would be left behind. No password is in a command line or an environment.
Checked by tests:
`factory/tests/first-start.test.ts` samples the environment and the command line of every process in the container
continuously through the whole first start, as root and as the postgres user, and looks for the passwords and for a
leftover passfile; `factory/tests/hardening.test.ts` scans inspect output, logs and the command lines and environments
of all processes during a running dump.

## A start that refuses

The image skips its whole initialisation when the data directory already holds a database (`PG_VERSION`). A first start
that was cut off (a stop, a crash, a failing init script) leaves such a directory with part of the roles missing, and a
plain restart would then serve it as if it were complete. So the last step of a successful initialisation
(`init/99-finish.sh`) creates the marker file `.af-init-complete` in the data directory, and the wrapper
(`factory/deploy/postgres/entrypoint.sh`) starts the server only when the marker is there, or when the directory is empty
(a first start).

A data directory with `PG_VERSION` and without the marker is refused: the container stops with a non-zero exit code and
prints `refusing to start` and a pointer to this section on its error output, and it never reports `healthy`. The
refusal changes nothing in the data directory. Read the reason:

`docker logs agent-factory-postgres-1`

Under `unless-stopped` Docker tries again, and each attempt ends the same way, which is the intended result: a refused
volume is never served. Stop it with `docker compose -p agent-factory -f factory/deploy/compose.yml stop`.

An interrupted first start, on a volume that holds nothing worth keeping (the first start of a new install or of a
scratch project): stop the stack, delete the volume with the exact name that `docker volume ls` shows for the project,
and start again from Install step 3. Never do this on a volume with real data: the deletion cannot be undone.

A database made before the marker existed (a legacy database) is refused too, although it is complete. The wrapper does
not mark it by itself, because it cannot tell a complete database from a half-made one without logging in to a server
that is not running. The owner marks it once, after checking it, ideally before the stack is updated, while the previous
version still runs and answers (the check needs a running server; the new wrapper refuses to start an unmarked one).
The check is a script, read-only, run from the repository root:

`node factory/deploy/verify-init.ts`

For another project name, run the same command with `--project` and the name added at the end. It verifies, as `af_backup` in one session, every postcondition of
`init/10-roles.sh` and `init/99-finish.sh`: the six roles and their attributes (only `af_bootstrap` is a superuser),
the read-only and timeout settings of `af_reader`, the connect and schema rights of `PUBLIC` and of the application
roles, the owner of `agent_factory`, the `vector` extension, the default privileges of `af_backup`, a real login of
each application role with the password of its secret file, no leftover service file and no trust rule in the data
directory's `pg_hba.conf`. Each check prints `ok` or `FAIL <name>: <reason>`, and the script exits 0 only when all of
them pass (1 when any fails, 2 on a wrong argument). The list of checks is `factory/deploy/init-postconditions.ts`; a
test (`factory/tests/verify-init.test.ts`) fails when a statement of the init scripts has no check, so the two cannot
drift apart. Passwords are not in the catalogs, so they are proved by the real logins, not read.

If any check fails, do not create the marker: the database is half-made or was changed, and the recovery is a restore
from a known-good backup (`recovery.md`), not a marking.

When all checks pass, create the marker. The variable holds the container name, so the command is the same for another
project name:

`$container = 'agent-factory-postgres-1'`

`docker exec -u postgres $container touch /var/lib/postgresql/data/.af-init-complete`

Then confirm it, which adds the check that the marker exists:

`node factory/deploy/verify-init.ts --with-marker`

Start (or wait for the next automatic attempt) and wait for `healthy` as in Install step 3.

## Backup

Reads through `af_backup` (select only), inside the container. From the repository root:

`node factory/deploy/backup/backup.ts --target $backups`

The server dumped is the project `agent-factory`. After a switch-over to a restored project, name it (see
`recovery.md`):

`node factory/deploy/backup/backup.ts --target $backups --project $project`

The command needs no `AF_SECRETS_DIR`: the password is read inside the container. The target directory is created when
missing.

It writes `af-<UTC stamp>-<8 hex>.dump`, `.dump.sha256` and `.manifest.json`; the UTC stamp has the form `yyyyMMddTHHmmssZ`. The name is the UTC time plus 8 random hex digits, so two runs never
share a name, also when started at once into one directory; every file is created exclusively (an existing file is
never overwritten or removed), and the manifest is linked into place last, so only a backup with a manifest is
complete. A failed write or a dying `pg_dump` removes this run's own partial files and exits non-zero. Row counts and
foreign keys in the manifest come from the same snapshot as the dump, so a backup taken while the application writes
is still consistent. The command first waits for a healthy server (bounded, 60 s) instead of failing on a starting
one. No password is in any command line or environment: each tool gets a passfile that exists only while it runs. On
success it prints the manifest path and the dump size; exit code 1 on failure.

## Restore check

Proves a backup restores and equals what was backed up, without touching the real stack. From the repository root:

`$manifest = Join-Path $backups 'af-<UTC stamp>-<8 hex>.manifest.json'`

`node factory/deploy/backup/restore-check.ts --manifest $manifest`

The manifest file name must be exactly `af-<UTC stamp>-<8 hex>.manifest.json` (a `.partial` file or an older name
without the hex part is refused). The scratch project is named `af-restore-check-<hex>`; the `--prefix` argument followed by a name replaces the
`af-restore-check` part, as a separate run of the same command with that argument added. The command verifies the manifest, the dump and the checksum file by content, starts
a scratch server (own project `af-restore-check-<hex>`, own throw-away secrets in a temporary directory, a free
loopback port), restores into it, compares major version, row counts and foreign keys, and removes the scratch server
and its volume and network whatever happened. Everything it creates carries the label `af.run=<hex>` and removal
selects only by that label, so nothing else on the machine can be removed. It takes about 40 seconds. Exit code 0
means all matched; 1 lists the differences or errors; 2 means a usage error.

On the first real run the database was still empty (phase 2 adds the tables), so the check covered the checksum, the
restore of the roles-independent schema objects and the extension, and zero tables.

## Restore

Restoring goes into a new project `agent-factory-restored-<hex>` and never destroys the old data. From the repository
root, with `$manifest` set as above:

`npm --prefix factory run restore -- --manifest $manifest --secrets $secrets`

It picks a free loopback port itself; to choose one, run the same command with `--port` and a port number added at the end. The
whole procedure, including the manual switch-over, is in `recovery.md`.

## Tests

`npm --prefix factory test` runs the integration tests, each file with its own disposable stack named `af-test-<random>`
(a random project name, removed also on failure; every cleanup is registered before its resource is created). Every
resource of a test run (container, volume, network) carries the label `af.run=<fresh run id>`, and the one function that
removes anything, `removeOwned` in `factory/deploy/lib.ts`, selects by that label only: a project, container or volume
is never removed for being named like a test's or being found next to it. `factory/tests/removal-guard.test.ts` fails
when any other file under `factory/` holds a removal command. `factory/tests/first-start.test.ts` covers the first
start (no password in any process, no trust rule ever written, wrapper started as documented), and
`factory/tests/verify-init.test.ts` covers `verify-init.ts` against a real database with a table of deliberate
breakages. A file
shares one started server across its tests where they do not change it; `streams.test.ts` needs no docker and uses an
injected clock, so nothing waits in real time. `npm --prefix factory run typecheck` checks the types. From the root,
`bun test tests/factory-isolation.test.ts` checks that the factory package does not reach into the product code.

## Not covered

- A schedule: backups run only when someone runs the command. No Task Scheduler entry exists.
- Encryption of backups and of the secrets directory (the secrets are protected by Windows file rights only).
- An off-host copy: backups and secrets are on the same machine and the same disk as the data.
- Retention: old backups are never deleted.
- The Temporal pair (server and its database) of the architecture: not part of phase 1.
- Reboot and Docker restart behaviour: not tested.
