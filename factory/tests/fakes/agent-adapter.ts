// Scriptable fake of one agent adapter (agent-adapters.md, "AgentAdapter: operations by meaning"). The nine operations
// are async, as on the worker. Runs are keyed by executionId: start and cancel are idempotent, streamOutput reads from a
// byte offset, getStatus and validateEnvironment are read only. What the provider decides (attach outcome, run state,
// environment checks, capabilities, the agent's report) is data the test sets; the fake decides none of it.
import type { ActivityOutput } from "./contracts.ts";

export type AttachOutcome = "collect" | "attach" | "died" | "start" | "unclear";
export type RunState = "starting" | "running" | "exited" | "lost";
export type CheckStatus = "pass" | "fail" | "unknown";
/** The shape the CollectResults activity returns: a collected report or a schema finding (agent-adapters.md, "Report schema"). */
export type CollectResult = ActivityOutput<"CollectResults">;

export interface EnvironmentCheck {
	readonly name: string;
	readonly status: CheckStatus;
}

export interface AdapterCapabilities {
	readonly roles: readonly string[];
	readonly tools: readonly string[];
	readonly kinds: readonly string[];
	readonly resume: boolean;
	readonly cancel: boolean;
}

export interface RunStatus {
	readonly state: RunState;
	/** Bytes of output written so far; offsets in streamOutput are byte offsets into the same output. */
	readonly outputBytes: number;
}

export interface OutputChunk {
	readonly offset: number;
	readonly text: string;
}

export interface StreamedOutput {
	readonly chunks: readonly OutputChunk[];
	readonly nextOffset: number;
}

export interface CancelResult {
	/** False keeps the task in CANCELLING until the machine confirms the end or the owner forces the close (D21). */
	readonly endConfirmed: boolean;
}

export interface FakeAgentAdapter {
	readonly getCapabilities: () => Promise<AdapterCapabilities>;
	/** Declares what the adapter offers. Nothing is declared until a test declares it. */
	readonly setCapabilities: (capabilities: AdapterCapabilities) => void;
	readonly setChecks: (checks: readonly EnvironmentCheck[]) => void;
	readonly validateEnvironment: () => Promise<EnvironmentCheck[]>;
	/** Starts the run; a repeat with the same executionId returns the first launch id and starts nothing. */
	readonly start: (executionId: string) => Promise<string>;
	/** Agent processes actually started (counts the first start of each executionId only). */
	readonly launches: () => number;
	readonly setAttachOutcome: (executionId: string, outcome: AttachOutcome) => void;
	/** Throws when no outcome was set for the execution: the fake does not guess what the provider found. */
	readonly attach: (executionId: string) => Promise<AttachOutcome>;
	readonly setState: (executionId: string, state: RunState) => void;
	readonly getStatus: (executionId: string) => Promise<RunStatus>;
	/** Adds output to the run, as the agent would write it. */
	readonly appendOutput: (executionId: string, text: string) => void;
	/** Output from a byte offset; an offset past the end is refused. */
	readonly streamOutput: (executionId: string, fromOffset: number) => Promise<StreamedOutput>;
	/** Sets whether a cancel confirms the end. The default is confirmed. */
	readonly setCancelConfirmation: (executionId: string, confirmed: boolean) => void;
	readonly cancel: (executionId: string) => Promise<CancelResult>;
	readonly setCollectOutcome: (executionId: string, outcome: CollectResult) => void;
	/** Throws when no outcome was set for the execution. */
	readonly collectResult: (executionId: string) => Promise<CollectResult>;
	readonly cleanup: (executionId: string) => Promise<void>;
	/** Whether cleanup ran for the execution. */
	readonly cleaned: (executionId: string) => boolean;
}

interface Run {
	state: RunState;
	readonly launchId: string;
	output: Buffer;
	cancelConfirmed: boolean;
}

export const createFakeAgentAdapter = (): FakeAgentAdapter => {
	const runs = new Map<string, Run>();
	const attachOutcomes = new Map<string, AttachOutcome>();
	const collectOutcomes = new Map<string, CollectResult>();
	const cleanedIds = new Set<string>();
	let launched = 0;
	let capabilities: AdapterCapabilities = { roles: [], tools: [], kinds: [], resume: false, cancel: false };
	let checks: EnvironmentCheck[] = [];

	const runOf = (executionId: string): Run => {
		const run = runs.get(executionId);
		if (run === undefined) throw new Error(`no run ${executionId}: start it first`);
		return run;
	};

	return {
		getCapabilities: async () => ({ ...capabilities, roles: [...capabilities.roles], tools: [...capabilities.tools], kinds: [...capabilities.kinds] }),
		setCapabilities: (next) => {
			capabilities = next;
		},
		setChecks: (next) => {
			checks = next.map((check) => ({ ...check }));
		},
		validateEnvironment: async () => checks.map((check) => ({ ...check })),
		start: async (executionId) => {
			const existing = runs.get(executionId);
			if (existing !== undefined) return existing.launchId;
			launched += 1;
			const run: Run = { state: "starting", launchId: `launch-${launched}`, output: Buffer.alloc(0), cancelConfirmed: true };
			runs.set(executionId, run);
			return run.launchId;
		},
		launches: () => launched,
		setAttachOutcome: (executionId, outcome) => {
			attachOutcomes.set(executionId, outcome);
		},
		attach: async (executionId) => {
			const outcome = attachOutcomes.get(executionId);
			if (outcome === undefined) throw new Error(`no attach outcome set for ${executionId}`);
			return outcome;
		},
		setState: (executionId, state) => {
			runOf(executionId).state = state;
		},
		getStatus: async (executionId) => {
			const run = runOf(executionId);
			return { state: run.state, outputBytes: run.output.length };
		},
		appendOutput: (executionId, text) => {
			const run = runOf(executionId);
			run.output = Buffer.concat([run.output, Buffer.from(text, "utf8")]);
		},
		streamOutput: async (executionId, fromOffset) => {
			const run = runOf(executionId);
			if (!Number.isInteger(fromOffset) || fromOffset < 0 || fromOffset > run.output.length) {
				throw new Error(`offset ${fromOffset} is outside the output of ${executionId} (${run.output.length} bytes)`);
			}
			const text = run.output.subarray(fromOffset).toString("utf8");
			return { chunks: text.length > 0 ? [{ offset: fromOffset, text }] : [], nextOffset: run.output.length };
		},
		setCancelConfirmation: (executionId, confirmed) => {
			runOf(executionId).cancelConfirmed = confirmed;
		},
		cancel: async (executionId) => ({ endConfirmed: runOf(executionId).cancelConfirmed }),
		setCollectOutcome: (executionId, outcome) => {
			collectOutcomes.set(executionId, outcome);
		},
		collectResult: async (executionId) => {
			runOf(executionId);
			const outcome = collectOutcomes.get(executionId);
			if (outcome === undefined) throw new Error(`no collect outcome set for ${executionId}`);
			return outcome;
		},
		cleanup: async (executionId) => {
			cleanedIds.add(executionId);
		},
		cleaned: (executionId) => cleanedIds.has(executionId),
	};
};
