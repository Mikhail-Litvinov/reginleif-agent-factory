import type { ApiResult, ProgressEvent } from "../output.js";
import type { RuntimePorts } from "../ports.js";
import type { SessionRecord } from "../session-core.js";

import { apiFail, apiOk, PROGRESS_CODE_SESSION_COMPACTING, PROGRESS_CODE_SESSION_TERMINATING, SESSION_CLEANUP_NOT_COMPACTED, SESSION_ENDED, SESSION_IO, SESSION_UNKNOWN } from "../output.js";
import { messagesFor } from "../messages.js";
import { compactSessionCore, lookupSession, sessionLive } from "../session-core.js";
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
	const current = await lookupSession(runtime, session.id);
	if (!current.ok) return current.error.code === SESSION_UNKNOWN ? apiFail(SESSION_ENDED, messagesFor(runtime.language).session.ended()) : current;
	const stopped = await endSession(runtime, current.value);
	if (!stopped.ok) return stopped;
	if (!stopped.value) return apiFail(SESSION_ENDED, messagesFor(runtime.language).session.ended());
	if (session.transcriptPath === null || session.transcriptPath.replaceAll("\\", "/").split("/").at(-1) !== `${session.id}.jsonl`) return apiFail(SESSION_IO, messagesFor(runtime.language).session.io(messagesFor(runtime.language).session.transcriptPath()));
	const path = session.transcriptPath;
	const cleaned = await cleanTranscript(runtime, path);
	if (!cleaned.ok) return apiFail(SESSION_IO, cleaned.error);
	return apiOk({ session: session.id, compacted: compact.value, ...cleaned.value });
});
