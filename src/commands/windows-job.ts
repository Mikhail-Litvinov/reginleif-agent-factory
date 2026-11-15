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

type Job = { activeProcesses(): Result<number> };

let confined: Result<Job> | null = null;

/**
 * Puts the current process into a job object that kills the whole job when this process ends, however it ends.
 * Children spawned afterwards inherit the job, so a killed runner takes down descendants that `taskkill /T` cannot
 * reach because an intermediate parent already exited (Git Bash and other MSYS programs do this). Idempotent.
 */
export const confineToKillOnCloseJob = (): Result<void> => {
	const job = confinedJob();
	return job.ok ? ok(undefined) : job;
};

/**
 * How many processes of the current process's job are alive, the current process not counted. Confines the current
 * process first when that has not happened yet. A process that broke away from the job on its own is not in it.
 */
export const jobMembersOtherThanSelf = (): Result<number> => {
	const job = confinedJob();
	if (!job.ok) return job;
	const active = job.value.activeProcesses();
	return active.ok ? ok(Math.max(0, active.value - 1)) : active;
};

const confinedJob = (): Result<Job> => {
	if (confined !== null) return confined;
	confined = create();
	return confined;
};

const create = (): Result<Job> => {
	try {
		const kernel = dlopen("kernel32.dll", {
			CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
			SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
			QueryInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
			AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
			GetCurrentProcess: { args: [], returns: FFIType.ptr },
			GetLastError: { args: [], returns: FFIType.u32 },
		});
		const job = kernel.symbols.CreateJobObjectW(null, null);
		if (job === null) return err(`CreateJobObjectW failed: ${kernel.symbols.GetLastError()}`);
		const info = new Uint8Array(EXTENDED_LIMIT_INFORMATION_SIZE);
		new DataView(info.buffer).setUint32(LIMIT_FLAGS_OFFSET, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, true);
		if (kernel.symbols.SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, ptr(info), info.length) === WIN32_FALSE) {
			return err(`SetInformationJobObject failed: ${kernel.symbols.GetLastError()}`);
		}
		if (kernel.symbols.AssignProcessToJobObject(job, kernel.symbols.GetCurrentProcess()) === WIN32_FALSE) {
			return err(`AssignProcessToJobObject failed: ${kernel.symbols.GetLastError()}`);
		}
		const activeProcesses = (): Result<number> => {
			try {
				const accounting = new Uint8Array(BASIC_ACCOUNTING_INFORMATION_SIZE);
				if (kernel.symbols.QueryInformationJobObject(job, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION_CLASS, ptr(accounting), accounting.length, null) === WIN32_FALSE) {
					return err(`QueryInformationJobObject failed: ${kernel.symbols.GetLastError()}`);
				}
				return ok(new DataView(accounting.buffer).getUint32(ACTIVE_PROCESSES_OFFSET, true));
			} catch (error) {
				return err(errorText(error));
			}
		};
		return ok({ activeProcesses });
	} catch (error) {
		return err(errorText(error));
	}
};
