// A helper process for leak-guard.test.ts: it creates a stack the way the test helpers do (cleanup registered first), prints
// what it made as JSON, and then ends WITHOUT running any cleanup, like a killed or crashed test process. It is not a test.
import { freePort, runChecked, stackArgs, stackEnv } from "../deploy/lib.ts";
import { OwnedDir } from "../deploy/owned.ts";
import { Cleanups, newSecretsDir, trackedProject } from "./helpers.ts";

const cleanups = new Cleanups();
const secretsDir = await newSecretsDir(cleanups);
const port = await freePort();
const { project, runId } = trackedProject(cleanups);
await runChecked("docker", stackArgs({ project, secretsDir, port, runId }, "up", "-d", "postgres"), { env: stackEnv({ project, secretsDir, port, runId }) });
process.stdout.write(JSON.stringify({ runId, secretsDir, token: OwnedDir.tokenOf(secretsDir) }));
process.exit(0);
