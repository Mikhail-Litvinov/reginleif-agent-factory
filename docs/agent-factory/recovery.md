# Recovery of the Agent Factory database

What to do when the database is lost or damaged, and what is lost. Installation and backup commands are in
`deployment.md`. Commands are PowerShell.

## What a restore loses

Everything written after the backup that is restored: rows, new accounts' grants made after it, and any change made
with the application between the backup and the failure. A backup is a point in time, there is no continuous archive
(no WAL shipping), so the loss is as old as the newest backup. Take a backup before any risky change.

The dump holds the application database only. It does not hold the roles and their passwords (these live in the
cluster) or the secrets directory. Roles and the empty database come from a fresh start of the stack (init), with the
passwords in `E:/agent-factory/secrets`. If those secret files are gone too, a new set is made with
`setup-secrets.ts` on an empty directory, and the applications must receive the new passwords.

## Before relying on a backup

Run the restore check on it (`deployment.md` "Restore check"). Exit 0 means the file restores into a clean server and
the row counts and foreign keys equal those recorded at backup time. The newest backup is checked right after it is
taken, and again before a real restore.

## Restoring into a new project

Rule: recovery never destroys the old data before the replacement is proven. The restore goes into a NEW project (its
own container, volume `<project>_pgdata` and network), is verified there, and only then is it switched to. The old
volume stays until a person removes it. Replace `<stamp>` with the backup to use. No command below carries a password:
`restore.ts` reads the secret files and uses a passfile that exists only while the command runs.

1. Check the backup: `node factory/deploy/backup/restore-check.ts --manifest E:/agent-factory/backups/af-<stamp>.manifest.json`
2. Restore into the new project (default name `agent-factory-restored`, a free loopback port):

   `cd factory; npm run restore -- --manifest E:/agent-factory/backups/af-<stamp>.manifest.json --secrets E:/agent-factory/secrets`

   It verifies the checksum file and the manifest by content, starts the new project from an empty volume (init creates
   the roles), REFUSES to continue if its database already holds any object (a restore fills an empty database only),
   restores the dump, re-applies the database-level rights that a dump does not carry, and compares row counts and
   foreign keys with the manifest. On success it prints the project and the port; on failure it removes the project it
   created and prints the problems. It never touches the old stack.
3. Judge the result yourself, connecting to the new project's port with each account if wished (passfile, never a
   password in a command line: `docker exec` the container and use `PGPASSFILE`, as `restore.ts` does).
4. Switch: stop the applications, stop the old stack (`docker compose -p agent-factory ... stop`, NOT `down -v`), then
   start the restored project on the real port: `$env:AF_SECRETS_DIR='E:/agent-factory/secrets'; $env:AF_PG_PORT=55432;
   docker compose -p agent-factory-restored -f factory/deploy/compose.yml up -d`, and wait for `healthy`. Point the
   applications at it. The container is then `agent-factory-restored-postgres-1`.
5. Remove the old volume only when satisfied, later and by hand: `docker volume rm agent-factory_pgdata` (after
   `docker compose -p agent-factory ... down`). Nothing in the procedure does this.

`restore.ts` replaces the fragile manual steps of an earlier version (dropping the database and piping the dump through
`docker exec` with a password). Its behaviour is proven end to end by `factory/tests/recovery.test.ts`: a stack with
tables, rows, a foreign key, a vector column and rights for every account is backed up and restored into a new project;
all five application accounts then behave exactly as before, the old stack is unchanged, and a restore into a database
that holds data (the new project, or the old stack itself) is refused. The check on a damaged backup (dump, checksum
file, manifest) is proven by `backup.test.ts` and `streams.test.ts`. The new-project procedure was run on the real stack
with its empty database only; no table-bearing drill was made there.

## Server does not come back

- Container stopped by hand (including `docker kill`): `docker start agent-factory-postgres-1`.
- Container crashed: the restart policy restarts it; look at `docker logs agent-factory-postgres-1` if it loops.
- Data volume intact but the server refuses to start: do not delete the volume. Copy it first
  (`docker run --rm -v agent-factory_pgdata:/d -v E:/agent-factory/volume-copy:/o alpine tar -C /d -czf /o/pgdata.tgz .`)
  and then go to the restore above. (The copy command names no password.)

## Not covered

No schedule, no encryption, no off-host copy of the backups or the secrets, no retention, no continuous archive, and no
recovery procedure for the Temporal pair: see `deployment.md` "Not covered". The volume copy for a damaged volume was
written from the design and was not executed on the real stack.
