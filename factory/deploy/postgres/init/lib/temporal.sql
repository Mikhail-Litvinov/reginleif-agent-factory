-- The Postgres side of Temporal (docs/agent-factory/database.md "The Temporal databases"): one role, af_temporal, and two
-- databases it owns, af_temporal (the main store) and af_temporal_visibility. Idempotent: every statement is guarded or
-- repeatable, so the same file serves a new install (init/20-temporal.sh) and an existing data directory
-- (deploy/bootstrap-temporal.ts), both as the bootstrap role over the local socket, fed through psql's standard input.
--
-- The password is read here, from the secret file the container mounts, and reaches the server only as a psql variable
-- quoted as a literal (:'secret'); it is on no command line and in no environment variable. A failing statement is not
-- logged with its text (it would show the password).
SET log_min_error_statement = panic;

\set secret `cat /run/secrets/af_temporal`

-- An empty value, a character outside the allowed set, or a failed read (the variable is then unset or empty) stops the
-- script: the deliberate division by zero is the failure, ON_ERROR_STOP makes it final.
SELECT :'secret' !~ '^[A-Za-z0-9_-]+$' AS secret_bad \gset
\if :secret_bad
\echo init: secret af_temporal is missing, empty, or holds characters other than A-Z a-z 0-9 _ -
SELECT 1/0;
\endif

-- The role. When it exists already it is brought back to the intended attributes and the password of the secret file
-- (a rotated secret is followed, a drifted attribute repaired).
SELECT NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'af_temporal') AS role_missing \gset
\if :role_missing
CREATE ROLE af_temporal LOGIN PASSWORD :'secret' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
\else
ALTER ROLE af_temporal LOGIN PASSWORD :'secret' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
\endif

-- The databases. The owner holds every right in its own database (PostgreSQL 16 makes the owner of the database the owner
-- of schema public through pg_database_owner, so Temporal's schema tool creates its tables there); nobody else holds
-- any: PUBLIC loses its default connect and temporary rights, and no application role is ever granted one.
SELECT NOT EXISTS (SELECT FROM pg_database WHERE datname = 'af_temporal') AS main_missing \gset
\if :main_missing
CREATE DATABASE af_temporal OWNER af_temporal;
\endif
ALTER DATABASE af_temporal OWNER TO af_temporal;
REVOKE ALL ON DATABASE af_temporal FROM PUBLIC;

SELECT NOT EXISTS (SELECT FROM pg_database WHERE datname = 'af_temporal_visibility') AS visibility_missing \gset
\if :visibility_missing
CREATE DATABASE af_temporal_visibility OWNER af_temporal;
\endif
ALTER DATABASE af_temporal_visibility OWNER TO af_temporal;
REVOKE ALL ON DATABASE af_temporal_visibility FROM PUBLIC;
