import type { FileSystem } from "./file-system.js";
import type { Language } from "./messages.js";
import type { LockDependencies } from "./lock.js";
import type { Platform } from "./feature.js";
import type { Result } from "./result.js";
import type { FileSystem as AssetFileSystem } from "./assets/installer.js";

export const PROCESS_SUCCESS_EXIT_CODE = 0;
export const PROCESS_FAILURE_EXIT_CODE = 1;

export type ProcessOutput = {
	stdout: string;
	stderr: string;
	exitCode: number;
};

export type ProcessOptions = {
	cwd?: string;
	input?: string;
	environment?: Record<string, string>;
	// Overrides the runner's default limit for this call; a command that outlives it is killed with its whole process
	// tree and the call fails with an error.
	timeoutMs?: number;
};

export type ProcessPorts = {
	run(command: string, args: readonly string[], options?: ProcessOptions): Promise<Result<ProcessOutput>>;
	spawnDetached(command: readonly string[], graceMs: number, stderrLimit: number, stderrPath: string): Promise<Result<{ exited: boolean; exitCode: number | null; stderr: string }>>;
	isAvailable(command: string): Promise<boolean>;
	createdAt(pids: readonly number[]): Promise<Result<Record<string, string | null>>>;
	killTree(pid: number): Promise<Result<void>>;
};

export type RuntimePorts = {
	fs: FileSystem;
	assetFs: AssetFileSystem;
	process: ProcessPorts;
	// Reads of the process environment (CODEX_HOME and the like); commands never touch process.env directly.
	environment: { get(name: string): string | undefined };
	lock: LockDependencies;
	home: string;
	currentDirectory: string;
	resolvePath(...parts: string[]): string;
	executablePath: string;
	pythonCommand: string;
	pathEnvironment: string;
	platform: Platform;
	// The language of everything rig prints. runCli reads it from state.json once per command run and sets it here;
	// code that builds a text takes it from this field (or from messagesFor(language)) and never reads the disk for it.
	language: Language;
	clock: {
		now(): Date;
		nowText(): string;
		sleep(milliseconds: number): Promise<void>;
	};
	ids: { next(): string };
	service: {
		start(): Promise<Result<void>>;
		stop(): Promise<Result<void>>;
		isRunning(): Promise<Result<boolean>>;
		restart(): Promise<Result<void>>;
	};
	programs: { install(name: string, binDirectory: string): Promise<Result<void>> };
	temporary: {
		createDirectory(prefix: string): Promise<Result<string>>;
		removeDirectory(path: string): Promise<Result<void>>;
	};
	writeExecutable(path: string, content: string): Promise<Result<void>>;
};
