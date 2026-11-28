// The contract range of the workers: a worker may take work when its contract version is the current one, or the one before
// it when the current is above 1. Outside the range the API answers 426 contract_unsupported (api/handlers/tasks.ts), and the
// liveness pass shows the worker as `outdated`. The API header check and the liveness pass share this one rule.

/**
 * True when a worker on `version` may take work at the `current` contract. `version` is the `x-factory-contract` header or the
 * worker row's contract_version. An absent value (no header, no recorded version) is not supported.
 */
export const isContractSupported = (version: string | number | null | undefined, current: number): boolean => {
	if (version === null || version === undefined) return false;
	const text = String(version);
	return text === String(current) || (current > 1 && text === String(current - 1));
};
