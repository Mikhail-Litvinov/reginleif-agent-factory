import type { Args, Op, Request, Response } from "../plugins/agent-rig-window/mod/queue-protocol.js";
import type { ApiResult, ProgressEvent } from "./output.js";
import type { RuntimePorts } from "./ports.js";

import { ID_PATTERN, REQUEST_SUFFIX } from "../plugins/agent-rig-window/mod/queue-protocol.js";
import { joinPath } from "./file-system.js";
import { messagesFor } from "./messages.js";
import { apiFail, apiOk, PROGRESS_CODE_SESSION_WAITING, SESSION_BAD_ID, SESSION_BAD_RESPONSE, SESSION_ENDED, SESSION_INVALID, SESSION_IO, SESSION_MODULE_ERROR, SESSION_NO_MODULE, SESSION_TIMEOUT, SESSION_UNKNOWN } from "./output.js";
import { errorText } from "./result.js";

// The window polls once per second; allow three polls for read-only operations.
export const SESSION_POLL_MS = 1000;
export const READ_TIMEOUT_MS = 3 * SESSION_POLL_MS;
// Hub CLEANUP_COMPACT_MS (plugin/src/hub/hub.ts:87); rename also waits for the turn to end.
export const COMPACT_TIMEOUT_MS = 10 * 60 * SESSION_POLL_MS;
export const RENAME_TIMEOUT_MS = COMPACT_TIMEOUT_MS;
// Like rename: the command waits for the turn to end, so it gets the same allowance.
export const AUTOCOMPACT_TIMEOUT_MS = COMPACT_TIMEOUT_MS;
export const SESSION_TIMEOUTS: Record<Op, number> = { compact: COMPACT_TIMEOUT_MS, rename: RENAME_TIMEOUT_MS, autocompact: AUTOCOMPACT_TIMEOUT_MS, usage: READ_TIMEOUT_MS, mode: READ_TIMEOUT_MS };

export type SessionRecord = { id: string; cwd: string | null; transcriptPath: string | null; pid: number | null; pidCreated: string | null; startedAt: string; endedAt: string | null };
export type SessionSummary = { id: string; cwd: string | null; transcriptPath: string | null; pid: number | null; startedAt: string; live: boolean; module: boolean };
export type SessionListEntry = SessionSummary | { id: string; error: { code: string; message: string } };
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nullableString = (v: unknown): v is string | null => v === null || typeof v === "string";
const missing = (e: unknown): boolean => object(e) && (e.code === "ENOENT" || e.code === "ENOTDIR");
const root = (r: RuntimePorts): string => joinPath(r.home, ".agent-rig", "sessions");
const folder = (r: RuntimePorts, id: string): string => joinPath(root(r), id);

export const lookupSession = async (r: RuntimePorts, id: string): Promise<ApiResult<SessionRecord>> => {
	const m = messagesFor(r.language).session;
	if (!ID_PATTERN.test(id)) return apiFail(SESSION_BAD_ID, m.badId(id));
	let value: unknown;
	try { value = JSON.parse(await r.fs.readText(joinPath(root(r), `${id}.json`))); }
	catch (e) { return missing(e) ? apiFail(SESSION_UNKNOWN, m.unknown(id)) : e instanceof SyntaxError ? apiFail(SESSION_INVALID, m.invalid(id)) : apiFail(SESSION_IO, m.io(errorText(e))); }
	if (!object(value) || value.session_id !== id || !nullableString(value.cwd) || !nullableString(value.transcript_path) || !(value.pid === null || (typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0)) || !nullableString(value.pid_created) || typeof value.started_at !== "string" || !nullableString(value.ended_at)) return apiFail(SESSION_INVALID, m.invalid(id));
	return apiOk({ id, cwd: value.cwd, transcriptPath: value.transcript_path, pid: value.pid, pidCreated: value.pid_created, startedAt: value.started_at, endedAt: value.ended_at });
};

export const sessionLive = async (r: RuntimePorts, session: SessionRecord): Promise<ApiResult<boolean>> => {
	if (session.endedAt !== null || session.pid === null || session.pidCreated === null) return apiOk(false);
	const created = await r.process.createdAt([session.pid]);
	return created.ok ? apiOk(created.value[String(session.pid)] === session.pidCreated) : apiFail(SESSION_IO, messagesFor(r.language).session.io(created.error));
};

export const lookupSessionForCommand = async (r: RuntimePorts, id: string, requireLive: boolean): Promise<ApiResult<SessionRecord>> => {
	const session = await lookupSession(r, id);
	if (!session.ok || !requireLive) return session;
	const live = await sessionLive(r, session.value);
	if (!live.ok) return live;
	return live.value ? session : apiFail(SESSION_ENDED, messagesFor(r.language).session.ended());
};

export type CompactOutcome = { tokensBefore: number; tokensAfter: number } | { skip: string };

export const compactSessionCore = async (r: RuntimePorts, session: SessionRecord, instructions: string | undefined, progress: (event: ProgressEvent) => void): Promise<ApiResult<CompactOutcome>> => {
	const result = await requestSession(r, session, "compact", instructions === undefined ? {} : { instructions }, SESSION_TIMEOUTS.compact, progress);
	if (!result.ok) return result;
	const value = result.value;
	if (object(value) && typeof value.skip === "string") return apiOk({ skip: value.skip });
	if (object(value) && typeof value.tokensBefore === "number" && Number.isFinite(value.tokensBefore) && typeof value.tokensAfter === "number" && Number.isFinite(value.tokensAfter)) return apiOk({ tokensBefore: value.tokensBefore, tokensAfter: value.tokensAfter });
	return apiFail(SESSION_BAD_RESPONSE, messagesFor(r.language).session.badResponse());
};

export const sessionModule = async (r: RuntimePorts, session: SessionRecord): Promise<ApiResult<boolean>> => {
	try { await r.fs.listDirectory(folder(r, session.id)); return apiOk(true); }
	catch (e) { return missing(e) ? apiOk(false) : apiFail(SESSION_IO, messagesFor(r.language).session.io(errorText(e))); }
};

export const listSessions = async (r: RuntimePorts): Promise<ApiResult<{ sessions: SessionListEntry[] }>> => {
	let entries;
	try { entries = await r.fs.listDirectory(root(r)); }
	catch (e) { return missing(e) ? apiOk({ sessions: [] }) : apiFail(SESSION_IO, messagesFor(r.language).session.io(errorText(e))); }
	const sessions: SessionListEntry[] = [];
	const records: SessionRecord[] = [];
	for (const entry of entries) {
		if (entry.directory || !entry.name.endsWith(REQUEST_SUFFIX)) continue;
		const id = entry.name.slice(0, -REQUEST_SUFFIX.length);
		const record = await lookupSession(r, id);
		if (!record.ok) { sessions.push({ id, error: record.error }); continue; }
		records.push(record.value);
	}
	const pids = [...new Set(records.filter((record) => record.endedAt === null && record.pidCreated !== null && record.pid !== null).map((record) => record.pid).filter((pid): pid is number => pid !== null))];
	const created = pids.length === 0 ? null : await r.process.createdAt(pids);
	for (const record of records) {
		const { id, cwd, transcriptPath, pid, startedAt } = record;
		if (record.endedAt === null && pid !== null && record.pidCreated !== null && created !== null && !created.ok) {
			sessions.push({ id, error: { code: SESSION_IO, message: messagesFor(r.language).session.io(created.error) } });
			continue;
		}
		const module = await sessionModule(r, record);
		if (!module.ok) { sessions.push({ id, error: module.error }); continue; }
		const live = record.endedAt === null && pid !== null && record.pidCreated !== null && created !== null && created.ok && created.value[String(pid)] === record.pidCreated;
		sessions.push({ id, cwd, transcriptPath, pid, startedAt, live, module: module.value });
	}
	sessions.sort((a, b) => ("startedAt" in b ? b.startedAt : "").localeCompare("startedAt" in a ? a.startedAt : ""));
	return apiOk({ sessions });
};

export const requestSession = async (r: RuntimePorts, session: SessionRecord, op: Op, args: Args, timeout: number, progress: (event: ProgressEvent) => void = () => {}): Promise<ApiResult<unknown>> => {
	const m = messagesFor(r.language).session;
	if (!ID_PATTERN.test(session.id)) return apiFail(SESSION_BAD_ID, m.badId(session.id));
	const module = await sessionModule(r, session);
	if (!module.ok) return module;
	if (!module.value) return apiFail(SESSION_NO_MODULE, m.noModule());
	const initialLive = await sessionLive(r, session);
	if (!initialLive.ok) return initialLive;
	if (!initialLive.value) return apiFail(SESSION_ENDED, m.ended());
	const id = r.ids.next();
	if (!ID_PATTERN.test(id)) return apiFail(SESSION_IO, m.io("Invalid generated request id"));
	const requests = joinPath(folder(r, session.id), "requests");
	const responses = joinPath(folder(r, session.id), "responses");
	const path = joinPath(requests, `${id}${REQUEST_SUFFIX}`);
	const temp = joinPath(requests, `${id}.tmp`);
	const responsePath = joinPath(responses, `${id}${REQUEST_SUFFIX}`);
	const body: Request = { id, op, args };
	let published = false;
	try {
		await r.fs.ensureDirectory(requests);
		await r.fs.ensureDirectory(responses);
		await r.fs.writeText(temp, JSON.stringify(body));
		await r.fs.rename(temp, path);
		published = true;
		const deadline = r.clock.now().getTime() + timeout;
		let malformed = false;
		let notified = false;
		for (;;) {
			if (!notified && r.clock.now().getTime() - (deadline - timeout) >= SESSION_POLL_MS) { progress({ code: PROGRESS_CODE_SESSION_WAITING }); notified = true; }
			let text: string | null = null;
			try { text = await r.fs.readText(responsePath); } catch (e) { if (!missing(e)) throw e; }
			if (text !== null) {
				let value: unknown;
				try { value = JSON.parse(text); } catch { value = null; }
				if (object(value) && value.id === id && ((value.ok === true && "result" in value) || (value.ok === false && typeof value.error === "string"))) {
					const response: Response = value.ok === true ? { id, ok: true, result: value.result } : { id, ok: false, error: typeof value.error === "string" ? value.error : "" };
					await r.fs.remove(responsePath);
					return response.ok ? apiOk(response.result) : apiFail(SESSION_MODULE_ERROR, response.error);
				}
				if (malformed) return apiFail(SESSION_BAD_RESPONSE, m.badResponse());
				malformed = true;
			}
			const current = await lookupSession(r, session.id);
			if (!current.ok) return current;
			if (current.value.endedAt !== null) return apiFail(SESSION_ENDED, m.ended());
			const remaining = deadline - r.clock.now().getTime();
			if (remaining <= 0) {
				const live = await sessionLive(r, current.value);
				if (!live.ok) return live;
				return live.value ? apiFail(SESSION_TIMEOUT, m.timeout()) : apiFail(SESSION_ENDED, m.ended());
			}
			await r.clock.sleep(Math.min(SESSION_POLL_MS, remaining));
		}
	} catch (e) { return apiFail(SESSION_IO, m.io(errorText(e))); }
	finally {
		for (const candidate of published ? [path] : [temp]) {
			try { await r.fs.remove(candidate); } catch (e) { if (!missing(e)) throw e; }
		}
	}
};
