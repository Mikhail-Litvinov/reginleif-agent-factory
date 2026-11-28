#!/bin/bash
# First-start initialisation, second part: the role and the two databases of Temporal (docs/agent-factory/database.md
# "The Temporal databases"). The statements are in lib/temporal.sql, the one file that the command for an existing data
# directory (deploy/bootstrap-temporal.ts) runs as well, so a new install and a bootstrapped one cannot differ.
#
# The entrypoint sources this file when it is not executable (a Windows bind mount), so no `exit` here.
. /docker-entrypoint-initdb.d/lib/bootstrap.sh

af_init_temporal() {
	af_psql_bootstrap < /docker-entrypoint-initdb.d/lib/temporal.sql
}

af_init_temporal
