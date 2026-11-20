import type { ApiResult } from "./output.js";
import type { RuntimePorts } from "./ports.js";

import { atomicWrite, joinPath } from "./file-system.js";
import { acquireLock } from "./lock.js";
import { messagesFor } from "./messages.js";
import { apiFail, apiOk, SESSION_ENDING, SESSION_IO } from "./output.js";
import { errorText, ok } from "./result.js";

type Launch = { startedAt: number; registrationWaitMs: number };
type Owner = { pid: number; pidCreated: string; token: string; launch: Launch | null };
type Marker = Owner & { takenOver: boolean; otherOwners: Owner[] };
type EndingObservation = { created: Record<string, string | null>; waiting: boolean; registrationRemainingMs: number | null };
type ObserveEnding = (pids: readonly number[]) => Promise<ApiResult<EndingObservation>>;
export type SessionEnding = {
	takenOver(): Promise<ApiResult<boolean>>;
	// Records pending registration and starts a launch atomically with takeover; its promise is awaited outside the guard.
	startLaunch<T>(action: () => T, registrationWaitMs: number): Promise<ApiResult<T>>;
};

const markerPath = (runtime: RuntimePorts, id: string): string => joinPath(runtime.home, ".agent-rig", "sessions", id, "ending.json");
const io = (runtime: RuntimePorts, error: string): ApiResult<never> => apiFail(SESSION_IO, messagesFor(runtime.language).session.io(error));
const missing = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
const parseOwner = (value: unknown): Owner | null => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	if (!("pid" in value) || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
	if (!("pidCreated" in value) || typeof value.pidCreated !== "string" || value.pidCreated === "") return null;
	if (!("token" in value) || typeof value.token !== "string" || value.token === "") return null;
	const launch = "launch" in value ? value.launch : null;
	if (launch !== null) {
		if (typeof launch !== "object" || Array.isArray(launch)) return null;
		if (!("startedAt" in launch) || typeof launch.startedAt !== "number" || !Number.isFinite(launch.startedAt)) return null;
		if (!("registrationWaitMs" in launch) || typeof launch.registrationWaitMs !== "number" || !Number.isFinite(launch.registrationWaitMs) || launch.registrationWaitMs <= 0) return null;
		return { pid: value.pid, pidCreated: value.pidCreated, token: value.token, launch: { startedAt: launch.startedAt, registrationWaitMs: launch.registrationWaitMs } };
	}
	return { pid: value.pid, pidCreated: value.pidCreated, token: value.token, launch: null };
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
	return apiOk(owners.some((owner) => created.value[String(owner.pid)] === owner.pidCreated || launchPending(runtime, owner)));
};

const launchRemaining = (runtime: RuntimePorts, owner: Owner): number => owner.launch === null ? 0 : Math.max(0, owner.launch.startedAt + owner.launch.registrationWaitMs - runtime.clock.now().getTime());
const launchPending = (runtime: RuntimePorts, owner: Owner): boolean => launchRemaining(runtime, owner) > 0;

// Reuse rig's lock only around marker transitions, including stale-owner removal. Two contenders must never
// both delete a stale marker: the second could otherwise delete the first contender's new, live ownership.
const guarded = async <T>(runtime: RuntimePorts, id: string, action: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> => {
	const directory = joinPath(runtime.home, ".agent-rig", "sessions");
	try { await runtime.fs.ensureDirectory(directory); } catch (error) { return io(runtime, errorText(error)); }
	const locked = await acquireLock({ ...runtime.lock, lockPath: joinPath(directory, `${id}.ending.lock`), messages: messagesFor(runtime.language) }, () => {});
	if (!locked.ok) return io(runtime, locked.error);
	let result: ApiResult<T>;
	try { result = await action(); } catch (error) { result = io(runtime, errorText(error)); }
	const released = await locked.value.release();
	return !released.ok && result.ok ? io(runtime, released.error) : result;
};

type ReadLiveRegistration = (folderId: string) => Promise<ApiResult<number[]>>;

// Never replace a record or process file that a newer hook has already published.
const restoreRetiredRecord = async (runtime: RuntimePorts, path: string, retired: string): Promise<ApiResult<void>> => {
	const restored = await runtime.fs.writeExclusive(path, await runtime.fs.readText(retired));
	return restored.ok ? apiOk(undefined) : io(runtime, restored.error);
};

const restoreRetiredFolder = async (runtime: RuntimePorts, directory: string, id: string, retiredId: string, livePids: number[] | null): Promise<ApiResult<void>> => {
	const target = joinPath(directory, id);
	const source = joinPath(directory, retiredId);
	if (await runtime.fs.modifiedAt(target) === null) {
		try { await runtime.fs.rename(source, target); return apiOk(undefined); }
		catch (error) { if (await runtime.fs.modifiedAt(target) === null) return io(runtime, errorText(error)); }
	}
	const processes = joinPath(source, "processes");
	const names = livePids === null
		? (await runtime.fs.listDirectory(processes)).filter((entry) => !entry.directory).map((entry) => entry.name)
		: livePids.map((pid) => `${pid}.json`);
	const destination = joinPath(target, "processes");
	await runtime.fs.ensureDirectory(destination);
	for (const name of names) {
		const restored = await runtime.fs.writeExclusive(joinPath(destination, name), await runtime.fs.readText(joinPath(processes, name)));
		// Leave the source intact if publication fails; the next guarded sweep retries it.
		if (!restored.ok) return io(runtime, restored.error);
	}
	await runtime.fs.removeDirectoryTree(source);
	return apiOk(undefined);
};

// Holding the guard proves that every retirement for this id belongs to an interrupted remover.
const sweepRetirements = async (runtime: RuntimePorts, id: string, readLive: ReadLiveRegistration): Promise<ApiResult<boolean>> => {
	const directory = joinPath(runtime.home, ".agent-rig", "sessions");
	const entries = await runtime.fs.listDirectory(directory);
	const records = entries.filter((entry) => !entry.directory && entry.name.startsWith(`${id}.json.retired-`));
	const folders = entries.filter((entry) => entry.directory && entry.name.startsWith(`${id}.retired-`));
	for (const entry of records) {
		const retired = joinPath(directory, entry.name);
		const restored = await restoreRetiredRecord(runtime, joinPath(directory, `${id}.json`), retired);
		if (!restored.ok) return restored;
		await runtime.fs.remove(retired);
	}
	for (const entry of folders) {
		const live = await readLive(entry.name);
		if (!live.ok) return live;
		if (live.value.length > 0) {
			const restored = await restoreRetiredFolder(runtime, directory, id, entry.name, live.value);
			if (!restored.ok) return restored;
		} else await runtime.fs.removeDirectoryTree(joinPath(directory, entry.name));
	}
	return apiOk(records.length > 0 || folders.length > 0);
};

export const recoverSessionRemoval = async (runtime: RuntimePorts, id: string, readLive: ReadLiveRegistration): Promise<ApiResult<boolean>> => {
	let registrationFailed = false;
	const result = await guarded(runtime, id, () => sweepRetirements(runtime, id, async (folderId) => {
		const live = await readLive(folderId);
		if (!live.ok) registrationFailed = true;
		return live;
	}));
	return result.ok || registrationFailed ? result : apiOk(false);
};

// Detach each generation under the ending guard; registration after the folder rename gets a new folder.
export const removeSessionUnlessEnding = async (runtime: RuntimePorts, id: string, keepRegistered: () => Promise<ApiResult<boolean>>, readLive: ReadLiveRegistration): Promise<ApiResult<boolean>> => {
	let registrationFailed = false;
	const inspect: ReadLiveRegistration = async (folderId) => {
		const live = await readLive(folderId);
		if (!live.ok) registrationFailed = true;
		return live;
	};
	const result = await guarded(runtime, id, async () => {
		const swept = await sweepRetirements(runtime, id, inspect);
		if (!swept.ok) return swept;
		const live = await sessionEndingLive(runtime, id);
		if (!live.ok) { registrationFailed = true; return live; }
		if (live.value) return apiOk(false);
		const directory = joinPath(runtime.home, ".agent-rig", "sessions");
		const path = joinPath(directory, `${id}.json`);
		const retired = `${path}.retired-${runtime.fs.uniqueSuffix()}`;
		const retiredId = `${id}.retired-${runtime.fs.uniqueSuffix()}`;
		let detached = false;
		const restore = async (): Promise<ApiResult<void>> => {
			if (!detached) return apiOk(undefined);
			const restored = await restoreRetiredRecord(runtime, path, retired);
			if (restored.ok) { await runtime.fs.remove(retired); detached = false; }
			return restored;
		};
		try {
			try { await runtime.fs.rename(path, retired); detached = true; }
			catch (error) { if (!missing(error)) return apiOk(false); }
			const keep = await keepRegistered();
			if (!keep.ok || keep.value) {
				if (!keep.ok) registrationFailed = true;
				await restore();
				return keep.ok ? apiOk(false) : keep;
			}
			let moved = false;
			try { await runtime.fs.rename(joinPath(directory, id), joinPath(directory, retiredId)); moved = true; }
			catch (error) {
				if (!missing(error)) { await restore(); return apiOk(false); }
			}
			if (moved) {
				const registered = await inspect(retiredId);
				if (!registered.ok || registered.value.length > 0) {
					const restored = await restoreRetiredFolder(runtime, directory, id, retiredId, registered.ok ? registered.value : null);
					// Keep the detached record paired with an unrecovered folder if restoration was interrupted.
					if (restored.ok) await restore();
					return registered.ok ? apiOk(false) : registered;
				}
				await runtime.fs.removeDirectoryTree(joinPath(directory, retiredId));
			}
			if (detached) { await runtime.fs.remove(retired); detached = false; }
			return apiOk(await runtime.fs.stat(path) === null);
		} catch {
			// Filesystem contention only postpones collection. Preserve recovery artifacts if restoration fails.
			try { await restore(); } catch { /* A later lookup retries under the guard. */ }
			return apiOk(false);
		}
	});
	return result.ok || registrationFailed ? result : apiOk(false);
};

type Entered = { marker: Marker; interrupted: boolean };

// Only stop may interrupt a live owner. All still-running operations retain an ownership token, so completion
// of either the interrupted operation or its interrupting stop cannot release the other's marker prematurely.
export const withSessionEnding = async <T>(runtime: RuntimePorts, id: string, action: (ending: SessionEnding) => Promise<ApiResult<T>>, onBusy?: (observe: ObserveEnding) => Promise<ApiResult<T>>, onReleased?: (result: ApiResult<T>, takenOver: boolean) => ApiResult<T>): Promise<ApiResult<T>> => {
	const path = markerPath(runtime, id);
	const entered = await guarded<Entered>(runtime, id, async () => {
		const existing = await readMarker(runtime, path);
		if (!existing.ok) return existing;
		const pid = runtime.lock.process.pid;
		const owners = existing.value === null ? [] : [existing.value, ...existing.value.otherOwners];
		const created = await runtime.process.createdAt([...new Set([pid, ...owners.map((owner) => owner.pid)])]);
		if (!created.ok) return io(runtime, created.error);
		if (owners.some((owner) => created.value[String(owner.pid)] === undefined)) return io(runtime, messagesFor(runtime.language).failure.processTableIncomplete());
		const otherOwners = owners.filter((owner) => created.value[String(owner.pid)] === owner.pidCreated || launchPending(runtime, owner));
		const interrupted = otherOwners.length > 0;
		if (interrupted && onBusy === undefined) return apiFail(SESSION_ENDING, messagesFor(runtime.language).session.ending());
		const pidCreated = created.value[String(pid)];
		if (pidCreated === undefined || pidCreated === null || pidCreated === "") return io(runtime, messagesFor(runtime.language).runtime.processNotFound());
		const marker: Marker = { pid, pidCreated, token: runtime.fs.uniqueSuffix(), launch: null, takenOver: interrupted, otherOwners };
		await runtime.fs.ensureDirectory(joinPath(runtime.home, ".agent-rig", "sessions", id));
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
	const observe: ObserveEnding = (pids) => guarded(runtime, id, async () => {
		const current = await readMarker(runtime, path);
		if (!current.ok) return current;
		const tokens = new Set(current.value === null ? [] : [current.value, ...current.value.otherOwners].map((owner) => owner.token));
		const owners = marker.otherOwners.filter((owner) => tokens.has(owner.token));
		const candidates = [...new Set([...pids, ...owners.map((owner) => owner.pid)])];
		const empty: Record<string, string | null> = {};
		const created = candidates.length === 0 ? ok(empty) : await runtime.process.createdAt(candidates);
		if (!created.ok) return io(runtime, created.error);
		if (candidates.some((pid) => created.value[String(pid)] === undefined)) return io(runtime, messagesFor(runtime.language).failure.processTableIncomplete());
		const pending = owners.filter((owner) => created.value[String(owner.pid)] !== owner.pidCreated && launchPending(runtime, owner));
		const registrationRemainingMs = pending.length === 0 ? null : Math.min(...pending.map((owner) => launchRemaining(runtime, owner)));
		return apiOk({ created: created.value, waiting: pending.length > 0 || owners.some((owner) => created.value[String(owner.pid)] === owner.pidCreated), registrationRemainingMs });
	});
	const ending: SessionEnding = {
		takenOver: () => guarded(runtime, id, takenOver),
		startLaunch: (start, registrationWaitMs) => guarded(runtime, id, async () => {
			const interrupted = await takenOver();
			if (!interrupted.ok) return interrupted;
			if (interrupted.value) return apiFail(SESSION_ENDING, messagesFor(runtime.language).session.ending());
			marker.launch = { startedAt: runtime.clock.now().getTime(), registrationWaitMs };
			const recorded = await atomicWrite(runtime.fs, path, JSON.stringify(marker), messagesFor(runtime.language));
			return recorded.ok ? apiOk(start()) : io(runtime, recorded.error);
		}),
	};
	let result: ApiResult<T>;
	try { result = entered.value.interrupted && onBusy !== undefined ? await onBusy(observe) : await action(ending); }
	catch (error) { result = io(runtime, errorText(error)); }
	const released = await guarded(runtime, id, async () => {
		const current = await readMarker(runtime, path);
		if (!current.ok) return current;
		if (current.value === null) return apiOk(true);
		const owners = [current.value, ...current.value.otherOwners];
		const remaining = owners.filter((owner) => owner.token !== marker.token);
		if (remaining.length === owners.length) return apiOk(true);
		const [owner, ...otherOwners] = remaining;
		if (owner === undefined) await runtime.fs.remove(path);
		else {
			const recorded = await atomicWrite(runtime.fs, path, JSON.stringify({ ...owner, takenOver: current.value.takenOver, otherOwners }), messagesFor(runtime.language));
			if (!recorded.ok) return io(runtime, recorded.error);
		}
		return apiOk(current.value.takenOver);
	});
	if (!released.ok) return result.ok ? released : result;
	return onReleased === undefined ? result : onReleased(result, released.value);
};
