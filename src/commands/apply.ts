import type { PluginChanges } from "../apply.js";
import type { ApiResult, ProgressEvent } from "../output.js";
import type { RuntimePorts } from "../ports.js";

import { applyRig } from "../apply.js";
import { apiFail, apiOk, PROGRESS_CODE_LOCK_WAITING } from "../output.js";
import { readRigState, withRigLock } from "./shared.js";

// Failure code of `rig apply`; the message is the text of whatever step failed.
export const APPLY_ERROR_FAILED = "apply-failed";

// What apply changed: absolute paths of the files it wrote or removed, and the plugin and marketplace actions it ran.
export type ApplyData = { changedFiles: string[]; pluginChanges: PluginChanges };

export const applyCommand = async (
	runtime: RuntimePorts,
	writeProgress: (event: ProgressEvent) => void,
): Promise<ApiResult<ApplyData>> => {
	const result = await withRigLock(runtime, () => writeProgress({ code: PROGRESS_CODE_LOCK_WAITING }), async () => {
		const state = await readRigState(runtime);
		if (!state.ok) return state;
		return applyRig(runtime, { state: state.value, mode: "apply" });
	});
	if (!result.ok) return apiFail(APPLY_ERROR_FAILED, result.error);
	const { changedFiles, pluginChanges } = result.value;
	return apiOk({ changedFiles, pluginChanges });
};
