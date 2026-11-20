import type { ApiResult, ProgressEvent } from "../output.js";
import type { RuntimePorts } from "../ports.js";
import type { SessionRecord } from "../session-core.js";

import { apiFail, apiOk, PROGRESS_CODE_SESSION_COMPACTING, PROGRESS_CODE_SESSION_TERMINATING, SESSION_CLEANUP_NOT_COMPACTED, SESSION_ENDED, SESSION_IO } from "../output.js";
import { messagesFor } from "../messages.js";
import { compactSessionCore, sessionLive } from "../session-core.js";
import { withSessionEnding } from "../session-ending.js";
import { endSession } from "./session-stop.js";
import { cleanTranscript } from "./session-transcript.js";

export const cleanupSession = (runtime: RuntimePorts, session: SessionRecord, progress: (event: ProgressEvent) => void): Promise<ApiResult<{ session: string; compacted: { tokensBefore: number; tokensAfter: number }; backup: string; skillsRemoved: number }>> => withSessionEnding(runtime, session.id, async (ending) => {
	const live = await sessionLive(runtime, session);
	if (!live.ok) return live;
	if (!live.value) return apiFail(SESSION_ENDED, messagesFor(runtime.language).session.ended());
	progress({ code: PROGRESS_CODE_SESSION_COMPACTING });
	const compact = await compactSessionCore(runtime, session, undefined, progress);
	if (!compact.ok) return compact;
	const takenOver = await ending.takenOver();
	if (!takenOver.ok) return takenOver;
	if (takenOver.value) return apiFail(SESSION_ENDED, messagesFor(runtime.language).session.ended());
	if (!("tokensBefore" in compact.value) || compact.value.tokensAfter >= compact.value.tokensBefore) return apiFail(SESSION_CLEANUP_NOT_COMPACTED, messagesFor(runtime.language).session.cleanupNotCompacted());
	progress({ code: PROGRESS_CODE_SESSION_TERMINATING });
	const stopped = await endSession(runtime, session);
	if (!stopped.ok) return stopped;
	const stoppedUnderneath = await ending.takenOver();
	if (!stoppedUnderneath.ok) return stoppedUnderneath;
	if (stoppedUnderneath.value) return apiFail(SESSION_ENDED, messagesFor(runtime.language).session.ended());
	if (session.transcriptPath === null || session.transcriptPath.replaceAll("\\", "/").split("/").at(-1) !== `${session.id}.jsonl`) return apiFail(SESSION_IO, messagesFor(runtime.language).session.io(messagesFor(runtime.language).session.transcriptPath()));
	const cleaned = await cleanTranscript(runtime, session.transcriptPath);
	if (!cleaned.ok) return apiFail(SESSION_IO, cleaned.error);
	return apiOk({ session: session.id, compacted: compact.value, ...cleaned.value });
});
