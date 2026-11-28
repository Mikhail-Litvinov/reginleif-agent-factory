// Test bench for workflow tests: one TestWorkflowEnvironment per test file, a Worker that runs only local activities
// (enableNonLocalActivities: false, D28) and bundles the workflow file the way the production worker does.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, type WorkerOptions } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";

/**
 * Where the time-skipping test server binary is cached. The SDK default is the system temp dir (here the project
 * `.tmp`, swept after 3 days) with a 1 day ttl, so the binary would be fetched from temporal.download again. A stable
 * dir and a ttl longer than any plausible gap make the run offline after the first fetch. Override: AF_TEMPORAL_TEST_CACHE.
 */
export const temporalTestCacheDir = (): string => process.env.AF_TEMPORAL_TEST_CACHE ?? join(homedir(), ".agent-factory", "temporal-test-server");
// 3650 days: "never expires"; the file is replaced only by deleting it or by a new SDK version (the version is in the file name).
const CACHE_TTL = "3650 days";

/**
 * The SDK downloads the server from temporal.download, which resets connections on this machine (measured: ConnectionReset
 * on three retries, 80 s). The same binary is published on GitHub (temporalio/sdk-java releases, asset
 * temporal-test-server_<ver>_<os>_<arch>). When `temporal-test-server[.exe]` lies in the cache dir (or AF_TEMPORAL_TEST_SERVER
 * points at one) it is used by path and nothing is downloaded; otherwise the SDK's cached download runs.
 */
const localServerPath = (): string | undefined => {
	const candidates = [process.env.AF_TEMPORAL_TEST_SERVER, join(temporalTestCacheDir(), process.platform === "win32" ? "temporal-test-server.exe" : "temporal-test-server")];
	return candidates.find((path): path is string => path !== undefined && existsSync(path));
};

export const startTimeSkipping = (): Promise<TestWorkflowEnvironment> => {
	const path = localServerPath();
	return TestWorkflowEnvironment.createTimeSkipping({
		server: { executable: path !== undefined ? { type: "existing-path", path } : { type: "cached-download", downloadDir: temporalTestCacheDir(), ttl: CACHE_TTL } },
	});
};

/** Absolute path with forward slashes: what the Worker needs on Windows (modules.md, Phase 4 note). */
export const workflowsPathOf = (fileUrl: string): string => fileURLToPath(fileUrl).replaceAll("\\", "/");

export interface BenchWorkerOptions {
	readonly env: TestWorkflowEnvironment;
	readonly workflowsPath: string;
	readonly activities: NonNullable<WorkerOptions["activities"]>;
	readonly taskQueue: string;
}

/** Runs `body` while a local-activity-only Worker polls `taskQueue`; the Worker is shut down in every case. */
export const withWorker = async <T>({ env, workflowsPath, activities, taskQueue }: BenchWorkerOptions, body: () => Promise<T>): Promise<T> => {
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowsPath,
		activities,
		enableNonLocalActivities: false,
	});
	return worker.runUntil(body());
};
