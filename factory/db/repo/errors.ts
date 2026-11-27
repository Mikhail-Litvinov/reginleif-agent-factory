// The one place where a database refusal leaves the repo boundary. drizzle wraps the driver error in
// "Failed query: ..." and keeps the PostgreSQL error (SQLSTATE, the trigger's text) on `cause`; the migrations
// raise every refusal with RAISE EXCEPTION, which is SQLSTATE P0001 with the reason as the message.

const RAISE_EXCEPTION = "P0001";

// A versioned write found no row at the version the caller read: the row changed, or never existed.
export class StaleVersionError extends Error {
	readonly subject: string;
	readonly expectedVersion: bigint;
	readonly currentVersion?: bigint;
	constructor(subject: string, expectedVersion: bigint, currentVersion?: bigint) {
		super([subject, "is not at version", String(expectedVersion)].join(" "));
		this.name = "StaleVersionError";
		this.subject = subject;
		this.expectedVersion = expectedVersion;
		this.currentVersion = currentVersion;
	}
}

export class RepositoryNotFoundError extends Error {
	constructor(subject: string) { super([subject, "was not found"].join(" ")); this.name = "RepositoryNotFoundError"; }
}

export const versionedUpdate = async <T extends { rowVersion: bigint }>(input: {
	subject: string;
	expectedVersion: bigint;
	update: () => Promise<T | undefined>;
	current: () => Promise<{ rowVersion: bigint } | undefined>;
}): Promise<T | null> => {
	const updated = await input.update();
	if (updated) return updated;
	const current = await input.current();
	if (!current) return null;
	throw new StaleVersionError(input.subject, input.expectedVersion, current.rowVersion);
};

export interface DatabaseRefusal { reason: string; sqlstate: string }

export const driverError = (error: unknown): { code: string; message: string } | undefined => {
	for (let current: unknown = error, depth = 0; typeof current === "object" && current !== null && depth < 8; depth++) {
		const candidate = current as { code?: unknown; message?: unknown; cause?: unknown };
		if (typeof candidate.code === "string" && /^[0-9A-Z]{5}$/.test(candidate.code) && typeof candidate.message === "string") {
			return { code: candidate.code, message: candidate.message };
		}
		current = candidate.cause;
	}
	return undefined;
};

export const databaseRefusal = (error: unknown): DatabaseRefusal | undefined => {
	const driver = driverError(error);
	return driver?.code === RAISE_EXCEPTION ? { reason: driver.message, sqlstate: driver.code } : undefined;
};

export const databaseUnavailable = (error: unknown): boolean => {
	let current = error;
	for (let depth = 0; current && typeof current === 'object' && depth < 8; depth++) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === 'string' && (/^08\w{3}$|^57P0[123]$/.test(code) ||
			['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED'].includes(code))) return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
};

// Runs a repo operation; a database refusal becomes the typed error `make` builds, anything else passes through.
export const refusing = async <T>(make: (reason: string) => Error, operation: () => Promise<T>): Promise<T> => {
	try {
		return await operation();
	} catch (error) {
		const refusal = databaseRefusal(error);
		if (refusal) throw make(refusal.reason);
		throw error;
	}
};
