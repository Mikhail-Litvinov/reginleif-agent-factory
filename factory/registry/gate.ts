import { randomUUID } from "node:crypto";
import type { Repo } from "../db/repo/index.ts";
import type { createRegistrySearch } from "./search.ts";

type Registry = Pick<Repo, "registry">;
type Search = ReturnType<typeof createRegistrySearch>;
type Actor = { tokenId: string; sessionRef?: string | null; runId?: string | null };
type Timer = { set: (callback: () => void, milliseconds: number) => unknown; clear: (handle: any) => void };
type Options = {
	// timeoutMs comes from the caller's registry.gateTimeoutMs setting snapshot.
	timeoutMs: number;
	timer?: Timer;
	// The caller records this locally, so an unavailable registry cannot prevent fail-open.
	recordFailOpen: (event: { inquiryId: string; reason: "timeout" | "unavailable" }) => void;
};
const systemTimer: Timer = { set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle) };

export function createRegistryGate(repo: Registry, search: Search, options: Options) {
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new RangeError("registry.gateTimeoutMs must be positive");
	const timer = options.timer ?? systemTimer;
	return async (actor: Actor, input: { inquiryId: string; question: string }) => {
		let expired = false;
		let handle: unknown;
		const timeout = new Promise<{ pass: true }>(resolve => {
			handle = timer.set(() => {
				expired = true;
				options.recordFailOpen({ inquiryId: input.inquiryId, reason: "timeout" });
				resolve({ pass: true });
			}, options.timeoutMs);
		});
		const check = async () => {
			const inquiry = await repo.registry.inquiries.get(input.inquiryId);
			if (!inquiry || inquiry.tokenId !== actor.tokenId || (inquiry.sessionRef ?? null) !== (actor.sessionRef ?? null) || (inquiry.runId ?? null) !== (actor.runId ?? null)) return { pass: false as const, records: [] };
			const results = await repo.registry.results.forInquiry(inquiry.id);
			const found = await search({ query: input.question, ...(inquiry.projectId ? { projectId: inquiry.projectId } : {}) });
			if (expired) return { pass: true as const };
			const byId = new Map(results.map(result => [result.recordId, result]));
			const blocked = new Map<string, Awaited<ReturnType<typeof repo.registry.records.get>>>();
			for (const result of results) {
				if (result.recordId && (result.verdict == null || result.verdict === "applies")) {
					const record = await repo.registry.records.get(result.recordId);
					if (!record) throw new Error("inquiry record missing");
					blocked.set(record.id, record);
				}
			}
			for (const hit of found.items) {
				if (byId.has(hit.record.id)) continue;
				if (expired) return { pass: true as const };
				await repo.registry.results.create({ id: randomUUID(), inquiryId: inquiry.id, recordId: hit.record.id, recordVersion: hit.record.version, foundBy: "gate", ranking: hit.ranking, score: String(hit.score), matchedFields: hit.matchedFields });
				blocked.set(hit.record.id, hit.record);
			}
			return blocked.size ? { pass: false as const, records: [...blocked.values()] } : { pass: true as const };
		};
		try {
			return await Promise.race([check().catch(() => {
				if (!expired) options.recordFailOpen({ inquiryId: input.inquiryId, reason: "unavailable" });
				return { pass: true as const };
			}), timeout]);
		} finally { timer.clear(handle); }
	};
}
