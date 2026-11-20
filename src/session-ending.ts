import type { ApiResult } from "./output.js";
import type { RuntimePorts } from "./ports.js";

import { atomicWrite, joinPath } from "./file-system.js";
import { acquireLock } from "./lock.js";
import { messagesFor } from "./messages.js";
import { apiFail, apiOk, SESSION_ENDING, SESSION_IO } from "./output.js";
import { errorText } from "./result.js";

type Owner = { pid: number; pidCreated: string; token: string };
type Marker = Owner & { takenOver: boolean; otherOwners: Owner[] };
export type SessionEnding = {
	takenOver(): Promise<ApiResult<boolean>>;
	// Authorizes and initiates a side effect atomically with takeover. A returned promise is awaited outside the guard.
	start<T>(action: () => T): Promise<ApiResult<T>>;
	// Keep the guard until the action finishes, so takeover cannot interrupt it.
	exclusive<T>(action: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>;
};

const markerPath = (runtime: RuntimePorts, id: string): string => joinPath(runtime.home, ".agent-rig", "sessions", id, "ending.json");
const io = (runtime: RuntimePorts, error: string): ApiResult<never> => apiFail(SESSION_IO, messagesFor(runtime.language).session.io(error));
const missing = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const parseOwner = (value: unknown): Owner | null => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	if (!("pid" in value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
	if (!("pidCreated" in value) || typeof value.pidCreated !== "string" || value.pidCreated === "") return null;
	if (!("token" in value) || typeof value.token !== "string" || value.token === "") return null;
	return { pid: value.pid, pidCreated: value.pidCreated, token: value.token };
};
const parseMarker = (text: string): Marker | null => {
	let value: unknown;
	try { value = JSON.parse(text); } catch { return null; }
	const owner = parseOwner(value);
	if (owner === null || typeof value !== "object" || value === null) return null;
	if (!("takenOver" in value) || typeof value.takenOver !== "boolean") return null;
	const otherOwners: Owner[] = [];
	if ("otherOwners" in value) {
		if (!Array.isArray(value.otherOwners)) return null;
		const entries: readonly unknown[] = value.otherOwners;
		for (const entry of entries) {
			const other = parseOwner(entry);
			if (other === null) return null;
			otherOwners.push(other);
		}
	}
	return { ...owner, takenOver: value.takenOver, otherOwners };
};

const readMarker = async (runtime: RuntimePorts, path: string): Promise<ApiResult<Marker | null>> => {
	try {
		const marker = parseMarker(await runtime.fs.readText(path));
		return marker === null ? io(runtime, messagesFor(runtime.language).failure.lockMalformed()) : apiOk(marker);
	} catch (error) { return missing(error) ? apiOk(null) : io(runtime, errorText(error)); }
};

export const sessionEndingLive = async (runtime: RuntimePorts, id: string): Promise<ApiResult<boolean>> => {
	const marker = await readMarker(runtime, markerPath(runtime, id));
	if (!marker.ok) return marker;
	if (marker.value === null) return apiOk(false);
	const owners = [marker.value, ...marker.value.otherOwners];
	const created = await runtime.process.createdAt([...new Set(owners.map((owner) => owner.pid))]);
	if (!created.ok) return io(runtime, created.error);
	if (owners.some((owner) => created.value[String(owner.pid)] === undefined)) return io(runtime, messagesFor(runtime.language).failure.processTableIncomplete());
	return apiOk(owners.some((owner) => created.value[String(owner.pid)] === owner.pidCreated));
};

// Reuse rig's lock only around marker transitions, including stale-owner removal. Two contenders must never
// both delete a stale marker: the second could otherwise delete the first contender's new, live ownership.
const guarded = async <T>(runtime: RuntimePorts, path: string, action: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> => {
	const locked = await acquireLock({ ...runtime.lock, lockPath: `${path}.lock`, messages: messagesFor(runtime.language) }, () => {});
	if (!locked.ok) return io(runtime, locked.error);
	let result: ApiResult<T>;
	try { result = await action(); } catch (error) { result = io(runtime, errorText(error)); }
	const released = await locked.value.release();
	return !released.ok && result.ok ? io(runtime, released.error) : result;
};

type Entered = { marker: Marker; interrupted: boolean };

// Only stop may interrupt a live owner. All still-running operations retain an ownership token, so completion
// of either the interrupted operation or its interrupting stop cannot release the other's marker prematurely.
export const withSessionEnding = async <T>(runtime: RuntimePorts, id: string, action: (ending: SessionEnding) => Promise<ApiResult<T>>, onBusy?: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> => {
	const path = markerPath(runtime, id);
	try { await runtime.fs.ensureDirectory(joinPath(runtime.home, ".agent-rig", "sessions", id)); }
	catch (error) { return io(runtime, errorText(error)); }
	const entered = await guarded<Entered>(runtime, path, async () => {
		const existing = await readMarker(runtime, path);
		if (!existing.ok) return existing;
		const pid = runtime.lock.process.pid;
		const owners = existing.value === null ? [] : [existing.value, ...existing.value.otherOwners];
		const created = await runtime.process.createdAt([...new Set([pid, ...owners.map((owner) => owner.pid)])]);
		if (!created.ok) return io(runtime, created.error);
		if (owners.some((owner) => created.value[String(owner.pid)] === undefined)) return io(runtime, messagesFor(runtime.language).failure.processTableIncomplete());
		const otherOwners = owners.filter((owner) => created.value[String(owner.pid)] === owner.pidCreated).map(({ pid, pidCreated, token }) => ({ pid, pidCreated, token }));
		const interrupted = otherOwners.length > 0;
		if (interrupted && onBusy === undefined) return apiFail(SESSION_ENDING, messagesFor(runtime.language).session.ending());
		const pidCreated = created.value[String(pid)];
		if (pidCreated === undefined || pidCreated === null || pidCreated === "") return io(runtime, messagesFor(runtime.language).runtime.processNotFound());
		const marker: Marker = { pid, pidCreated, token: runtime.fs.uniqueSuffix(), takenOver: interrupted, otherOwners };
		if (interrupted) {
			const recorded = await atomicWrite(runtime.fs, path, JSON.stringify(marker), messagesFor(runtime.language));
			return recorded.ok ? apiOk({ marker, interrupted }) : io(runtime, recorded.error);
		}
		if (existing.value !== null) await runtime.fs.remove(path);
		const written = await runtime.fs.writeExclusive(path, JSON.stringify(marker));
		if (!written.ok) return io(runtime, written.error);
		return written.value ? apiOk({ marker, interrupted }) : apiFail(SESSION_ENDING, messagesFor(runtime.language).session.ending());
	});
	if (!entered.ok) return entered;
	const marker = entered.value.marker;
	const takenOver = async (): Promise<ApiResult<boolean>> => {
		const current = await readMarker(runtime, path);
		return current.ok ? apiOk(current.value === null || current.value.token !== marker.token || current.value.takenOver) : current;
	};
	const ending: SessionEnding = {
		takenOver: () => guarded(runtime, path, takenOver),
		start: (start) => guarded(runtime, path, async () => {
			const interrupted = await takenOver();
			if (!interrupted.ok) return interrupted;
			return interrupted.value ? apiFail(SESSION_ENDING, messagesFor(runtime.language).session.ending()) : apiOk(start());
		}),
		exclusive: (action) => guarded(runtime, path, async () => {
			const interrupted = await takenOver();
			if (!interrupted.ok) return interrupted;
			return interrupted.value ? apiFail(SESSION_ENDING, messagesFor(runtime.language).session.ending()) : await action();
		}),
	};
	let result: ApiResult<T>;
	try { result = entered.value.interrupted && onBusy !== undefined ? await onBusy() : await action(ending); }
	catch (error) { result = io(runtime, errorText(error)); }
	const released = await guarded(runtime, path, async () => {
		const current = await readMarker(runtime, path);
		if (!current.ok) return current;
		if (current.value === null) return apiOk(null);
		const owners = [current.value, ...current.value.otherOwners];
		const remaining = owners.filter((owner) => owner.token !== marker.token);
		if (remaining.length === owners.length) return apiOk(null);
		const [owner, ...otherOwners] = remaining;
		if (owner === undefined) await runtime.fs.remove(path);
		else {
			const recorded = await atomicWrite(runtime.fs, path, JSON.stringify({ pid: owner.pid, pidCreated: owner.pidCreated, token: owner.token, takenOver: current.value.takenOver, otherOwners }), messagesFor(runtime.language));
			if (!recorded.ok) return io(runtime, recorded.error);
		}
		return apiOk(null);
	});
	return !released.ok && result.ok ? released : result;
};
