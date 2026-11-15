import type { Platform } from "./feature.js";
import type { Result } from "./result.js";

import { err, ok } from "./result.js";

// Identifiers on the launch command line (account, plugin id, marketplace name): ASCII letters, digits, _ . @ and -.
// No launch parser on any platform reads these characters as syntax.
export const LAUNCH_TOKEN = /^[\w.@-]+$/;

// Windows: cmd.exe /c start "" wt.exe -w new -d <cwd> cmd.exe /c "<inner line>".
// - The outer cmd.exe reads & | < > ^ " and % as syntax: an unquoted ^ is consumed, and % expands even inside quotes.
//   It reads ! too when delayed expansion is on, a per-machine registry setting, so ! is refused everywhere.
// - Control characters are refused: a command line cannot quote them reliably.
// - wt.exe reads ; as a subcommand separator, and \; as a literal ;. A run of n backslashes before ; gives n-1 literal
//   backslashes, so a directory with k literal backslashes before ; is written with k+1 of them.
// - Probed through the product's spawn and the real wt.exe: ( ) ' # $ @ ~ + = , [ ] and space pass unchanged.
//   NTFS already forbids " * ? < > | and control characters in names.
const WINDOWS_REFUSED = /[&|<>^%"!\x00-\x1f]/;
const WINDOWS_SEMICOLON = /(\\*);/g;

// macOS: the directory is one exact osascript argv item, typed into the Terminal tty as `cd -- '<dir>' && exec ...`.
// The login shell reads single-quoted text literally (quote() writes '\'' for an apostrophe). The tty acts on control
// characters: CR or LF runs the line, ^C interrupts, ^U erases, so they are refused.
const DARWIN_REFUSED = /[\x00-\x1f]/;

// Linux: x-terminal-emulator passes the directory as an exact argv item ($1 of sh -c), so nothing parses it.
// tmux new-session -c takes it as a tmux argument: a ';' that ends an argument is a command separator, and '#' starts
// a format such as #{...}, which tmux expands in -c. Both are refused. Not verified against a live tmux (no tmux here).
const LINUX_REFUSED = /[;#]/;

// The value as it must appear on the launch command line, or "refused" when the platform's parsers cannot carry it.
// The command takes this form; file-system calls keep the original path.
export const launchPath = (platform: Platform, path: string): Result<string> => {
	if (platform === "windows") return WINDOWS_REFUSED.test(path) ? err("refused") : ok(path.replaceAll(WINDOWS_SEMICOLON, "$1\\;"));
	if (platform === "darwin") return DARWIN_REFUSED.test(path) ? err("refused") : ok(path);
	return LINUX_REFUSED.test(path) ? err("refused") : ok(path);
};
