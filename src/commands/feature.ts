import type { FeatureManifest, Platform } from "../feature.js";
import type { Language } from "../messages.js";
import type { ApiResult, ProgressEvent } from "../output.js";
import type { Result } from "../result.js";
import type { RigState } from "../state.js";
import type { RuntimePorts } from "../ports.js";

import { applyRig } from "../apply.js";
import { resolveFeatureChange } from "../feature-graph.js";
import { isTranslatedLanguage, messagesFor } from "../messages.js";
import { apiFail, apiOk, PROGRESS_CODE_LOCK_WAITING, PROGRESS_CODE_PROGRAM_INSTALL, PROGRESS_CODE_SERVICE_STOPPING } from "../output.js";
import { err, ok } from "../result.js";
import { emitRigEvent, readFeatureManifests, readRigState, withRigLock } from "./shared.js";
import { installMissingPrograms } from "./programs.js";

// Failure codes of `rig feature`: the named ones are refusals a client can branch on, the rest is `feature-failed`.
export const FEATURE_ERROR_BASE_CANNOT_TOGGLE = "base-cannot-toggle";
export const FEATURE_ERROR_UNKNOWN = "unknown-feature";
export const FEATURE_ERROR_REFUSED = "feature-change-refused";
export const FEATURE_ERROR_SERVICE_NOT_STARTED = "service-not-started";
export const FEATURE_ERROR_FAILED = "feature-failed";

export type FeatureView = {
	name: string;
	description: string;
	enabled: boolean;
	platformAllowed: boolean;
};

export const listFeatureViews = async (runtime: RuntimePorts): Promise<Result<FeatureView[]>> => {
	const state = await readRigState(runtime);
	if (!state.ok) return state;
	const loaded = await readFeatureManifests(runtime, state.value.paths.repo);
	if (!loaded.ok) return loaded;
	return ok(loaded.value.filter((feature) => feature.name !== "base").map((feature) => toFeatureView(feature, state.value.features, runtime.platform, runtime.language)));
};

// `rig feature`: the list is `{"features": FeatureView[]}`.
export const featureListCommand = async (runtime: RuntimePorts): Promise<ApiResult<{ features: FeatureView[] }>> => {
	const views = await listFeatureViews(runtime);
	return views.ok ? apiOk({ features: views.value }) : apiFail(FEATURE_ERROR_FAILED, views.error);
};

// `rig feature <name> enable|disable`: the feature and the state it is in now.
export type FeatureChangeData = { feature: string; enabled: boolean };

export const changeFeature = async (
	runtime: RuntimePorts,
	name: string,
	action: "enable" | "disable",
	writeProgress: (event: ProgressEvent) => void,
): Promise<ApiResult<FeatureChangeData>> => {
	const preserveLock = name === "telegram" && action === "disable";
	const messages = messagesFor(runtime.language);
	// The code of the failure the operation returns; an error that passes through from state, apply or the lock has none.
	let failureCode = FEATURE_ERROR_FAILED;
	const refuse = (code: string, message: string): Result<never> => {
		failureCode = code;
		return err(message);
	};
	const result = await withRigLock(runtime, () => writeProgress({ code: PROGRESS_CODE_LOCK_WAITING }), async (): Promise<Result<FeatureChangeData>> => {
		const stateResult = await readRigState(runtime);
		if (!stateResult.ok) return stateResult;
		const state = stateResult.value;
		const loaded = await readFeatureManifests(runtime, state.paths.repo);
		if (!loaded.ok) return loaded;
		if (name === "base") return refuse(FEATURE_ERROR_BASE_CANNOT_TOGGLE, messages.feature.baseCannotToggle());
		const enabled = loaded.value.filter((feature) => feature.name === "base" || state.features[feature.name] === true).map((feature) => feature.name);
		const resolved = resolveFeatureChange({ messages, features: loaded.value, enabled, name, action, platform: runtime.platform });
		if (loaded.value.every((feature) => feature.name !== name)) return refuse(FEATURE_ERROR_UNKNOWN, messages.feature.unknown(name));
		if (!resolved.ok) return refuse(FEATURE_ERROR_REFUSED, resolved.error);
		const nextFeatures = { ...state.features, [name]: action === "enable" };
		const nextState = { ...state, features: nextFeatures };
		if (action === "enable") {
			const programs = await installMissingPrograms(runtime, loaded.value, new Set(resolved.value));
			if (!programs.ok) return programs;
			for (const missing of programs.value) writeProgress({ code: PROGRESS_CODE_PROGRAM_INSTALL, data: { name: missing.name, command: missing.command } });
		}
		const applied = await applyRig(runtime, { state: nextState, mode: "apply" });
		if (!applied.ok) return applied;
		if (name === "telegram" && action === "enable") {
			const started = await runtime.service.start();
			if (!started.ok) {
				failureCode = FEATURE_ERROR_SERVICE_NOT_STARTED;
				return revertFeatureChange(runtime, applied.value.state, state.features, messages.feature.serviceNotStarted(started.error));
			}
		}
		const changedText = messages.feature.changed(name, action === "enable");
		const event = await emitRigEvent(runtime, "features-changed", "info", changedText);
		if (!event.ok) return event;
		const data: FeatureChangeData = { feature: name, enabled: action === "enable" };
		if (preserveLock) {
			writeProgress({ code: PROGRESS_CODE_SERVICE_STOPPING });
			const stopped = await runtime.service.stop();
			return stopped.ok ? ok(data) : stopped;
		}
		return ok(data);
	}, preserveLock);
	return result.ok ? apiOk(result.value) : apiFail(failureCode, result.error);
};

const revertFeatureChange = async (
	runtime: RuntimePorts,
	appliedState: RigState,
	previousFeatures: RigState["features"],
	cause: string,
): Promise<Result<never>> => {
	const reverted = await applyRig(runtime, { state: { ...appliedState, features: previousFeatures }, mode: "apply" });
	if (!reverted.ok) return err(messagesFor(runtime.language).feature.revertFailed(cause, reverted.error));
	return err(cause);
};

const toFeatureView = (feature: FeatureManifest, enabled: Record<string, boolean>, platform: Platform, language: Language): FeatureView => ({
	name: feature.name,
	description: (isTranslatedLanguage(language) ? feature.translations?.[language]?.description : undefined) ?? feature.description,
	enabled: enabled[feature.name] === true,
	platformAllowed: feature.platforms.includes(platform),
});
