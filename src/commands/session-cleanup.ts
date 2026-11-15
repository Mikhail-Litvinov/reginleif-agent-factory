import type { ApiResult, ProgressEvent } from "../output.js";
import type { RuntimePorts } from "../ports.js";
import type { SessionRecord } from "../session-core.js";

import { apiFail, apiOk, SESSION_CLEANUP_NOT_COMPACTED, SESSION_IO } from "../output.js";
import { messagesFor } from "../messages.js";
import { compactSessionCore } from "../session-core.js";
import { endSession } from "./session-stop.js";
import { cleanTranscript } from "./session-transcript.js";

export const cleanupSession = async (runtime: RuntimePorts, session: SessionRecord, progress: (event: ProgressEvent) => void): Promise<ApiResult<{ session: string; compacted: { tokensBefore: number; tokensAfter: number }; backup: string; skillsRemoved: number }>> => {
	const compact = await compactSessionCore(runtime, session, undefined, progress);
	if (!compact.ok) return compact;
	if (!("tokensBefore" in compact.value) || compact.value.tokensAfter >= compact.value.tokensBefore) return apiFail(SESSION_CLEANUP_NOT_COMPACTED, messagesFor(runtime.language).session.cleanupNotCompacted());
	const stopped = await endSession(runtime, session);
	if (!stopped.ok) return stopped;
	if (session.transcriptPath === null || session.transcriptPath.replaceAll("\\", "/").split("/").at(-1) !== `${session.id}.jsonl`) return apiFail(SESSION_IO, messagesFor(runtime.language).session.io(messagesFor(runtime.language).session.transcriptPath()));
	const cleaned = await cleanTranscript(runtime, session.transcriptPath);
	if (!cleaned.ok) return apiFail(SESSION_IO, cleaned.error);
	return apiOk({ session: session.id, compacted: compact.value, ...cleaned.value });
};
