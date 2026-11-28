// The Control Worker (temporal.md "Workers", D28): queue `control`, workflows and local activities only. It never takes an
// activity task, so a machine activity scheduled there by mistake would hang visibly instead of running on the wrong host.
import { Worker, type NativeConnection } from "@temporalio/worker";
import type { Client } from "@temporalio/client";
import { fileURLToPath } from "node:url";
import type { SettingsReader } from "../db/repo/settings.ts";
import { CONTROL_QUEUE } from "./workflow-client.ts";
import { WORKFLOW_TASK_TIMEOUT_SECONDS, allTimeoutKeys, createActivityCatalog, invalidTimeoutKeys, localTimeoutViolations } from "./activity-catalog.ts";
import { LIVENESS_SETTING_KEYS, livenessSettingsProblems } from "./liveness-settings.ts";
import type { ControlActivities } from "./activities/index.ts";
import { ensureMachineLivenessSchedule } from "./machine-liveness-schedule.ts";

/** The workflow bundle entry, absolute with forward slashes (what the Worker needs on Windows). */
export const CONTROL_WORKFLOWS_PATH = fileURLToPath(new URL("../workflows/index.ts", import.meta.url)).replaceAll("\\", "/");

export interface ControlWorkerOptions {
	readonly connection: NativeConnection;
	/** The Client of the same server: creates the machine-liveness Schedule at startup (a NativeConnection cannot build a Client). */
	readonly client: Client;
	readonly settings: SettingsReader;
	readonly activities: ControlActivities;
	readonly workflowsPath?: string;
	readonly namespace?: string;
}

/**
 * The reasons the worker must not start, all of them at once: every `act.<Name>.*` key that is unset or not a positive number
 * of seconds, and every local activity whose start-to-close is not below the workflow task timeout (it runs inside one).
 */
export const controlSettingsProblems = (snapshot: Readonly<Record<string, unknown>>, bound: number = WORKFLOW_TASK_TIMEOUT_SECONDS): string[] => {
	// The liveness settings (package 57) are checked with the act.* ones and reported with them, even when act.* is invalid.
	const liveness = livenessSettingsProblems(snapshot);
	const missing = invalidTimeoutKeys(snapshot);
	if (missing.length > 0) return [`unset or invalid settings: ${missing.join(", ")}`, ...liveness];
	return [...localTimeoutViolations(createActivityCatalog(snapshot), bound), ...liveness];
};

/** Reads the settings, refuses to start on any problem, otherwise creates the Worker (not yet running). */
export const createControlWorker = async (options: ControlWorkerOptions): Promise<Worker> => {
	const snapshot = await options.settings.snapshot([...allTimeoutKeys(), ...LIVENESS_SETTING_KEYS]);
	const problems = controlSettingsProblems(snapshot);
	if (problems.length > 0) throw new Error(`Control Worker does not start: ${problems.join("; ")}`);
	// The machine-liveness Schedule is created, or updated in place, before the Worker is built (idempotent: one Schedule per id).
	await ensureMachineLivenessSchedule(options.client, snapshot);
	return Worker.create({
		connection: options.connection,
		...(options.namespace !== undefined ? { namespace: options.namespace } : {}),
		taskQueue: CONTROL_QUEUE,
		workflowsPath: options.workflowsPath ?? CONTROL_WORKFLOWS_PATH,
		activities: options.activities,
		enableNonLocalActivities: false,
	});
};
