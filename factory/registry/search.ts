import type { Repo } from "../db/repo/index.ts";

type Registry = Repo["registry"];
type Filters = { projectId?: string; category?: string; kind?: string; status?: string; scopeType?: string };
type Input = Filters & { query: string; limit?: number };
type Hit = Awaited<ReturnType<Registry["records"]["searchFullText"]>>[number];
type Ranking = "fulltext" | "trigram" | "vector";
export type Embedder = (text: string) => Promise<number[] | undefined | null> | number[] | undefined | null;

// Defaults measured in docs/reports/registry-search-measurement.md.
const defaults = { text: 0.025, trigram: 0.1846, vector: 0.47, model: "5617a9f61b028005a4858fdac845db406aefb181", limit: 5 };
const keys = ["registry.textThreshold", "registry.trigramThreshold", "registry.vectorThreshold", "registry.embeddingModel", "registry.searchLimit"] as const;

export function createRegistrySearch(repo: Pick<Repo, "registry" | "settings">, embed: Embedder) {
	return async (input: Input) => {
		const settings = await repo.settings.snapshot(keys);
		const number = (key: string, fallback: number) => typeof settings[key] === "number" && Number.isFinite(settings[key]) ? settings[key] as number : fallback;
		const limit = input.limit ?? number(keys[4], defaults.limit);
		if (!Number.isInteger(limit) || limit < 1) throw new RangeError("search limit must be a positive integer");
		const model = typeof settings[keys[3]] === "string" ? settings[keys[3]] as string : defaults.model;
		const common = { ...input, status: input.status ?? "active", reuse: "standing", limit };
		const embedding = await embed(input.query);
		const degraded = embedding == null;
		const [ru, en, trigrams, vectors] = await Promise.all([
			repo.registry.records.searchFullText({ ...common, threshold: number(keys[0], defaults.text), language: "ru" }),
			repo.registry.records.searchFullText({ ...common, threshold: number(keys[0], defaults.text), language: "en" }),
			repo.registry.records.searchTrigram({ ...common, threshold: number(keys[1], defaults.trigram) }),
			embedding == null ? Promise.resolve([]) : repo.registry.embeddings.searchVector({ ...common, threshold: number(keys[2], defaults.vector), embedding, modelVersion: model }),
		]);
		// Scores have different scales; vector and text take precedence over the typo fallback.
		const merged = new Map<string, { record: Hit["record"]; score: number; ranking: Ranking; matchedFields: string[] }>();
		for (const [ranking, hits] of [["vector", vectors], ["fulltext", ru], ["fulltext", en], ["trigram", trigrams]] as [Ranking, Hit[]][]) {
			for (const hit of hits) {
				const previous = merged.get(hit.record.id);
				if (!previous) merged.set(hit.record.id, { ...hit, ranking });
				else {
					previous.matchedFields = [...new Set([...previous.matchedFields, ...hit.matchedFields])];
					if (previous.ranking === ranking && hit.score > previous.score) previous.score = hit.score;
				}
			}
		}
		const priority: Record<Ranking, number> = { vector: 0, fulltext: 1, trigram: 2 };
		const items = [...merged.values()].sort((a, b) => priority[a.ranking] - priority[b.ranking] || b.score - a.score || a.record.id.localeCompare(b.record.id)).slice(0, limit);
		return { items, degraded };
	};
}
