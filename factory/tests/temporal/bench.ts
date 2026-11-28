// Test bench for workflow tests: one TestWorkflowEnvironment per test file, a Worker that runs only local activities
// (enableNonLocalActivities: false, D28) and bundles the workflow file the way the production worker does.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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

/**
 * sha256 (lowercase hex) of the server file the bench may use, per `<platform>-<arch>`. Source: temporalio/sdk-java release
 * 1.41.1, asset temporal-test-server_1.41.1_windows_amd64.zip, file temporal-test-server.exe. Install steps:
 * docs/agent-factory/testing.md, "Workflow test bench". Another platform gets its own pin when its file is first used.
 */
const PINNED_TEST_SERVER_SHA256: Readonly<Record<string, string>> = {
	"win32-x64": "36676b457046032de40307e23f2bcd372ae419d993928047a9f58c96e833f2f8",
};

export const pinnedTestServerSha256 = (platform: string = process.platform, arch: string = process.arch): string => {
	const pinned = PINNED_TEST_SERVER_SHA256[`${platform}-${arch}`];
	if (pinned === undefined) throw new Error(`no pinned sha256 for the workflow test server on ${platform}-${arch}; add its hash to PINNED_TEST_SERVER_SHA256 in factory/tests/temporal/bench.ts`);
	return pinned;
};

/** Refuses a server file whose sha256 is not `expected`; the message names the file and both hashes. */
export const checkTestServerSha256 = (path: string, expected: string): void => {
	const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
	if (actual !== expected) {
		throw new Error(`refusing the workflow test server ${path}: its sha256 is ${actual}, the pinned value is ${expected}. Replace it with temporal-test-server.exe from temporalio/sdk-java 1.41.1 (docs/agent-factory/testing.md, "Workflow test bench").`);
	}
};

export const startTimeSkipping = async (): Promise<TestWorkflowEnvironment> => {
	const path = localServerPath();
	// A file found in the cache dir or named by AF_TEMPORAL_TEST_SERVER is run as it is: it must be the pinned one first.
	if (path !== undefined) checkTestServerSha256(path, pinnedTestServerSha256());
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
