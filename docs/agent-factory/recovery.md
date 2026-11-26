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
   exists. The loopback port is a free one; to choose it, run the same command with `--port <port>` added at the end.
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

   `docker compose -p "agent-factory-restored-$hex" -f factory/deploy/compose.yml -f factory/deploy/compose.run.yml up -d`

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

   `docker volume rm agent-factory_pgdata`

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
- Container crashed: the restart policy restarts it; look at `docker logs agent-factory-postgres-1` if it loops.
- Data volume intact but the server refuses to start: do not delete the volume. Stop the container (it must not write
  while copied) and wait for the stop, then copy the volume read-only into an existing directory, written once as
  `$copy = '<volume copy dir>'`:

  `docker stop agent-factory-postgres-1`

  `docker wait agent-factory-postgres-1`

  `docker run --rm -v agent-factory_pgdata:/d:ro -v "${copy}:/o" alpine tar -C /d -czf /o/pgdata.tgz .`

  and then go to the restore above. (The copy command names no password.) The image `alpine` is pulled when absent.

## Not covered

No schedule, no encryption, no off-host copy of the backups or the secrets, no retention, no continuous archive, and no
recovery procedure for the Temporal pair: see `deployment.md` "Not covered".
