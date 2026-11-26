// A helper process for dead-owners-create.test.ts. It creates docker objects only through the owned-docker helpers, prints
// what it made, and is then killed (SIGKILL) at once, before it could record or register anything: the window between the
// creation and the first bookkeeping. It is not a test.
import { writeSync } from "node:fs";
import { newRunId } from "../deploy/lib.ts";
import { createContainer, createNetwork, createVolume } from "./owned-docker.ts";

const runId = newRunId();
const volume = await createVolume(runId, `af-test-${runId}`);
const network = await createNetwork(runId, `af-test-${runId}`);
// "-v /data" makes an anonymous volume, which cannot carry a label of its own.
const container = await createContainer(runId, "-v", "/data", "alpine:latest", "true");
writeSync(1, JSON.stringify({ runId, volume, network, container }));
process.kill(process.pid, "SIGKILL");
