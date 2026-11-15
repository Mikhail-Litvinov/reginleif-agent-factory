import { existsSync, writeFileSync } from "node:fs";

import { spawnDetached } from "../../src/commands/process-runner.js";
import { messagesFor } from "../../src/messages";

const TEST_MESSAGES = messagesFor("en");

// A stand-in for a hub-owned process: the test puts this process in a job object, writes the go file, and this process
// then starts a detached child through rig's own spawnDetached and records the outcome.
const GO_POLL_MS = 20;
const STAY_ALIVE_MS = 120_000;
const CHILD_GRACE_MS = 2000;
const STDERR_LIMIT = 1000;
const [, , goPath, resultPath, childScript, childArgument, stderrPath] = process.argv;

if (goPath === undefined || resultPath === undefined || childScript === undefined || childArgument === undefined || stderrPath === undefined) process.exit(2);

while (!existsSync(goPath)) await new Promise((resolve) => { setTimeout(resolve, GO_POLL_MS); });
const outcome = await spawnDetached([process.execPath, childScript, childArgument], CHILD_GRACE_MS, STDERR_LIMIT, stderrPath, "en");
writeFileSync(resultPath, JSON.stringify(outcome));
await new Promise((resolve) => { setTimeout(resolve, STAY_ALIVE_MS); });
