# Recovery of the Agent Factory database

What to do when the database is lost or damaged, and what is lost. Installation and backup commands are in
`deployment.md`, whose first section also says how to read the commands. They are Windows PowerShell 5.1 commands, run
one after the other in one window from the repository root, and can be pasted as they stand once the placeholders are
filled in. Set these variables first (replace the whole `<...>`, keep the single quotes; paths are absolute):

`$secrets = '<secrets dir>'` and `$backups = '<backups dir>'` are the directories of `deployment.md`.

`$manifest = Join-Path $backups 'af-<stamp>.manifest.json'`, where `<stamp>` is the `<UTC stamp>-<8 hex>` part of the
backup name (the UTC time as `yyyyMMddTHHmmssZ`, a dash, 8 hex digits).

`$hex = '<hex>'` is the 12 hex digits of the restored project's name, known after step 2.

`$env:AF_SECRETS_DIR = $secrets` is needed by every `docker compose` command below.

`$proveVolume = { param($p) $n = $p + '_pgdata'; $all = docker volume ls -q --filter "name=$n"; if ($LASTEXITCODE -ne 0) { throw "refusing: docker could not list volumes, $n is unchecked" }; if (@($all) -contains $n) { $j = docker volume inspect --format '{{json .Labels}}' $n; if ($LASTEXITCODE -ne 0) { throw "refusing: docker could not inspect volume $n" }; $l = $j | ConvertFrom-Json; if ($null -eq $l -or $l.'com.docker.compose.project' -ne $p -or $l.'com.docker.compose.volume' -ne 'pgdata') { throw "refusing: volume $n is not made by compose project $p" } }; $global:LASTEXITCODE = 0 }`

The proof that a data volume is the stack's own (the same line is in `deployment.md`, which explains it). A volume of
that name that compose of that project did not make stops the line with `refusing`. Every command below that brings a
project up, mounts the data volume or removes it starts with `& $proveVolume '<project>'` on the same line, followed
by `;` and the command: a line pasted on its own stops only itself.

`$protectedDir = { param($d) $null = node factory/deploy/setup-secrets.ts --check-access $d; if ($LASTEXITCODE -ne 0) { throw "refusing: $d is not a protected directory" }; $global:LASTEXITCODE = 0 }`

The proof that a directory that will hold a copy of the database is protected like the secrets directory (the same line
is in `deployment.md`, which explains it).

## What a restore loses

Everything written after the backup that is restored: rows, new accounts' grants made after it, and any change made
with the application between the backup and the failure. A backup is a point in time, there is no continuous archive
(no WAL shipping), so the loss is as old as the newest backup. Take a backup before any risky change.

The dump holds the application database only. It does not hold the roles and their passwords (these live in the
cluster) or the secrets directory. Roles and the empty database come from a fresh start of the stack (init), with the
passwords in the secrets directory. If those secret files are gone too, a new set is made with `setup-secrets.ts` on an
empty directory, and the applications must receive the new passwords.

## Before relying on a backup

Run the restore check on it (`deployment.md` "Restore check"). Exit 0 means the file restores into a clean server and
the row counts and foreign keys equal those recorded at backup time. The newest backup is checked right after it is
taken, and again before a real restore. Check the secrets directory too, without changing it:

`node factory/deploy/setup-secrets.ts --check $secrets`

It prints `secrets ready` and exits 0 only when the directory holds all six valid secret files, open to the current
user, SYSTEM and Administrators only, in a place that cannot be committed (a git-ignored path inside a checkout is
accepted); otherwise it prints `secrets NOT ready` with the problems and exits 1. A wrong command line, here and in
every command of this document, exits 2 with a `usage:` line. `restore.ts` runs this same check before anything else
and stops with `secrets are not ready: <problem>` (exit 1) without touching Docker when the directory fails it.

## Restoring into a new project

Rule: recovery never destroys the old data before the replacement is proven. The restore goes into a NEW project (its
own container, volume `<project>_pgdata` and network), is verified there, and only then is it switched to. The old
volume stays until a person removes it. No command below carries a password: `restore.ts` reads the secret files and
uses a passfile that exists only while the command runs.

1. Check the backup:

   `node factory/deploy/backup/restore-check.ts --manifest $manifest`
2. Restore into the new project:

   `npm --prefix factory run restore -- --manifest $manifest --secrets $secrets`

   The project name is generated, `agent-factory-restored-<hex>` (12 random hex digits); it cannot be chosen, so it
   never names an existing project, and the command refuses when any container, volume or network of that name
   exists. The loopback port is a free one; to choose it, run the same command with `--port` and a port number added at the end.
   The paths must be absolute, because npm runs the script inside `factory/`. The command verifies the checksum file and the
   manifest by content, starts the new project from an empty volume (init creates the roles and an empty database),
   restores the dump with `pg_restore --exit-on-error` (an object that already exists stops it), re-applies the
   database-level rights that a dump does not carry, and compares row counts and foreign keys with the manifest. On
   success it prints `restored and verified in project agent-factory-restored-<hex> (loopback port <n>); the old stack
   was not touched` and keeps the project running. On failure it removes only what carries its own run label and
   prints the problems; exit code 1 (2 on a usage error). It never touches the old stack. Write the project name down
   and set `$hex` (see the top): the next steps need it.
3. Judge the result yourself, connecting to the new project's port with each account if wished (passfile, never a
   password in a command line: `docker exec` the container and use `PGPASSFILE`, as `restore.ts` does). The new
   container is `agent-factory-restored-<hex>-postgres-1`.
4. Switch over. This is manual and nothing in the repository does it for you. Stop the applications, then stop the old
   stack (`stop`, NOT `down -v`), and wait until the daemon has recorded the stop. Without the wait the port 55432 may
   still be held and the next start can be silently lost (`deployment.md` "Stop and start"):

   `docker compose -p agent-factory -f factory/deploy/compose.yml stop`

   `docker wait agent-factory-postgres-1`

   The restored container is still bound to its random port. Recreate it on the real port from the same volume (the
   volume `agent-factory-restored-<hex>_pgdata` and its data are kept). Give the same two compose files and the run
   id (the `<hex>` of the project name) that `restore.ts` used, so that the configuration matches the existing volume
   and network; with `compose.yml` alone compose stops to ask whether to recreate the volume ("data will be lost"),
   and a `y` there destroys the restored data:

   `$env:AF_RUN_ID = $hex; $env:AF_PG_PORT = '55432'`

   `& $proveVolume "agent-factory-restored-$hex"; docker compose -p "agent-factory-restored-$hex" -f factory/deploy/compose.yml -f factory/deploy/compose.run.yml up -d`

   Wait until this prints `healthy` (run it again until it does), and point the applications at `127.0.0.1:55432`:

   `docker inspect --format '{{.State.Health.Status}}' "agent-factory-restored-$hex-postgres-1"`

   From now on the project is `agent-factory-restored-<hex>`: every later command that names `agent-factory` (stop,
   start, `down`, and `backup.ts --project agent-factory`) must name this project instead, for example

   `node factory/deploy/backup/backup.ts --target $backups --project "agent-factory-restored-$hex"`

   A later `up -d` of this project needs the same `AF_RUN_ID` and both compose files as above. This sequence (a labelled
   project stopped, then recreated with the other port) was run on a scratch project (container recreated on the other
   port, same volume, no prompt); it was not run on a restored project of the real stack.
5. Remove the old volume only when satisfied, later and by hand, after taking the old stack down (the old stack is
   not labelled, so `AF_RUN_ID` does not matter for these lines):

   `docker compose -p agent-factory -f factory/deploy/compose.yml down`

   `& $proveVolume 'agent-factory'; docker volume rm agent-factory_pgdata`

   The proof comes first: a volume of that name that compose did not make is someone else's and is not removed.
   Nothing in the procedure does this.

`restore.ts` replaces the fragile manual steps of an earlier version (dropping the database and piping the dump through
`docker exec` with a password). Its behaviour is proven end to end by `factory/tests/recovery.test.ts`: a stack with
tables, rows, a foreign key, a vector column and rights for every account is backed up and restored into a new project;
all five application accounts then behave exactly as before, the old stack is unchanged, a taken project name is
refused with nothing created, and a damaged or unfinished backup is refused before anything is created. The check on a
damaged backup (dump, checksum file, manifest) is also covered by `backup.test.ts` and `streams.test.ts`. The
new-project procedure and the switch-over were not run on the real stack with tables (its database was empty), and
`restore.ts` was never run against the real stack at all; steps 4 and 5 were checked against the code only.

## Server does not come back

- Container stopped by hand (including `docker kill`): wait until the daemon has recorded the stop, then start (a start
  in the window before that is silently lost, `deployment.md` "Stop and start"):

  `docker wait agent-factory-postgres-1`

  `docker start agent-factory-postgres-1`

  `docker inspect --format '{{.State.Status}}' agent-factory-postgres-1` must print `running`.
- Container crashed: the restart policy restarts it; look at `docker logs agent-factory-postgres-1` if it loops. When
  the log says `refusing to start`, the data directory has no record of a completed initialisation: see `deployment.md`
  "A start that refuses" (it is not a crash, and a restart will not change it).
- Data volume intact but the server refuses to start: do not delete the volume. Stop the container (it must not write
  while copied) and wait for the stop, then copy the volume read-only into an existing, protected directory, written
  once as `$copy = '<volume copy dir>'`. The copy holds the whole database, so the directory must be protected like the
  backups directory: restrict it with the `icacls` command of `deployment.md` "Backup" (with `$copy` in place of
  `$backups`); the copy command below checks it and refuses otherwise:

  `docker stop agent-factory-postgres-1`

  `docker wait agent-factory-postgres-1`

  The copy goes to a new file whose name is made now (time and a random part):

  `$name = 'pgdata-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.tgz'`

  The one command below does four things in this order, and stops at the first that fails. It checks that `$copy` is
  protected (`$protectedDir`). It checks that the volume is the stack's own (`$proveVolume`): a same-name volume that
  compose did not make is not copied. Inside the container the shell then writes to `<name>.part`, with no-overwrite
  (`set -C`), and only a finished archive that reads back as a whole (`tar -t`) is renamed to its final name, without
  replacing a file (`mv -n`); the name is printed only then. An interrupted copy (Ctrl+C, the container stopped), a full
  disk or a failed write leaves no `.tgz` and removes its `.part` file and exits non-zero; no half archive is ever
  presented as the result. (Only a kill that gives the shell no chance to react, such as a power loss, can leave a
  `.part` file; it is never a copy, delete it by hand.)

  `& $protectedDir $copy; & $proveVolume 'agent-factory'; docker run --rm -e NAME=$name -v agent-factory_pgdata:/d:ro -v "${copy}:/o" alpine sh -c 'set -C; f() { kill $p 2>/dev/null; rm -f /o/$NAME.part; }; g() { exit 1; }; [ ! -e /o/$NAME ] || exit 1; trap f EXIT; trap g INT TERM HUP; tar -C /d -czf - . > /o/$NAME.part & p=$!; wait $p && tar -tzf /o/$NAME.part > /dev/null && mv -n /o/$NAME.part /o/$NAME && [ ! -e /o/$NAME.part ] && echo $NAME'`

  It prints the name of the file and nothing else on success; then go to the restore above. (The copy command names no
  password.) The image `alpine` is pulled when absent.

## Decision Registry

The registry (`factory/registry/`) keeps its records, links, inquiries and embeddings in the application database, so a
restore (above) brings all of it back as of the backup. Nothing of the registry lives outside the database except the
embedding model, which is a separate container (`deployment.md`, "Embedder container").

What is lost and how it comes back:

- Records, links, inquiries and verdicts written after the newest backup are lost with everything else; only a new entry
  restores them.- The embedder container holds no data. If it is lost, its image is rebuilt and started from the staged model files with
  the commands of `deployment.md`; the files are checked by SHA-256 on every start, so a damaged copy refuses to start
  instead of producing wrong vectors. The stored vectors are not affected.
- A vector exists per record and per model version (`registry_embeddings`, 1024 dimensions, one row for each pair) and
  is in the dump with its record, so a restored record has the vectors it had at the backup.

Re-embedding after a model change. The search reads only the vectors of the model version named by the setting
`registry.embeddingModel` (default: the pinned revision `5617a9f61b028005a4858fdac845db406aefb181`). When the model or
its revision changes, the old vectors stay in place and are never overwritten; the new ones are added beside them, so
the old version keeps working until the new one is complete. The client is `factory/registry/embedder-client.ts`:

- `reembedBatch(version, limit)` takes up to `limit` records that have a vector of another version and none of the
  target version, asks the embedder for them and writes the new rows, all in one transaction under one lock, so two
  runs cannot embed the same record twice. A response whose revision differs from the requested version, or whose
  vector count or size (1024) is wrong, is refused and nothing is written.
- `reembedAll(version, limit)` repeats batches until one returns 0.
- `startBackground(version, limit, intervalMs, { onError })` runs `reembedAll` again every interval and returns a
  function that stops it; an error goes to `onError` and the next interval tries again.
- The setting `registry.embeddingModel` is changed to the new version only when the pass is complete. Until then a
  search with the new version would find only the records already embedded.

The client is not yet started by any running service: nothing calls `reembedAll` or `startBackground` outside the
tests, so after a model change the pass has to be started by code that builds the client with `httpEmbedderTransport`
for the embedder's URL. There is no command for it.

When search is down. The gate (`factory/registry/gate.ts`) answers a question before a person is asked. It waits for the
search at most `registry.gateTimeoutMs`. When the time runs out, or the check fails (database or embedder not
reachable), the gate lets the question through (fail open) and records the reason, `timeout` or `unavailable`, through
a local callback that does not need the database, so a registry that is down cannot stop the record of its own
failure. This is on purpose: a dead registry must not stop the work (G1, `governance.md`). The cost is that a question
that a recorded decision would have answered goes to the owner. The gate blocks (`pass: false`, with the records) only
when it finds an inquiry result without a verdict or with the verdict `applies`. Today the callback only writes a log
line; no row is stored, so the number of fail-open passes is read from the log.

Degraded search. When the embedder does not answer, a search does not fail. It still runs the full-text search in
Russian and English, marks the result `degraded: true`, and adds a trigram search as a fallback for typos
(`registry.trigramThreshold`, default 0.1846). Vector results are absent, so a question worded differently from the
record may find nothing: a degraded result is weaker, not wrong. The search returns to normal on the next call after
the embedder answers again; nothing has to be repaired.

## Not covered

No schedule, no encryption, no off-host copy of the backups or the secrets, no retention, no continuous archive, and no
recovery procedure for the Temporal pair: see `deployment.md` "Not covered".
