// One strict parser for the flags of every command in deploy/ (backup, restore, restore-check, verify-init, setup-secrets).
// A wrong command line is a usage error (exit status 2, the usage text printed), never a guess: an unknown flag, a flag
// without a value or with an empty one, a value that is itself a flag, a flag given twice, a missing required flag and a
// positional argument the command does not take all stop the command before it does anything. Silently ignoring or
// defaulting one of them could run a different backup or restore than the person typed.

export class UsageError extends Error {}

// "value": the flag takes the next argument; "boolean": the flag stands alone.
export type FlagKind = "value" | "boolean";

export interface CliSpec {
	readonly flags: Readonly<Record<string, FlagKind>>;
	// Flags that must be given (value flags only).
	readonly required?: readonly string[];
	// How many positional (non-flag) arguments the command takes, exactly; 0 when it takes none.
	readonly positionals?: number;
}

export interface ParsedArgs {
	// The value of each value flag that was given.
	readonly values: Readonly<Record<string, string>>;
	// The boolean flags that were given.
	readonly present: ReadonlySet<string>;
	readonly positionals: readonly string[];
}

export const parseCliArgs = (argv: readonly string[], spec: CliSpec): ParsedArgs => {
	const values: Record<string, string> = {};
	const present = new Set<string>();
	const positionals: string[] = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] as string;
		if (!arg.startsWith("--")) {
			if (arg.trim() === "") throw new UsageError("an argument is empty");
			positionals.push(arg);
			continue;
		}
		const kind = Object.hasOwn(spec.flags, arg) ? spec.flags[arg] : undefined;
		if (kind === undefined) throw new UsageError(`unknown argument: ${arg}`);
		if (present.has(arg) || Object.hasOwn(values, arg)) throw new UsageError(`${arg} given more than once`);
		if (kind === "boolean") {
			present.add(arg);
			continue;
		}
		const value = argv[i + 1];
		if (value === undefined || value.trim() === "" || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
		values[arg] = value;
		i += 1;
	}
	const wanted = spec.positionals ?? 0;
	if (positionals.length > wanted) throw new UsageError(`unknown argument: ${positionals[wanted]}`);
	if (positionals.length < wanted) throw new UsageError(`missing argument: expected ${wanted}, got ${positionals.length}`);
	for (const name of spec.required ?? []) {
		if (!Object.hasOwn(values, name)) throw new UsageError(`${name} is required`);
	}
	return { values, present, positionals };
};

// A value flag that must be a whole number in a range (a port).
export const integerValue = (flag: string, text: string, min: number, max: number): number => {
	if (!/^\d+$/.test(text)) throw new UsageError(`${flag} needs a whole number, got ${text}`);
	const number = Number(text);
	if (number < min || number > max) throw new UsageError(`${flag} must be between ${min} and ${max}, got ${text}`);
	return number;
};

// The end of a command's main block: a usage error prints the problem and the usage and sets exit status 2, any other
// failure prints with `label` and sets 1.
export const reportCliFailure = (error: unknown, label: string, usage: string): void => {
	const message = error instanceof Error ? error.message : String(error);
	if (error instanceof UsageError) {
		console.error(`${label}: ${message}`);
		console.error(usage);
		process.exitCode = 2;
		return;
	}
	console.error(`${label}: ${message}`);
	process.exitCode = 1;
};
