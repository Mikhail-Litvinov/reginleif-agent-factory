// The pure half of the operator-doc helpers (docs/agent-factory/*.md): reading and parsing the doc commands, the mount-site
// rule and the scratch adaptation of a command. Nothing here starts a process, so a file that only parses doc text (listed
// as TEXT_ONLY in owned-creation-guard.test.ts) imports this module and not doc-lib.ts, which holds the process starters.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const docUrl = (name: string): URL => new URL(`../../docs/agent-factory/${name}`, import.meta.url);
export const docText = (name: string): string => readFileSync(docUrl(name), "utf8");

// The repository root, as a Windows path with forward slashes (what PowerShell and docker compose both accept).
export const REPO_ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")).replace(/\/$/, "");
export const RUN_LABEL_FILE = `${REPO_ROOT}/factory/deploy/compose.run.yml`;

// Code that is meant to be typed: inline spans that start like a command, an option or a variable, and fenced lines.
const COMMAND_START = /^(\$|&\s|node\s|npm\s|docker\s|powershell|pwsh|--|if\s|icacls\s|git\s|Copy-Item\s|Get-ChildItem\s|Out-File\s)/;

export interface DocCommand {
	readonly line: number;
	readonly code: string;
}

export const commandsOf = (text: string): DocCommand[] => {
	const found: DocCommand[] = [];
	let fenced = false;
	text.split(/\r?\n/).forEach((line, index) => {
		if (/^\s*```/.test(line)) {
			fenced = !fenced;
			return;
		}
		if (fenced) {
			found.push({ line: index + 1, code: line });
			return;
		}
		for (const span of line.matchAll(/`([^`\n]+)`/g)) {
			if (COMMAND_START.test(span[1] ?? "")) found.push({ line: index + 1, code: span[1] ?? "" });
		}
	});
	return found;
};

// What PowerShell would parse: the single-quoted strings are text, everything else is syntax.
export const outsideQuotes = (code: string): string => code.replace(/'(?:[^']|'')*'/g, "''");

// The commands of a doc that act on the data volume: bring a container up on it (up, run), mount it, or remove it. Each
// of them must be on one line with the identity proof before it (the same line, because a pasted line that fails stops
// only itself, not the lines pasted after it).
export const MOUNT_SITES: readonly RegExp[] = [
	/\bdocker\s+compose\b.*\b(up|run)\b/,
	/\bdocker\s+volume\s+rm\b/,
	/\bdocker\s+run\b.*pgdata\b/,
];
const COMPOSE_UP_RUN = MOUNT_SITES[0] as RegExp;

// Whether a compose file declares a volume: a top-level `volumes:`, or a named volume (not a bind mount of a path or a
// variable) among a service's `volumes:` entries. Line-based, the compose files here are plain block YAML.
export const composeDeclaresVolume = (yaml: string): boolean => {
	let inVolumes = false;
	let indent = 0;
	for (const raw of yaml.split(/\r?\n/)) {
		const line = raw.replace(/\s+#.*$/, "").trimEnd();
		if (line.trim() === "" || line.trim().startsWith("#")) continue;
		const lead = line.length - line.trimStart().length;
		if (/^volumes:/.test(line)) return true;
		if (inVolumes && lead <= indent) inVolumes = false;
		if (/^\s+volumes:\s*$/.test(line)) {
			inVolumes = true;
			indent = lead;
			continue;
		}
		if (/^\s+volumes:\s*\[\s*[^\]\s]/.test(line)) return true;
		if (inVolumes) {
			const source = /^\s*-\s*["']?([^:"'\s]+)/.exec(line)?.[1];
			if (source === undefined || /^[A-Za-z0-9][\w.-]*$/.test(source)) return true;
		}
	}
	return false;
};

// The files a compose line names with -f, as the docs write them (relative to the repository root).
const composeFiles = (code: string): string[] => [...code.matchAll(/\s-f\s+("[^"]*"|'[^']*'|\S+)/g)].map((m) => (m[1] as string).replace(/^["']|["']$/g, ""));

// A compose line is a mount site only when a file it names declares a volume. No -f, or an -f that cannot be resolved
// (a variable, a missing file), stays a mount site: the rule fails closed.
const composeMounts = (code: string): boolean => {
	const files = composeFiles(code);
	if (files.length === 0) return true;
	return files.some((file) => {
		if (/[$`]/.test(file)) return true;
		try {
			return composeDeclaresVolume(readFileSync(join(REPO_ROOT, file), "utf8"));
		} catch {
			return true;
		}
	});
};

export const isMountSite = (code: string): boolean =>
	MOUNT_SITES.slice(1).some((site) => site.test(code)) || (COMPOSE_UP_RUN.test(code) && composeMounts(code));

export const PROOF_NAME = "$proveVolume";
export const GATE_NAME = "$protectedDir";
// The doc line that defines a script block variable (`$name = { ... }`).
export const definitionOf = (text: string, name: string): string | undefined => commandsOf(text).find(({ code }) => code.startsWith(`${name} = {`))?.code;
// The doc line that defines the volume proof.
export const proofDefinition = (text: string): string | undefined => definitionOf(text, PROOF_NAME);
// The doc line that defines the protected-directory gate.
export const gateDefinition = (text: string): string | undefined => definitionOf(text, GATE_NAME);

const unquote = (text: string): string => text.replace(/^["']|["']$/g, "");

// The project a mount site acts on: the -p of a compose command, else the name before _pgdata.
export const projectOfSite = (code: string): string | undefined => {
	const compose = /\s-p\s+("[^"]+"|'[^']+'|\S+)/.exec(code)?.[1];
	if (compose !== undefined) return unquote(compose);
	return /([\w$-]+)_pgdata/.exec(code)?.[1];
};

// The project the proof on this line names, when the line proves before it acts (the proof comes first on the same line).
export const proofBefore = (code: string): string | undefined => {
	const proof = /&\s+\$proveVolume\s+("[^"]+"|'[^']+'|\S+)/.exec(code);
	const site = MOUNT_SITES.map((pattern) => pattern.exec(code)?.index).filter((at): at is number => at !== undefined);
	if (proof === null || site.length === 0 || proof.index > Math.min(...site)) return undefined;
	return unquote(proof[1] as string);
};

// A scratch project in place of the real one, and the second compose file that labels what the scratch stack creates (so
// that removal by label finds it). No command text may keep the real project name.
export interface Adapt {
	readonly project: string;
	readonly runFile?: string;
}

export const adaptCommand = (code: string, adapt: Adapt): string => {
	// "/etc/agent-factory" is a path inside the image's container (the mounted config), not the project name.
	let out = code.replace(/(?<!\/etc\/)agent-factory/g, adapt.project);
	const runFile = adapt.runFile ?? RUN_LABEL_FILE;
	if (!out.includes("compose.run.yml")) out = out.replace(/(-f\s+("[^"]*compose\.yml"|'[^']*compose\.yml'|\S*compose\.yml))/g, `$1 -f '${runFile}'`);
	return out;
};
