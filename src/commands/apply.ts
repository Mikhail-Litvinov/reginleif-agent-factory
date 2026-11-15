import type { Result } from "../result.js";
import type { RuntimePorts } from "../ports.js";

import { applyRig } from "../apply.js";
import { messagesFor } from "../messages.js";
import { ok } from "../result.js";
import { readRigState, withRigLock } from "./shared.js";

export const applyCommand = async (runtime: RuntimePorts, writeLine: (line: string) => void): Promise<Result<void>> =>
	withRigLock(runtime, writeLine, async () => {
		const state = await readRigState(runtime);
		if (!state.ok) return state;
		const applied = await applyRig(runtime, { state: state.value, mode: "apply" });
		if (!applied.ok) return applied;
		const messages = messagesFor(runtime.language);
		const { changedFiles, pluginChanges } = applied.value;
		if (changedFiles.length === 0 && pluginChanges === 0) writeLine(messages.apply.upToDate());
		if (changedFiles.length > 0) writeLine(messages.apply.updatedFiles(changedFiles.length));
		if (pluginChanges > 0) writeLine(messages.apply.updatedPlugins(pluginChanges));
		return ok(undefined);
	});
