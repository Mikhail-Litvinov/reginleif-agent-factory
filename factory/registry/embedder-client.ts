import { randomUUID } from "node:crypto";
import type { Repo } from "../db/repo/index.ts";

export type EmbedderResponse = { model: string; revision: string; sha256: string; vectors: number[][] };
export type EmbedderTransport = (texts: string[]) => Promise<EmbedderResponse>;

export function httpEmbedderTransport(url: string, fetcher: typeof fetch = fetch): EmbedderTransport {
	return async texts => {
		const response = await fetcher(new URL("/embed", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ texts }) });
		if (!response.ok) throw new Error(`embedder HTTP ${response.status}`);
		return await response.json() as EmbedderResponse;
	};
}

export function createEmbedderClient(repo: Pick<Repo, "transaction">, transport: EmbedderTransport, clock: () => Date = () => new Date()) {
	async function embed(texts: string[], version: string) {
		const result = await transport(texts);
		if (result.revision !== version || !result.model || !result.sha256 || result.vectors.length !== texts.length || result.vectors.some(v => !Array.isArray(v) || v.length !== 1024 || v.some(n => !Number.isFinite(n)))) throw new Error("invalid embedder response or model version");
		return result.vectors;
	}
	return {
		embed,
		async store(recordId: string, text: string, version: string): Promise<void> {
			const vectors = await embed([text], version);
			await repo.transaction(async tx => {
				await tx.registry.embeddings.create({ id: randomUUID(), recordId, modelVersion: version, dimensions: 1024, embedding: vectors[0]!, createdAt: clock() });
			});
		},
		async reembedBatch(version: string, limit: number): Promise<number> {
			if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("batch size must be positive");
			return repo.transaction(async tx => {
				await tx.registry.embeddings.lockReembedding();
				const rows = await tx.registry.embeddings.pendingReembedding(version, limit);
				if (!rows.length) return 0;
				const vectors = await embed(rows.map(row => row.text), version);
				for (let i = 0; i < rows.length; i++) await tx.registry.embeddings.create({ id: randomUUID(), recordId: rows[i]!.id, modelVersion: version, dimensions: 1024, embedding: vectors[i]!, createdAt: clock() });
				return rows.length;
			});
		},
		async reembedAll(version: string, limit: number): Promise<number> {
			let total = 0;
			for (;;) {
				const count = await this.reembedBatch(version, limit);
				total += count;
				if (count === 0) return total;
			}
		},
		startBackground(version: string, limit: number, intervalMs: number, options: { schedule?: (callback: () => void, ms: number) => () => void; onError: (error: unknown) => void }): () => void {
			if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new RangeError("interval must be positive");
			const schedule = options.schedule ?? ((callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); });
			let stopped = false;
			let cancel: () => void = () => {};
			const tick = () => {
				void this.reembedAll(version, limit).catch(options.onError).finally(() => { if (!stopped) cancel = schedule(tick, intervalMs); });
			};
			cancel = schedule(tick, 0);
			return () => { stopped = true; cancel(); };
		},
	};
}
