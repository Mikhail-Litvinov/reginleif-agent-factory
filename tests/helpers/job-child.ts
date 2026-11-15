import { writeFileSync } from "node:fs";

// The detached child of jobbed-parent: records its pid and stays alive until the test kills it.
const STAY_ALIVE_MS = 120_000;
const pidPath = process.argv[2];

if (pidPath === undefined) process.exit(2);
// The environment is recorded first: the pid file is what the test waits for.
writeFileSync(`${pidPath}.env`, JSON.stringify(Object.keys(process.env)));
writeFileSync(pidPath, String(process.pid));
await new Promise((resolve) => { setTimeout(resolve, STAY_ALIVE_MS); });
