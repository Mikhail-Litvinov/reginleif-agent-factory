export const streams = ["task_events", "audit_log", "notifications", "messages"] as const;
export type Stream = typeof streams[number];
export type StreamPosition = { commitXid: string; seq: bigint };
export type StreamRow = StreamPosition;

export class BadCursorError extends Error {
	readonly code = "bad_cursor";
	readonly status = 400;
	constructor() { super("Invalid cursor"); }
}

const unsigned = /^(0|[1-9][0-9]*)$/;
const validPosition = (xid: unknown, seq: unknown): xid is string =>
	typeof xid === "string" && typeof seq === "string" && unsigned.test(xid) && unsigned.test(seq) &&
	xid.length <= 20 && seq.length <= 19 && BigInt(xid) <= 18446744073709551615n && BigInt(seq) <= 9223372036854775807n && BigInt(seq) > 0n;

export function encodeCursor(stream: Stream, position: StreamPosition): string {
	const seq = String(position.seq);
	if (!streams.includes(stream) || !validPosition(position.commitXid, seq)) throw new BadCursorError();
	return Buffer.from(JSON.stringify([1, stream, position.commitXid, seq])).toString("base64url");
}

export function decodeCursor(stream: Stream, cursor: string): StreamPosition {
	try {
		if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 256) throw new BadCursorError();
		const bytes = Buffer.from(cursor, "base64url");
		if (bytes.toString("base64url") !== cursor) throw new BadCursorError();
		const value: unknown = JSON.parse(bytes.toString("utf8"));
		if (!Array.isArray(value) || value.length !== 4 || value[0] !== 1 || value[1] !== stream || !streams.includes(stream) || !validPosition(value[2], value[3])) throw new BadCursorError();
		return { commitXid: value[2], seq: BigInt(value[3]) };
	} catch { throw new BadCursorError(); }
}

export type StreamSource<T extends StreamRow> = {
	snapshotXmin(): Promise<string>;
	list(bounds: { below: string; after?: StreamPosition; limit: number }): Promise<T[]>;
};

export async function readStreamPage<T extends StreamRow>(stream: Stream, source: StreamSource<T>, options: { cursor?: string; limit: number }): Promise<{ items: T[]; next_cursor: string | null }> {
	const after = options.cursor === undefined ? undefined : decodeCursor(stream, options.cursor);
	const below = await source.snapshotXmin();
	const items = await source.list({ below, after, limit: options.limit });
	const last = items.at(-1);
	return { items, next_cursor: last ? encodeCursor(stream, last) : options.cursor ?? null };
}

// Filters stay in their repository; all streams share the same horizon and cursor rules.
export function streamSource(repo: import("../db/repo/index.ts").Repo, stream: Stream, filters: { taskId?: string; runId?: string; type?: string; conversationId?: string; actorId?: string; action?: string; targetId?: string } = {}): StreamSource<StreamRow & { id: string }> {
	const snapshotXmin = () => repo.audit.snapshotXmin();
	switch (stream) {
		case "task_events": return { snapshotXmin, list: bounds => repo.taskEvents.stream({ ...bounds, taskId: filters.taskId, runId: filters.runId, type: filters.type }) };
		case "audit_log": return { snapshotXmin, list: bounds => repo.audit.list({ ...bounds, actorId: filters.actorId, action: filters.action, targetId: filters.targetId }) };
		case "notifications": return { snapshotXmin, list: bounds => repo.notifications.stream(bounds) };
		case "messages": return { snapshotXmin, list: bounds => repo.messages.stream({ ...bounds, conversationId: filters.conversationId }) };
	}
}
