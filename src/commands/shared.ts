import type { FeatureManifest } from "../feature.js";
import type { RigState } from "../state.js";
import type { Result } from "../result.js";
import type { RuntimePorts } from "../ports.js";
import type { ProgressEvent } from "../output.js";

import { loadFeatures } from "../feature-graph.js";
import { acquireLock } from "../lock.js";
import { appendEvent } from "../events.js";
import { joinPath } from "../file-system.js";
import { messagesFor } from "../messages.js";
import { PROGRESS_CODE_LOCK_WAITING } from "../output.js";
import { readState } from "../state.js";
import { err, errorText, ok } from "../result.js";

export const readRigState = async (runtime: RuntimePorts): Promise<Result<RigState>> =>
	readState(runtime.fs, runtime.home, messagesFor(runtime.language));

export const readFeatureManifests = async (runtime: RuntimePorts, repoPath: string): Promise<Result<FeatureManifest[]>> =>
	loadFeatures(runtime.fs, repoPath, messagesFor(runtime.language));

export const emitRigEvent = async (
	runtime: RuntimePorts,
	type: string,
	level: "info" | "warn" | "error",
	text: string,
): Promise<Result<void>> => {
	const event = await appendEvent({
		fs: runtime.fs,
		home: runtime.home,
		now: () => runtime.clock.nowText(),
		createId: () => runtime.ids.next(),
		messages: messagesFor(runtime.language),
	}, { type, level, text });
	return event.ok ? ok(undefined) : event;
};

export const withRigLock = async <T>(
	runtime: RuntimePorts,
	writeProgress: (event: ProgressEvent) => void,
	operation: () => Promise<Result<T>>,
	keepLockForProcessExit = false,
): Promise<Result<T>> => {
	// Printed once, before a command waits for a lock that another rig process holds. The hub shows it as plain output.
	const acquired = await acquireLock(runtime.lock, (problem) => writeProgress(problem === undefined
		? { code: PROGRESS_CODE_LOCK_WAITING }
		: { code: PROGRESS_CODE_LOCK_WAITING, data: { pid: problem.pid, error: problem.error, message: messagesFor(runtime.language).lock.probeFailed(problem.pid, problem.error) } }));
	if (!acquired.ok) return acquired;
	let result: Result<T>;
	try {
		result = await operation();
	} catch (error) {
		result = err(messagesFor(runtime.language).failure.unexpectedFailure(errorText(error)));
	}
	if (keepLockForProcessExit && result.ok) return result;
	const released = await acquired.value.release();
	return released.ok ? result : released;
};

export const stateWithFeatureDefaults = (
	state: RigState,
	features: readonly FeatureManifest[],
	platform: RuntimePorts["platform"],
): RigState => {
	const nextFeatures: Record<string, boolean> = {};
	for (const feature of features) {
		if (feature.name !== "base") nextFeatures[feature.name] = feature.enabledByDefault && feature.platforms.includes(platform);
	}
	return { ...state, features: nextFeatures };
};

export const serializeRecord = (value: unknown): string => JSON.stringify(value);
export const pathJoin = joinPath;
