import type { Result } from "../result.js";

import { dlopen, FFIType, ptr } from "bun:ffi";

import { err, errorText, ok } from "../result.js";

// Win32 JobObjectExtendedLimitInformation class id.
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: every process of the job dies when the last handle to it closes.
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
// sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on x64; LimitFlags sits at offset 16, after the two 8-byte time limits.
const EXTENDED_LIMIT_INFORMATION_SIZE = 144;
const LIMIT_FLAGS_OFFSET = 16;
const WIN32_FALSE = 0;

let confined: Result<void> | null = null;

/**
 * Puts the current process into a job object that kills the whole job when this process ends, however it ends.
 * Children spawned afterwards inherit the job, so a killed runner takes down descendants that `taskkill /T` cannot
 * reach because an intermediate parent already exited (Git Bash and other MSYS programs do this). Idempotent.
 */
export const confineToKillOnCloseJob = (): Result<void> => {
	if (confined !== null) return confined;
	confined = create();
	return confined;
};

const create = (): Result<void> => {
	try {
		const kernel = dlopen("kernel32.dll", {
			CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
			SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
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
		return ok(undefined);
	} catch (error) {
		return err(errorText(error));
	}
};
