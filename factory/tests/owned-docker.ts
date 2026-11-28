// The one place where a test creates a docker object outside a compose stack (a container, a volume, a network). Every
// object made here carries both ownership labels from the moment it exists, in the very command that creates it:
//   af.run   = the run id, which removeOwned selects by
//   af.owner = "<worktree key>:<pid>", which the sweep of dead owners (dead-owners.ts) selects by
// So a test process killed right after the creation (before it registered anything) leaves objects that the next run of
// this worktree finds and removes. An object without af.owner would be invisible to that sweep, which is why tests/owned-
// creation-guard.test.ts fails on a raw `docker create` / `run` / `volume create` / `network create` anywhere else.
// Compose stacks get the same labels from deploy/compose.run.yml (ownedComposeArgs / stackArgs), not from here.
import { run, runChecked, type RunResult } from "../deploy/lib.ts";
import { currentOwner } from "./dead-owners.ts";

export const RUN_LABEL_NAME = "af.run";
export const OWNER_LABEL_NAME = "af.owner";

/** The label flags of an object that belongs to `runId` and to this process. */
export const ownerFlags = (runId: string): string[] => ["--label", `${RUN_LABEL_NAME}=${runId}`, "--label", `${OWNER_LABEL_NAME}=${currentOwner()}`];

const created = async (args: string[]): Promise<string> => (await runChecked("docker", args)).trim();

/** `docker create`: returns the container id. */
export const createContainer = (runId: string, ...args: string[]): Promise<string> => created(["create", ...ownerFlags(runId), ...args]);

/** `docker run` (always detached when `-d` is among the args; otherwise it runs to its end): returns docker's output. */
export const runContainer = (runId: string, ...args: string[]): Promise<string> => created(["run", ...ownerFlags(runId), ...args]);

/** `docker run` of a short-lived client whose exit code is the thing under test: the result, not a throw on a non-zero exit. */
export const runContainerResult = (runId: string, ...args: string[]): Promise<RunResult> => run("docker", ["run", ...ownerFlags(runId), ...args]);

/** `docker volume create` of a NAMED volume (an unnamed one would be anonymous, which cannot carry labels). */
export const createVolume = (runId: string, name: string): Promise<string> => created(["volume", "create", ...ownerFlags(runId), name]);

/**
 * `docker compose up -d` of a stack whose compose file is not this revision's (a legacy fixture). The labels come from the
 * second compose file (deploy/compose.run.yml of this revision, `labelFile`), as for every stack of a test.
 */
export const composeUpFrom = (project: string, composeFile: string, labelFile: string, env: Record<string, string>, ...services: string[]): Promise<string> =>
	runChecked("docker", ["compose", "-p", project, "-f", composeFile, "-f", labelFile, "up", "-d", ...services], { env });

/** `docker network create`. */
export const createNetwork = (runId: string, name: string): Promise<string> => created(["network", "create", ...ownerFlags(runId), name]);
