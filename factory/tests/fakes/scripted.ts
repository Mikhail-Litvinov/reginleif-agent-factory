// Scriptable fake of one machine activity. It obeys its contract (contracts.ts): it validates the input, every output and
// every heartbeat with the contract's schemas; it refuses scripted error kinds the contract does not allow; and it answers
// a repeated idempotency key from its store where the contract stores results. A test queues what the next calls do:
// succeed, fail with an error kind, or hang until the call's AbortSignal fires. Without a queued behavior a call succeeds
// with SAMPLE_OUTPUTS. Hangs use the signal, not timers, so a test never waits on the clock.
import { ActivityError, type ActivityErrorKind, type ActivityHeartbeat, type ActivityOutput, type MachineActivityName, SAMPLE_OUTPUTS, contractOf } from "./contracts.ts";

export type Outcome<K extends MachineActivityName> =
	| { readonly kind: "succeed"; readonly output: ActivityOutput<K> }
	| { readonly kind: "fail"; readonly error: ActivityErrorKind; readonly message?: string }
	| { readonly kind: "hang" };

/** One scripted call: heartbeats emitted first (each must match the contract's heartbeat schema), then the outcome. */
export interface Behavior<K extends MachineActivityName> {
	readonly beats?: readonly ActivityHeartbeat<K>[];
	readonly outcome: Outcome<K>;
}

export interface RunOptions {
	/** Cancels a hanging call. Cancellation reaches the activity through this signal only (temporal.md, Activities). */
	readonly signal?: AbortSignal;
}

export interface FakeActivity<K extends MachineActivityName> {
	readonly name: K;
	/** Task queue from the activity catalog: `machine-<id>`, or `machine-<id>-gpu` for RunGpuJob. */
	readonly queue: string | undefined;
	/** Queues behaviors for the next calls, in order. Throws when a behavior breaks the contract (error kind, output, heartbeat). */
	readonly script: (...behaviors: Behavior<K>[]) => void;
	/** Runs the activity. Rejects with a ZodError for an invalid input, before any behavior runs. */
	readonly run: (input: unknown, options?: RunOptions) => Promise<ActivityOutput<K>>;
	/** Calls received, as passed (before validation). */
	readonly calls: () => unknown[];
	/** Heartbeats that passed the contract, in order. */
	readonly heartbeats: () => unknown[];
	/** Calls that ran a behavior; a repeat answered from the key store does not count. */
	readonly executed: () => number;
}

const hang = <T>(name: string, signal: AbortSignal | undefined): Promise<T> => {
	if (signal === undefined) return Promise.reject(new Error(`${name} hangs, but the call has no signal to cancel it`));
	return new Promise<T>((_resolve, reject) => {
		const cancel = (): void => reject(signal.reason ?? new Error(`${name} cancelled`));
		if (signal.aborted) cancel();
		else signal.addEventListener("abort", cancel, { once: true });
	});
};

export const scriptedActivity = <K extends MachineActivityName>(name: K, queue: string | undefined): FakeActivity<K> => {
	const contract = contractOf(name);
	const queued: Behavior<K>[] = [];
	const stored = new Map<string, unknown>();
	const calls: unknown[] = [];
	const heartbeats: unknown[] = [];
	let executed = 0;

	const checkBeat = (beat: unknown): unknown => {
		if (contract.heartbeat === null) throw new Error(`${name} has no heartbeat, so it cannot emit one`);
		return contract.heartbeat.parse(beat);
	};

	const script = (...behaviors: Behavior<K>[]): void => {
		for (const behavior of behaviors) {
			const { outcome } = behavior;
			if (outcome.kind === "fail" && !contract.errors.includes(outcome.error)) {
				throw new Error(`${name} cannot fail with ${outcome.error}: its contract allows ${contract.errors.join(", ")}`);
			}
			if (outcome.kind === "succeed") contract.output.parse(outcome.output);
			for (const beat of behavior.beats ?? []) checkBeat(beat);
		}
		queued.push(...behaviors);
	};

	const run = async (input: unknown, options: RunOptions = {}): Promise<ActivityOutput<K>> => {
		calls.push(input);
		const parsed = contract.input.parse(input);
		const key = contract.key(parsed);
		if (key !== undefined && contract.remember !== null && stored.has(key)) return stored.get(key) as ActivityOutput<K>;

		const behavior: Behavior<K> = queued.shift() ?? { outcome: { kind: "succeed", output: SAMPLE_OUTPUTS[name] } };
		executed += 1;
		for (const beat of behavior.beats ?? []) heartbeats.push(checkBeat(beat));

		const { outcome } = behavior;
		if (outcome.kind === "fail") throw new ActivityError(outcome.error, outcome.message ?? `${name}: scripted ${outcome.error}`);
		if (outcome.kind === "hang") return hang<ActivityOutput<K>>(name, options.signal);
		const output = contract.output.parse(outcome.output) as ActivityOutput<K>;
		if (key !== undefined && contract.remember !== null && contract.remember(output)) stored.set(key, output);
		return output;
	};

	return {
		name,
		queue,
		script,
		run,
		calls: () => [...calls],
		heartbeats: () => [...heartbeats],
		executed: () => executed,
	};
};
