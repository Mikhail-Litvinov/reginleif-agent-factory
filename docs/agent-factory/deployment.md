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

  `$old = '<old deploy copy dir>'` (a directory that does not exist yet, outside the repository: "Upgrade of a running
  stack" copies the deploy files of the running revision into it)

  `$proveVolume = { param($p) $n = $p + '_pgdata'; $all = docker volume ls -q --filter "name=$n"; if ($LASTEXITCODE -ne 0) { throw "refusing: docker could not list volumes, $n is unchecked" }; if (@($all) -contains $n) { $j = docker volume inspect --format '{{json .Labels}}' $n; if ($LASTEXITCODE -ne 0) { throw "refusing: docker could not inspect volume $n" }; $l = $j | ConvertFrom-Json; if ($null -eq $l -or $l.'com.docker.compose.project' -ne $p -or $l.'com.docker.compose.volume' -ne 'pgdata') { throw "refusing: volume $n is not made by compose project $p" } }; $global:LASTEXITCODE = 0 }`

  The proof that a data volume is the stack's own (the same line is in `recovery.md`). A volume is absent only when
  Docker answered the listing successfully and the name is not in it (the command after it makes it); any other
  failure of Docker (a daemon that does not answer, a failed inspect) stops the line with `refusing`, never counts as
  absent. A volume of that name that compose of that project did not make (another project's, one
  made by hand, one without compose labels) stops the line with `refusing`, before anything mounts, copies or removes it:
  `up -d` would adopt such a volume as the database, and a removal would delete someone else's data. Every command below
  that brings the stack up, mounts the data volume or removes it starts with `& $proveVolume 'agent-factory'` (the
  project of that command) on the same line, followed by `;` and the command: a line pasted on its own stops only
  itself, so a proof on an earlier line would not stop the command after it.

  `$protectedDir = { param($d) $null = node factory/deploy/setup-secrets.ts --check-access $d; if ($LASTEXITCODE -ne 0) { throw "refusing: $d is not a protected directory" }; $global:LASTEXITCODE = 0 }`

  The proof that a directory that will hold a copy of the database (a backups directory, the volume copy of
  `recovery.md`) is protected like the secrets directory (the same line is in `recovery.md`). It runs
  `setup-secrets.ts --check-access`, which judges only the access of the directory, with the same rule as the secrets
  check and without asking for secret files, which a directory of copies does not have. It stops with `refusing`
  (after the findings the check printed) when the directory does not exist, is not a directory, or is open to anyone but
  the current user, SYSTEM and Administrators.

- A command line that is wrong (an unknown or repeated option, a missing value or directory, options that exclude each
  other) is refused before the command does anything: it prints the reason and a `usage:` line and exits 2. Exit 1 is
  always a finding or a failure of the work itself.

- An optional argument is a separate command, never an `[optional]` part of one.

Every command in this document was executed as written on a scratch project (its own random project name, its own
secrets directory, a free loopback port in place of 55432), except `restore.ts` against the real stack and the real
switch-over, which were checked against the code only. The upgrade, its rollback and the way out of a restart loop are
executed by `factory/tests/upgrade-rehearsal.test.ts` on a stack started from the revision before the marker (`a8c628a`),
the same commands taken from this text; only `git pull --ff-only` is replaced there by a copy of the current
`factory/deploy` files (the rehearsal has no remote), and the project name by the scratch one.

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

   An existing file that is empty or does not hold a valid password (only `A-Z a-z 0-9 _ -`, as the command writes
   them) is never reported as kept and never overwritten: the command, also with `--check`, refuses, names the file and
   exits 1. The safe recovery is to remove that one file and run the command again, which makes a new password for that
   account only. If the account already exists in a database, its stored password must then be changed to match; on a
   fresh install nothing else is needed.

   Access is limited to the current Windows user, SYSTEM and Administrators with `icacls`, and the result is read back
   by SID (so a localized system does not matter): the directory and every secret file must hold exactly those three
   and no other entry. A directory that already holds secrets is never restricted silently: when its access is wider,
   the command refuses, names the entry and changes nothing. To verify an existing directory without writing anything:

   `node factory/deploy/setup-secrets.ts --check $secrets`

   It prints `secrets ready` and exits 0 only when the directory holds all six valid secret files, their access is
   exactly those three holders, and the place cannot be committed; otherwise it lists the problems and exits 1 (2 on a
   usage error).

   Back these files up apart from the database backup (see "Not covered"): without them a restored database cannot be
   reached by anyone but the bootstrap role of a scratch server.
3. Start:

   `$env:AF_SECRETS_DIR = $secrets; & $proveVolume 'agent-factory'; docker compose -p agent-factory -f factory/deploy/compose.yml up -d`

   The first start creates the roles and the `agent_factory` database (`factory/deploy/postgres/init/10-roles.sh`). The
   server restarts once at the end of init, so for a minute the container reports `starting`. Wait for it, by running
   this line again until it prints `healthy` (if the container stops instead, see "A start that refuses"):

   `docker inspect --format '{{.State.Health.Status}}' agent-factory-postgres-1`

   It must print `healthy` before the first connection or backup. Running the start command again on a running stack
   changes nothing only while `factory/deploy/compose.yml` is unchanged since that stack was made: after an update of the
   repository compose recreates the container from the new file, and a database made by an older revision is refused by
   the new start wrapper (a restart loop). On a stack that already holds data, never run this line after an update: follow
   "Upgrade of a running stack". The port 55432 on `127.0.0.1` is the default; to use another one set it before the start line and
   keep it set for every later `docker compose` line of this window, otherwise compose recreates the container on
   55432:

   `$env:AF_PG_PORT = '55433'`

## Migrations

The tables come from the numbered files `factory/db/migrations/0001_core.sql` to `0010_control_registry_grants.sql`
(`modules.md` lists what each adds). They are applied by one command, after the stack is healthy. It connects as
`af_migrator` with the password in the secrets directory and uses the port `AF_PG_PORT` (default 55432), so the same
two variables as for compose must be set:

`$env:AF_SECRETS_DIR = $secrets; node factory/db/migrate.ts`

It takes no flags (a flag is a usage error, exit 2). It prints `applied <name>` for each file it applies and nothing
for a file already applied, so running it again on an up-to-date database changes nothing. Any other failure exits 1.
Under an advisory lock it creates `public.af_migrations` (number, name, sha256, applied_at) and checks the files
against it before applying anything: the numbers must have no gap, and an applied file that was edited, is missing or
was renamed stops the command. Each file runs in its own transaction, so a failed file leaves the database as it was
after the previous one. Migrations go forward only; there are no down files, so a mistake is corrected by a new file.
The `pgvector` extension is not created by a migration: `af_bootstrap` creates it at init, and migration 0006 creates
`pg_trgm`.

## Starting the API

The API is one process, `factory/api/main.ts`. It needs the stack healthy and the migrations applied. From `factory/`:

`$env:AF_SECRETS_DIR = $secrets; npm run start`

The same from the repository root: `$env:AF_SECRETS_DIR = $secrets; node factory/api/main.ts`. It connects as `af_api`
with the password from the file `af_api` in `AF_SECRETS_DIR` (never from an environment variable), checks the
database, and prints `af-api ready` with the address when it listens. A wrong password or a missing database ends it
with exit 1; a bad setting is exit 2.

| Setting | Default | Meaning |
|---|---|---|
| `AF_SECRETS_DIR` | none, required | directory of the password files |
| `AF_PG_PORT` | 55432 | PostgreSQL port, as for compose |
| `AF_PG_DATABASE` | `agent_factory` | database name |
| `AF_API_HOST` | `127.0.0.1` | only `127.0.0.1` or `localhost` is accepted |
| `AF_API_PORT` | 8787 | listening port (chosen next to PostgreSQL 55432 and the embedder 8088); 0 takes a free one |
| `AF_EMBEDDER_URL` | unset | embedder address, for example `http://127.0.0.1:8088`; unset means search stays degraded and no re-embedding loop runs |
| `AF_EMBEDDER_TARGET_VERSION` | the setting `registry.embeddingModel` | model version the loop embeds toward |
| `AF_REEMBED_BATCH` | 16 | records per embedder request |
| `AF_REEMBED_INTERVAL_MS` | 60000 | pause between passes |
| `AF_API_STOP_TIMEOUT_MS` | 10000 | longest time a stop may take; after it the process ends with exit 1 |

Cleartext is served on loopback only. Any other address in `AF_API_HOST` is refused with exit 2, because TLS is not built
yet (`security.md` T25, the row "Switch on a non-loopback bind of the API"; `api.md` "Authentication"; `client.md`
"Network").

Stop: Ctrl+C (SIGINT) or SIGTERM. The server stops taking requests, finishes the running ones, stops the re-embedding
loop and closes the database pool, then exits 0. Windows cannot deliver SIGTERM to a process, so a supervisor that
starts it with an IPC channel sends the message `af-api-stop` instead, with the same effect.

## Embedder container

The Decision Registry searches by meaning with a local embedding model, `BAAI/bge-m3` in its ONNX form, on the CPU. It
runs from its own compose file, `factory/deploy/embedder/compose.yml`, separate from the database stack. The container
has no route to the outside.

1. Stage the model files once, outside the repository: the `onnx` directory of `BAAI/bge-m3` at revision
   `5617a9f61b028005a4858fdac845db406aefb181`. Its pinned files are checked by SHA-256 before the HTTP listener starts,
   and the service refuses to start on any difference:

   | File | SHA-256 |
   |---|---|
   | `model.onnx` | `f84251230831afb359ab26d9fd37d5936d4d9bb5d1d5410e66442f630f24435b` |
   | `model.onnx_data` (the 2.2 GB weights) | `1eebfb28493f67bba03ce0ef64bfdc7fc5a3bd9d7493f818bb1d78cd798416b4` |
   | `tokenizer.json` | `6710678b12670bc442b99edc952c4d996ae309a7020c1fa0096dd245c2faf790` |
   | the external constant `Constant_7_attr__value` | `cdf16f72c5d07b36484056e601ed9687f78477e5d85cee85a34f2406b7fb5906` |

   The directory must be readable by UID 65532, the user the service runs as. The image never loads PyTorch weights.
2. Build and start. `AF_EMBEDDER_MODEL_DIR` is required (compose refuses without it) and is mounted read-only at
   `/model`:

   `$env:AF_EMBEDDER_MODEL_DIR = '<model dir>'; docker compose -p af-embedder -f factory/deploy/embedder/compose.yml up -d --build`

   The image `af-embedder:local` is built from `factory/deploy/embedder/Dockerfile` (Python with `onnxruntime`,
   `tokenizers` and `numpy`, versions pinned there). The server hashes the weights before it listens, so the first
   request after a start can take several seconds to half a minute.
3. Check it. `POST /embed` with `{"texts":["text"]}` returns the model name, the revision, the SHA-256 of the weights
   and one normalized vector of 1024 numbers per text:

   `Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8088/embed' -ContentType 'application/json' -Body '{"texts":["test"]}'`

Network: the model container (`embedder`) sits only on an internal Docker network. Docker never publishes the ports of
an internal network, so a second service, `entry`, runs the same image with `forward.py` (a plain TCP relay) on that
network and on a normal one. It is the only published part and binds to `127.0.0.1` only, at port `AF_EMBEDDER_PORT`
(default 8088). Both containers run read-only with all capabilities dropped and `no-new-privileges`. To stop it:

`docker compose -p af-embedder -f factory/deploy/embedder/compose.yml stop`

Measured on this configuration (CPU, four intra-op threads; `registry-search-measurement.md`, "ONNX re-measurement"):
a query takes 38.1 ms median and 49.3 ms at the 95th percentile at batch size 1, including HTTP and the relay; the
container holds about 1.43 GB of memory (a `docker stats` snapshot); the search quality equals the PyTorch run on every
figure, so the vector threshold 0.47 holds. The measurement run is `factory/deploy/embedder/benchmark.py`, and
`python -m unittest test_server.py` in that directory runs the checksum test. The registry service does not start or
supervise this container; what the registry does while it is down is in `recovery.md`, "Decision Registry".

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
scratch project): take the container down (the volume stays), delete the volume, and start again from Install step 3.
The deletion line proves first, on the same line, that the volume is the one this stack made, and stops with `refusing`
when a volume of that name is someone else's. Never do this on a volume with real data: the deletion cannot be undone.

`docker compose -p agent-factory -f factory/deploy/compose.yml down`

`& $proveVolume 'agent-factory'; docker volume rm agent-factory_pgdata`

A database made before the marker existed (a legacy database) is refused too, although it is complete. The wrapper does
not mark it by itself, because it cannot tell a complete database from a half-made one without logging in to a server
that is not running. The owner marks it once, after checking it, while the previous version still runs and answers (the
check needs a running server; the new wrapper refuses to start an unmarked one). The whole ordered sequence, with the
backup before it, the proof that the same data is served afterwards and the way back, is "Upgrade of a running stack"
below; a stack that already restarts in a loop has its own way out there. The two commands that do the marking are
described here. The check is a script, read-only, run from the repository root:

`node factory/deploy/verify-init.ts`

For another project name, run the same command with `--project` and the name added at the end; for a container made by
hand that belongs to no project (the restart-loop way out below), name the container instead, as in the checks of that procedure (the two options
cannot be combined: exit 2). It verifies, as `af_backup` in one session, every postcondition of
`init/10-roles.sh` and `init/99-finish.sh`: the six roles and their attributes (only `af_bootstrap` is a superuser;
no other role may create roles or databases, replicate or bypass row security), that no role is a member of another,
the read-only and timeout settings of `af_reader`, the owner of the database and of its schemas, the connect and schema
rights of `PUBLIC` and of the application roles, the effective privileges of every role on every table, view, sequence
and function of the database (compared with the intended set, so an extra grant fails as surely as a missing one; the
intended set comes from the same definition as the init scripts' checks), no column-level grants, the `vector`
extension, the default privileges, no leftover service file and no trust rule in the data directory's `pg_hba.conf`.
Authentication is proved on the running server, not on
a file: the rules the server really uses are read as `af_bootstrap` from `pg_hba_file_rules` (whatever file the server's
`hba_file` names; the failure message names it) and every rule must be
`scram-sha-256` or `reject`, because an active `trust` rule would let any password in and a successful login would then
prove nothing. The file must not be newer than the server's last load of its configuration (otherwise the rules shown
are not the ones the server runs, and the check fails: reload or restart the server), and a login as `af_bootstrap`
over TCP must be refused by the rules in every database of the cluster (`postgres`, `agent_factory`, `template1`). Each application role then logs in over TCP with the password of its secret file, and one more login as
`af_api` with a password that is in no secret file must be refused. Each check prints `ok` or `FAIL <name>: <reason>`, and the script exits 0 only when all of
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

Start (or wait for the next automatic attempt) and wait for `healthy` as in Install step 3. Do not use `compose start`
or `docker start` on the old container to bring it back after an update: they restart the container as it was made, with
the old entrypoint. The container of the new revision is made by `up -d` (see the next section).

## Upgrade of a running stack

Applies to a stack that runs from an earlier revision of `factory/deploy` (made before the marker `.af-init-complete`
and the start wrapper existed) and is to run the revision of the repository now. Updating the repository and running
`up -d` at once is wrong: compose recreates the container from the new file, the new wrapper refuses the unmarked data
directory, and `unless-stopped` restarts the refused container again and again, while the marking commands need a
running container. The order below avoids that. Every step is a command to run and read; stop at the first one that does
not do what its text says. Set `AF_SECRETS_DIR` (and `AF_PG_PORT` when the stack runs on another port) in this window
first, as in "Stop and start":

`$env:AF_SECRETS_DIR = $secrets`

Upgrade, in this order:

1. Save the deploy files of the revision that runs now, before the repository is updated: the way back needs them. The
   copy refuses to overwrite a directory that exists. When the repository was already updated, check out the old
   revision into a separate working tree and copy from there instead:

   `if (Test-Path $old) { throw "refusing: $old exists" } else { Copy-Item -Recurse factory/deploy $old }`

2. Update the repository:

   `git pull --ff-only`

3. Take a backup and check it restores (see "Backup" and "Restore check"). The backup command prints `backup written: <manifest path>`;
   the check takes exactly that manifest, never "the newest one" of the directory, which may belong to another backup:

   `node factory/deploy/backup/backup.ts --target $backups`

   `$manifest = Join-Path $backups 'af-<UTC stamp>-<8 hex>.manifest.json'` (the `<UTC stamp>-<8 hex>` part of the name the command above printed)

   `node factory/deploy/backup/restore-check.ts --manifest $manifest`

4. Record what runs now: the container id, the data volume's name and the system identifier of the database (a number
   that belongs to the data and survives every recreation of the container). The record is a new file next to the
   backups; the proof comes first on the same line:

   `$record = Join-Path $backups ('upgrade-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')`

   `& $proveVolume 'agent-factory'; $id = docker inspect --format '{{.Id}}' agent-factory-postgres-1; $m = docker inspect --format '{{json .Mounts}}' agent-factory-postgres-1 | ConvertFrom-Json; $vol = ($m | Where-Object { $_.Destination -eq '/var/lib/postgresql/data' }).Name; $sysid = ((docker exec -u postgres agent-factory-postgres-1 /usr/lib/postgresql/16/bin/pg_controldata /var/lib/postgresql/data | Select-String 'Database system identifier').Line -replace '\D', ''); if (-not $id -or -not $vol -or -not $sysid) { throw "refusing: the record would miss a container id, a volume or a system identifier" }; @{ container = $id; volume = $vol; system = $sysid } | ConvertTo-Json | Out-File -NoClobber -Encoding ascii $record`

   `Get-Content $record`

   The record must show a container id, the volume `agent-factory_pgdata` and a system identifier of about 19 digits.

5. Check the database that runs, with the old container still up (read-only; every line must be `ok`, see "A start that
   refuses" for what it covers):

   `node factory/deploy/verify-init.ts`

   When it exits 1, do not go on: restore from a known-good backup (`recovery.md`).

6. Mark it, then confirm the marker:

   `docker exec -u postgres agent-factory-postgres-1 touch /var/lib/postgresql/data/.af-init-complete`

   `node factory/deploy/verify-init.ts --with-marker`

7. Stop the old container and wait until the daemon has recorded the stop:

   `docker compose -p agent-factory -f factory/deploy/compose.yml stop`

   `docker wait agent-factory-postgres-1`

8. Create the container of the new revision on the same volume, with the same secrets directory and port:

   `& $proveVolume 'agent-factory'; docker compose -p agent-factory -f factory/deploy/compose.yml up -d`

9. Wait for `healthy` (at most 3 minutes), then confirm that this is the new container on the old data before any
   client connects. Each line below stops with `refusing` when its fact is wrong; when one does, do not start any client
   and go to "Roll back":

   `$i = 0; while ($i -lt 60 -and (docker inspect --format '{{.State.Health.Status}}' agent-factory-postgres-1) -ne 'healthy') { Start-Sleep 3; $i++ }`

   `$r = Get-Content (Get-ChildItem $backups -Filter 'upgrade-*.json' | Sort-Object LastWriteTime | Select-Object -Last 1).FullName -Raw | ConvertFrom-Json`

   `if ((docker inspect --format '{{.State.Health.Status}}' agent-factory-postgres-1) -ne 'healthy') { throw "refusing: the new container is not healthy" }`

   `$id = docker inspect --format '{{.Id}}' agent-factory-postgres-1; if (-not $r.container -or -not $id -or $id -eq $r.container) { throw "refusing: this is still the old container, or an id is missing" }`

   `if ((docker inspect --format '{{json .Config.Entrypoint}}' agent-factory-postgres-1) -notmatch 'entrypoint\.sh') { throw "refusing: the container does not start through the wrapper" }`

   `if ((docker inspect --format '{{json .Config.Healthcheck.Test}}' agent-factory-postgres-1) -notmatch 'af-init-complete') { throw "refusing: the container has the old healthcheck" }`

   `$m = docker inspect --format '{{json .Mounts}}' agent-factory-postgres-1 | ConvertFrom-Json; $vol = ($m | Where-Object { $_.Destination -eq '/var/lib/postgresql/data' }).Name; if (-not $r.volume -or -not $vol -or $vol -ne $r.volume) { throw "refusing: the container serves another volume, or a volume name is missing" }`

   `$sysid = ((docker exec -u postgres agent-factory-postgres-1 /usr/lib/postgresql/16/bin/pg_controldata /var/lib/postgresql/data | Select-String 'Database system identifier').Line -replace '\D', ''); if (-not $r.system -or -not $sysid -or $sysid -ne $r.system) { throw "refusing: the database is not the one recorded, or an identifier is missing" }`

   `node factory/deploy/verify-init.ts --with-marker`

Roll back, when step 9 failed or the new revision is not wanted. The old revision is started again from the copy of
step 1, on the same volume (the data was not changed by the upgrade except for the marker file, which the old revision
ignores). The old container is not brought back with `start`: that is a container of a file that may no longer match
the repository; it is made again from the copy:

1. Stop the new container and wait for the stop:

   `docker compose -p agent-factory -f factory/deploy/compose.yml stop`

   `docker wait agent-factory-postgres-1`

2. Make the container from the old files (the proof first, on the same line), and wait for `healthy`:

   `& $proveVolume 'agent-factory'; docker compose -p agent-factory -f "$old/compose.yml" up -d`

   `$i = 0; while ($i -lt 60 -and (docker inspect --format '{{.State.Health.Status}}' agent-factory-postgres-1) -ne 'healthy') { Start-Sleep 3; $i++ }`

3. Confirm the same data is served (the line stops with `refusing` when not) and that the server answers:

   `$r = Get-Content (Get-ChildItem $backups -Filter 'upgrade-*.json' | Sort-Object LastWriteTime | Select-Object -Last 1).FullName -Raw | ConvertFrom-Json`

   `$sysid = ((docker exec -u postgres agent-factory-postgres-1 /usr/lib/postgresql/16/bin/pg_controldata /var/lib/postgresql/data | Select-String 'Database system identifier').Line -replace '\D', ''); if (-not $r.system -or -not $sysid -or $sysid -ne $r.system) { throw "refusing: the database is not the one recorded, or an identifier is missing" }`

   `node factory/deploy/verify-init.ts --with-marker`

A stack that already restarts in a loop (the repository was updated and `up -d` was run before the database was
marked): the container never becomes healthy and `docker logs agent-factory-postgres-1` says `refusing to start`. The
data is intact. The way out starts one container on the volume that does not run the wrapper (the image's own
entrypoint, with the service's own settings), checks and marks the database there, and then makes the container of the
service again:

1. Stop the looping container and wait for the stop:

   `docker compose -p agent-factory -f factory/deploy/compose.yml stop`

   `docker wait agent-factory-postgres-1`

2. Start the one-off container on the volume (the proof first, on the same line). The checks below name it
   by its container name (the option `container` of `verify-init.ts`), so they need no project or service label to find it:

   `& $proveVolume 'agent-factory'; docker compose -p agent-factory -f factory/deploy/compose.yml run -d --no-deps --name agent-factory-oneoff --entrypoint docker-entrypoint.sh postgres postgres -c hba_file=/etc/agent-factory/pg_hba.conf`

   (The first `postgres` is the service, the rest is the server command of the service, which an overridden entrypoint
   does not keep: without it the container exits at once with nothing to run.)

3. Wait for `healthy` is not available here (the one-off has no wrapper-made passfile); wait until it answers, then check
   and mark as in steps 5 and 6 above, naming the one-off container:

   `$i = 0; while ($i -lt 60 -and (docker exec agent-factory-oneoff pg_isready -h 127.0.0.1 -U af_backup) -notmatch 'accepting') { Start-Sleep 3; $i++ }`

   `node factory/deploy/verify-init.ts --container agent-factory-oneoff`

   `docker exec -u postgres agent-factory-oneoff touch /var/lib/postgresql/data/.af-init-complete`

   `node factory/deploy/verify-init.ts --container agent-factory-oneoff --with-marker`

4. Stop the one-off container, wait for the stop, remove it (only after checking that it is the one-off container of
   this project) and make the container of the service on the marked volume:

   `docker stop agent-factory-oneoff`

   `docker wait agent-factory-oneoff`

   `if ((docker inspect --format '{{json .Config.Labels}}' agent-factory-oneoff | ConvertFrom-Json).'com.docker.compose.oneoff' -ne 'True') { throw "refusing: not a one-off container" } else { docker rm agent-factory-oneoff }`

   `& $proveVolume 'agent-factory'; docker compose -p agent-factory -f factory/deploy/compose.yml up -d`

   Then confirm as in step 9 (the record of step 4 exists only when step 4 was run before the update; without it, check
   the health, the entrypoint and `verify-init.ts --with-marker`).

## Backup

Reads through `af_backup` (select only), inside the container. From the repository root:

`node factory/deploy/backup/backup.ts --target $backups`

The server dumped is the project `agent-factory`. After a switch-over to a restored project, name it (see
`recovery.md`):

`node factory/deploy/backup/backup.ts --target $backups --project $project`

The command needs no `AF_SECRETS_DIR`: the password is read inside the container.

A backup holds the whole database, so the backups directory must be protected like the secrets directory: open to the
current user, SYSTEM and Administrators only. A target that is missing is created and restricted that way by the
command. A target that already exists is only verified (by SID, so a localized system does not matter): when it is
open to anyone else the backup refuses before it writes a byte, names the entries and changes nothing. Restrict an
existing directory once with (the last entry is the current user):

`icacls $backups /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*$((whoami /user /fo csv /nh | ConvertFrom-Csv -Header n,s).s):(OI)(CI)F"`

An entry the directory holds for another account itself (not inherited) stays after this command; remove it with
`icacls $backups /remove` and the account's name. Verify the result with the check of the header, which runs the check
of the secrets directory on this directory and keeps only its access findings (a directory of backups holds no secret
files, so the "file is missing" findings do not apply); it stops with `refusing` and the entries when the directory is
missing, is not a directory, is open to anyone else or can be committed, and prints nothing when the directory is fine:

`& $protectedDir $backups`

The run's private staging directory inside the target gets the same access explicitly and the result is read back
before the first dump byte is written, so no dump is ever written under an access it merely inherited.

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

The check also covers the tables of the applied migrations: row counts and foreign keys are compared per table, so
a backup of a migrated database is proven table by table.

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
breakages. `factory/tests/volume-identity.test.ts` runs every command of this document and of `recovery.md` that
mounts or removes the data volume against a same-name volume that compose did not make: each must refuse and leave it
whole. `factory/tests/docs-commands.test.ts` runs the emergency volume copy of `recovery.md` (existing name, full disk,
interruption, unprotected directory), and `factory/tests/upgrade-rehearsal.test.ts` the upgrade, rollback and
restart-loop procedures described above. A file
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
