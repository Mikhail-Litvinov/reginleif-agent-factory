import type { Platform } from "./feature.js";

type LaunchFacts = { platform: Platform; cwd: string; session: string; account: string; mode: string | null; plugins: string[]; cswap: boolean; display: boolean; terminal: boolean; tmux: boolean };

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const buildLaunchCommand = (facts: LaunchFacts): string[] | null => {
	const args = [...facts.plugins.flatMap((plugin) => ["--channels", `plugin:${plugin}`]), "--resume", facts.session, ...(facts.mode === null ? [] : ["--permission-mode", facts.mode])];
	const claude = facts.cswap ? ["cswap", "run", ...(facts.account === "" ? [] : [facts.account]), "--share-history", "--", ...args] : ["claude", ...args];
	if (facts.platform === "windows") return ["cmd.exe", "/c", "start", "", "wt.exe", "-w", "new", "-d", facts.cwd, "cmd.exe", "/c", `${claude.map((part, index) => index === 0 && facts.cswap ? "cswap.exe" : part).join(" ")} & exit /b 0`];
	if (facts.platform === "darwin") return ["osascript", "-e", "on run argv", "-e", "tell application \"Terminal\" to do script (item 1 of argv)", "-e", "end run", "--", `cd -- ${quote(facts.cwd)} && exec ${claude.map(quote).join(" ")}`];
	if (facts.display && facts.terminal) return ["x-terminal-emulator", "-e", "sh", "-c", 'cd -- "$1" && shift && exec "$@"', "sh", facts.cwd, ...claude];
	if (facts.tmux) return ["tmux", "new-session", "-d", "-c", facts.cwd, ...claude];
	return null;
};
