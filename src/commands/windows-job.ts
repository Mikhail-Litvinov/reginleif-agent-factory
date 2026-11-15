import type { Messages } from "../messages.js";
import type { Result } from "../result.js";

import { dlopen, FFIType, ptr } from "bun:ffi";

import { err, errorText, ok } from "../result.js";

// Win32 JobObjectBasicAccountingInformation class id.
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS = 1;
// Win32 JobObjectExtendedLimitInformation class id.
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: every process of the job dies when the last handle to it closes.
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
// sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on x64; LimitFlags sits at offset 16, after the two 8-byte time limits.
const EXTENDED_LIMIT_INFORMATION_SIZE = 144;
const LIMIT_FLAGS_OFFSET = 16;
// sizeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION): four 8-byte times, then four 4-byte counters; ActiveProcesses is the third counter.
const BASIC_ACCOUNTING_INFORMATION_SIZE = 48;
const ACTIVE_PROCESSES_OFFSET = 40;
const WIN32_FALSE = 0;
// Win32 JobObjectBasicProcessIdList class id. The buffer is JOBOBJECT_BASIC_PROCESS_ID_LIST: two DWORDs (processes assigned,
// ids in the list), then a ULONG_PTR array of ids (8 bytes each on x64) starting at offset 8.
const JOB_OBJECT_BASIC_PROCESS_ID_LIST_CLASS = 3;
const PROCESS_ID_LIST_HEADER_SIZE = 8;
const PROCESS_ID_SIZE = 8;
// The first query asks for this many ids; a job with more is read again with the size the first answer reports.
const INITIAL_PROCESS_ID_CAPACITY = 64;
// The list can grow between two queries; the retry is bounded so a job that keeps growing cannot hold the caller.
const PROCESS_ID_QUERY_ATTEMPTS = 5;
const ERROR_MORE_DATA = 234;
// PROCESS_TERMINATE access right, and the exit code a terminated member gets.
const PROCESS_TERMINATE = 0x1;
const TERMINATED_EXIT_CODE = 1;

type Job = { activeProcesses(): Result<number>; terminateOthers(selfPid: number): Result<void> };

let confined: Result<Job> | null = null;

/**
 * Puts the current process into a job object that kills the whole job when this process ends, however it ends.
 * Children spawned afterwards inherit the job, so a killed runner takes down descendants that `taskkill /T` cannot
 * reach because an intermediate parent already exited (Git Bash and other MSYS programs do this). Idempotent.
 */
export const confineToKillOnCloseJob = (messages: Messages): Result<void> => {
	const job = confinedJob(messages);
	return job.ok ? ok(undefined) : job;
};

/**
 * How many processes of the current process's job are alive, the current process not counted. Confines the current
 * process first when that has not happened yet. A process that broke away from the job on its own is not in it.
 */
export const jobMembersOtherThanSelf = (messages: Messages): Result<number> => {
	const job = confinedJob(messages);
	if (!job.ok) return job;
	const active = job.value.activeProcesses();
	return active.ok ? ok(Math.max(0, active.value - 1)) : active;
};

/**
 * Terminates every process of the current process's job except the current process. Succeeds when none is left to
 * terminate: a member that ended between the listing and the termination is already gone, which is the goal.
 */
export const terminateJobMembersOtherThanSelf = (messages: Messages): Result<void> => {
	const job = confinedJob(messages);
	return job.ok ? job.value.terminateOthers(process.pid) : job;
};

const confinedJob = (messages: Messages): Result<Job> => {
	if (confined !== null) return confined;
	confined = create(messages);
	return confined;
};

const create = (messages: Messages): Result<Job> => {
	try {
		const kernel = dlopen("kernel32.dll", {
			CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
			SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
			QueryInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
			AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
			TerminateProcess: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
			CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
			GetCurrentProcess: { args: [], returns: FFIType.ptr },
			GetLastError: { args: [], returns: FFIType.u32 },
		});
		const job = kernel.symbols.CreateJobObjectW(null, null);
		if (job === null) return err(messages.failure.win32CallFailed("CreateJobObjectW", kernel.symbols.GetLastError()));
		const info = new Uint8Array(EXTENDED_LIMIT_INFORMATION_SIZE);
		new DataView(info.buffer).setUint32(LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
		if (kernel.symbols.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, ptr(info), info.length) === WIN32_FALSE) {
			return err(messages.failure.win32CallFailed("SetInformationJobObject", kernel.symbols.GetLastError()));
		}
		if (kernel.symbols.AssignProcessToJobObject(job, kernel.symbols.GetCurrentProcess()) === WIN32_FALSE) {
			return err(messages.failure.win32CallFailed("AssignProcessToJobObject", kernel.symbols.GetLastError()));
		}
		const activeProcesses = (): Result<number> => {
			try {
				const accounting = new Uint8Array(BASIC_ACCOUNTING_INFORMATION_SIZE);
				if (kernel.symbols.QueryInformationJobObject(job, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS, ptr(accounting), accounting.length, null) === WIN32_FALSE) {
					return err(messages.failure.win32CallFailed("QueryInformationJobObject", kernel.symbols.GetLastError()));
				}
				return ok(new DataView(accounting.buffer).getUint32(ACTIVE_PROCESSES_OFFSET, true));
			} catch (error) {
				return err(messages.failure.jobObjectFailed(errorText(error)));
			}
		};
		// The ids of the job's processes, or an error. A buffer too small answers ERROR_MORE_DATA with the real count in its header.
		const memberIds = (): Result<number[]> => {
			let capacity = INITIAL_PROCESS_ID_CAPACITY;
			for (let attempt = 0; attempt < PROCESS_ID_QUERY_ATTEMPTS; attempt++) {
				const list = new Uint8Array(PROCESS_ID_LIST_HEADER_SIZE + capacity * PROCESS_ID_SIZE);
				const view = new DataView(list.buffer);
				const queried = kernel.symbols.QueryInformationJobObject(job, JOB_OBJECT_BASIC_PROCESS_ID_LIST_CLASS, ptr(list), list.length, null);
				if (queried === WIN32_FALSE && kernel.symbols.GetLastError() !== ERROR_MORE_DATA) return err(messages.failure.win32CallFailed("QueryInformationJobObject", kernel.symbols.GetLastError()));
				const assigned = view.getUint32(0, true);
				if (queried === WIN32_FALSE) { capacity = Math.max(assigned, capacity + 1); continue; }
				const listed = view.getUint32(4, true);
				return ok(Array.from({ length: listed }, (_, index) => Number(view.getBigUint64(PROCESS_ID_LIST_HEADER_SIZE + index * PROCESS_ID_SIZE, true))));
			}
			return err(messages.failure.jobListKeptChanging());
		};
		const terminateOthers = (selfPid: number): Result<void> => {
			try {
				const ids = memberIds();
				if (!ids.ok) return ids;
				for (const id of ids.value) {
					if (id === selfPid) continue;
					const handle = kernel.symbols.OpenProcess(PROCESS_TERMINATE, WIN32_FALSE, id);
					// No handle: the member ended since the listing (or cannot be opened); the next count tells which.
					if (handle === null) continue;
					kernel.symbols.TerminateProcess(handle, TERMINATED_EXIT_CODE);
					kernel.symbols.CloseHandle(handle);
				}
				return ok(undefined);
			} catch (error) {
				return err(messages.failure.jobObjectFailed(errorText(error)));
			}
		};
		return ok({ activeProcesses, terminateOthers });
	} catch (error) {
		return err(messages.failure.jobObjectFailed(errorText(error)));
	}
};
