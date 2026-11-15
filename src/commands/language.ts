import type { Language } from "../messages.js";
import type { ApiResult, ProgressEvent } from "../output.js";
import type { Result } from "../result.js";
import type { RuntimePorts } from "../ports.js";

import { applyRig } from "../apply.js";
import { DEFAULT_LANGUAGE, messagesFor } from "../messages.js";
import { apiFail, apiOk, PROGRESS_CODE_LOCK_WAITING } from "../output.js";
import { err, ok } from "../result.js";
import { readStateReport, writeState } from "../state.js";
import { emitRigEvent, withRigLock } from "./shared.js";

export const LANGUAGE_EVENT_TYPE = "language-changed";

// Failure codes of `rig language`: without state.json rig is not installed; the rest is `language-failed`.
export const LANGUAGE_ERROR_NOT_INSTALLED = "not-installed";
export const LANGUAGE_ERROR_FAILED = "language-failed";

// `rig language` shows the language in effect; `rig language en|ru` also says whether it changed it.
export type LanguageData = { language: Language };
export type LanguageChangeData = { language: Language; changed: boolean };

// The text of the `language-changed` event, in the language that was set: an event record is rig-language text, not command output.
const eventText = (language: Language): string => {
	const messages = messagesFor(language);
	return messages.language.line(messages.languageNames[language]);
};

// `rig language`: the language in effect, `{"language":"en"}`. Without state.json rig is not installed and there is no
// setting to show.
export const showLanguage = async (runtime: RuntimePorts): Promise<ApiResult<LanguageData>> => {
	const stored = await readStateReport(runtime.fs, runtime.home, messagesFor(runtime.language));
	if (!stored.ok) return apiFail(LANGUAGE_ERROR_FAILED, stored.error);
	if (stored.value === null) return apiFail(LANGUAGE_ERROR_NOT_INSTALLED, messagesFor(runtime.language).language.notInstalled());
	return apiOk({ language: runtime.language });
};

// `rig language en|ru`: under the rig lock, writes the language to state.json and records an event in the NEW
// language; answers `{"language", "changed"}`. Setting the language that is already in force changes and emits nothing
// (`changed: false`), except that an unsupported value in state.json (read as English everywhere) is replaced by a valid
// one: repair, without an event.
export const setLanguage = async (
	runtime: RuntimePorts,
	language: Language,
	writeProgress: (event: ProgressEvent) => void,
): Promise<ApiResult<LanguageChangeData>> => {
	let failureCode = LANGUAGE_ERROR_FAILED;
	const result = await withRigLock(runtime, () => writeProgress({ code: PROGRESS_CODE_LOCK_WAITING }), async (): Promise<Result<LanguageChangeData>> => {
		const stored = await readStateReport(runtime.fs, runtime.home, messagesFor(runtime.language));
		if (!stored.ok) return stored;
		if (stored.value === null) {
			failureCode = LANGUAGE_ERROR_NOT_INSTALLED;
			return err(messagesFor(runtime.language).language.notInstalled());
		}
		const { state, languageInvalid } = stored.value;
		const changed = (state.language ?? DEFAULT_LANGUAGE) !== language;
		if (changed || languageInvalid) {
			const written = await writeState(runtime.fs, runtime.home, { ...state, language }, messagesFor(runtime.language));
			if (!written.ok) return written;
		}
		if (changed) {
			const event = await emitRigEvent(runtime, LANGUAGE_EVENT_TYPE, "info", eventText(language));
			if (!event.ok) return event;
			// Rig's own hook entries in settings.json carry their status message in the language, so the normal apply runs
			// again with the new one. A message the user edited by hand follows the ownership rules there.
			const applied = await applyRig({ ...runtime, language }, { state: { ...state, language }, mode: "apply" });
			if (!applied.ok) return applied;
		}
		return ok({ language, changed });
	});
	return result.ok ? apiOk(result.value) : apiFail(failureCode, result.error);
};
