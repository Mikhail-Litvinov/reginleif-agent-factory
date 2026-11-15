// Counts the live members of a POSIX process group, the runner of an exec run being the group's leader.

// `ps -eo pid=,pgid=,stat=` prints one row per process: pid, process group id, state letters. A state starting with Z
// is a zombie: it has ended and only waits for its parent to collect it, so it is not a live member of the run.
const ZOMBIE_STATE = "Z";
const ROW_PATTERN = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/;

export const PROCESS_TABLE_ARGUMENTS: readonly string[] = ["-eo", "pid=,pgid=,stat="];

/**
 * The number of live processes in group `group` other than `self`, read from the output of `ps -eo pid=,pgid=,stat=`.
 * Rows that do not parse are ignored: they cannot belong to a member whose pid and group are known.
 */
export const countGroupMembers = (table: string, group: number, self: number): number => {
	let members = 0;
	for (const line of table.split("\n")) {
		const match = ROW_PATTERN.exec(line);
		if (match === null) continue;
		if (Number(match[2]) !== group || Number(match[1]) === self || match[3].startsWith(ZOMBIE_STATE)) continue;
		members += 1;
	}
	return members;
};
