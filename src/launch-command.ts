import type { Platform } from "./feature.js";

// cswap, terminal and tmux are the launcher commands as they were checked: a full path where a lookup found the file,
// null when that launcher is not used. The launch starts exactly these strings.
type LaunchFacts = { platform: Platform; cwd: string; session: string; account: string; mode: string | null; plugins: string[]; cswap: string | null; terminal: string | null; tmux: string | null };

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const buildLaunchCommand = (facts: LaunchFacts): string[] | null => {
	const args = [...facts.plugins.flatMap((plugin) => ["--channels", `plugin:${plugin}`]), "--resume", facts.session, ...(facts.mode === null ? [] : ["--permission-mode", facts.mode])];
	const claude = facts.cswap === null ? ["claude", ...args] : [facts.cswap, "run", ...(facts.account === "" ? [] : [facts.account]), "--share-history", "--", ...args];
	if (facts.platform === "windows") return ["cmd.exe", "/c", "start", "", "wt.exe", "-w", "new", "-d", facts.cwd, "cmd.exe", "/c", `${claude.join(" ")} & exit /b 0`];
	if (facts.platform === "darwin") return ["osascript", "-e", "on run argv", "-e", "tell application \"Terminal\" to do script (item 1 of argv)", "-e", "end run", "--", `cd -- ${quote(facts.cwd)} && exec ${claude.map(quote).join(" ")}`];
	if (facts.terminal !== null) return [facts.terminal, "-e", "sh", "-c", 'cd -- "$1" && shift && exec "$@"', "sh", facts.cwd, ...claude];
	if (facts.tmux !== null) return [facts.tmux, "new-session", "-d", "-c", facts.cwd, ...claude];
	return null;
};
