import { and, asc, desc, eq, gte, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { auditLog } from "../schema/audit-log.ts";
import { registryEmbeddings, registryInquiryResults, registryInquiries, registryLinks, registryRecords, regulationVersions } from "../schema/registry.ts";
import { refusing } from "./errors.ts";

type RegulationInsert = typeof regulationVersions.$inferInsert;
type Regulation = typeof regulationVersions.$inferSelect;
type InquiryInsert = typeof registryInquiries.$inferInsert;
type Inquiry = typeof registryInquiries.$inferSelect;
type RecordInsert = typeof registryRecords.$inferInsert;
type Record = typeof registryRecords.$inferSelect;
type RecordContentPatch = Partial<Omit<RecordInsert, "id" | "number" | "status" | "statusChangedAt" | "statusChangedBy" | "consumedAt" | "createdAt" | "searchRu" | "searchEn">>;
type LinkInsert = typeof registryLinks.$inferInsert;
type Link = typeof registryLinks.$inferSelect;
type EmbeddingInsert = typeof registryEmbeddings.$inferInsert;
type Embedding = typeof registryEmbeddings.$inferSelect;
type ResultInsert = typeof registryInquiryResults.$inferInsert;
type Result = typeof registryInquiryResults.$inferSelect;

export class RegistryRefusedError extends Error {
	readonly name = "RegistryRefusedError";
	readonly reason: string;
	constructor(reason: string) { super(reason); this.reason = reason; }
}

type SearchFilters = { projectId?: string; category?: string; kind?: string; status?: string; scopeType?: string; reuse?: string };
type SearchInput = SearchFilters & { query: string; limit: number; threshold: number };
type SearchHit = { record: Record; score: number; matchedFields: string[] };

const recordFilters = (filters: SearchFilters): SQL[] => {
	const conditions: SQL[] = [];
	if (filters.projectId !== undefined) conditions.push(or(eq(registryRecords.scopeType, "global"), eq(registryRecords.projectId, filters.projectId))!);
	if (filters.category !== undefined) conditions.push(eq(registryRecords.category, filters.category));
	if (filters.kind !== undefined) conditions.push(eq(registryRecords.kind, filters.kind));
	if (filters.status !== undefined) conditions.push(eq(registryRecords.status, filters.status));
	if (filters.scopeType !== undefined) conditions.push(eq(registryRecords.scopeType, filters.scopeType));
	if (filters.reuse !== undefined) conditions.push(eq(registryRecords.reuse, filters.reuse));
	return conditions;
};

export const registryRepo = (db: PostgresJsDatabase<any>) => ({
	// Shared by all service operations that make decisions against active records and regulation.
	lock: async (mode: "read" | "write" = "write"): Promise<void> => {
		const key = "factory:registry";
		await db.execute(mode === "read"
			? sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`
			: sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
	},
	regulations: {
		create: async (input: RegulationInsert): Promise<Regulation> => refusing((reason) => new RegistryRefusedError(reason), async () =>
			(await db.insert(regulationVersions).values(input).returning())[0]!),
		get: async (id: string): Promise<Regulation | undefined> =>
			(await db.select().from(regulationVersions).where(eq(regulationVersions.id, id)).limit(1))[0],
		nextNumber: async (): Promise<number> =>
			(await db.select({ number: sql`coalesce(max(${regulationVersions.number}), 0) + 1`.mapWith(Number) }).from(regulationVersions))[0]!.number,
		list: async ({ status, limit }: { status?: string; limit?: number } = {}): Promise<Regulation[]> => {
			const query = db.select().from(regulationVersions).where(status === undefined ? undefined : eq(regulationVersions.status, status))
				.orderBy(desc(regulationVersions.number));
			return limit === undefined ? query : query.limit(limit);
		},
		active: async (): Promise<Regulation | undefined> =>
			(await db.select().from(regulationVersions).where(eq(regulationVersions.status, "active")).limit(1))[0],
		changeStatus: async (id: string, patch: Pick<RegulationInsert, "status" | "statusChangedAt"> & Partial<Pick<RegulationInsert, "conflictReport" | "confirmedBy" | "confirmationId" | "activatedAt">>): Promise<Regulation | null> =>
			refusing((reason) => new RegistryRefusedError(reason), async () =>
				(await db.update(regulationVersions).set(patch).where(eq(regulationVersions.id, id)).returning())[0] ?? null),
		history: async (id: string) => db.select().from(auditLog).where(and(eq(auditLog.targetType, "regulation_versions"), eq(auditLog.targetId, id), eq(auditLog.action, "regulation.status"))).orderBy(asc(auditLog.createdAt), asc(auditLog.seq)),
	},
	inquiries: {
		create: async (input: InquiryInsert): Promise<Inquiry> => refusing((reason) => new RegistryRefusedError(reason), async () =>
			(await db.insert(registryInquiries).values(input).returning())[0]!),
		get: async (id: string): Promise<Inquiry | undefined> =>
			(await db.select().from(registryInquiries).where(eq(registryInquiries.id, id)).limit(1))[0],
		list: async ({ tokenId, runId, sessionRef, limit }: { tokenId?: string; runId?: string; sessionRef?: string; limit?: number } = {}): Promise<Inquiry[]> => {
			const conditions: SQL[] = [];
			if (tokenId !== undefined) conditions.push(eq(registryInquiries.tokenId, tokenId));
			if (runId !== undefined) conditions.push(eq(registryInquiries.runId, runId));
			if (sessionRef !== undefined) conditions.push(eq(registryInquiries.sessionRef, sessionRef));
			const query = db.select().from(registryInquiries).where(and(...conditions)).orderBy(desc(registryInquiries.createdAt), desc(registryInquiries.number));
			return limit === undefined ? query : query.limit(limit);
		},
		registerPoll: async (id: string, poll: Pick<InquiryInsert, "pollQuestion" | "pollOptions" | "pollRegisteredAt">): Promise<Inquiry | null> =>
			refusing((reason) => new RegistryRefusedError(reason), async () =>
				(await db.update(registryInquiries).set(poll).where(and(eq(registryInquiries.id, id), isNull(registryInquiries.pollRegisteredAt))).returning())[0] ?? null),
	},
	records: {
		create: async (input: RecordInsert): Promise<Record> => refusing((reason) => new RegistryRefusedError(reason), async () =>
			(await db.insert(registryRecords).values(input).returning())[0]!),
		createImportedIfAbsent: async (input: RecordInsert): Promise<{ record: Record; inserted: boolean }> => refusing((reason) => new RegistryRefusedError(reason), async () => {
			const inserted = (await db.insert(registryRecords).values(input).onConflictDoNothing({ target: registryRecords.id }).returning())[0];
			if (inserted) return { record: inserted, inserted: true };
			const existing = (await db.select().from(registryRecords).where(eq(registryRecords.id, input.id)).limit(1))[0];
			if (!existing) throw new RegistryRefusedError("import_conflict_missing");
			return { record: existing, inserted: false };
		}),
		get: async (id: string): Promise<Record | undefined> =>
			(await db.select().from(registryRecords).where(eq(registryRecords.id, id)).limit(1))[0],
		ruleIds: async (ids: string[]): Promise<string[]> =>
			(await db.select({ id: registryRecords.id }).from(registryRecords)
				.where(and(eq(registryRecords.kind, "rule"), inArray(registryRecords.id, ids)))).map(row => row.id),
		captureByPress: async (pressId: string): Promise<Record | undefined> =>
			(await db.select().from(registryRecords).where(eq(registryRecords.pressId, pressId)).limit(1))[0],
		captureByInquiry: async (inquiryId: string): Promise<Record | undefined> =>
			(await db.select().from(registryRecords).where(and(eq(registryRecords.inquiryId, inquiryId), eq(registryRecords.source, "poll_press"))).limit(1))[0],
		byNumber: async (number: bigint): Promise<Record | undefined> =>
			(await db.select().from(registryRecords).where(eq(registryRecords.number, number)).limit(1))[0],
		list: async ({ projectId, category, kind, status, scopeType, source, limit }: SearchFilters & { source?: string; limit?: number } = {}): Promise<Record[]> => {
			const conditions = recordFilters({ projectId, category, kind, status, scopeType });
			if (source !== undefined) conditions.push(eq(registryRecords.source, source));
			const query = db.select().from(registryRecords).where(and(...conditions)).orderBy(desc(registryRecords.createdAt), desc(registryRecords.number));
			return limit === undefined ? query : query.limit(limit);
		},
		updateContent: async (id: string, patch: RecordContentPatch): Promise<Record | null> =>
			refusing((reason) => new RegistryRefusedError(reason), async () =>
				(await db.update(registryRecords).set(patch).where(eq(registryRecords.id, id)).returning())[0] ?? null),
		changeStatus: async (id: string, status: string, statusChangedAt: Date, statusChangedBy: unknown): Promise<Record | null> =>
			refusing((reason) => new RegistryRefusedError(reason), async () =>
				(await db.update(registryRecords).set({ status, statusChangedAt, statusChangedBy }).where(eq(registryRecords.id, id)).returning())[0] ?? null),
		consumePermission: async (id: string, consumedAt: Date): Promise<Record | null> =>
			refusing((reason) => new RegistryRefusedError(reason), async () =>
				(await db.update(registryRecords).set({ consumedAt }).where(and(eq(registryRecords.id, id), eq(registryRecords.kind, "permission"), eq(registryRecords.reuse, "once"), isNull(registryRecords.consumedAt))).returning())[0] ?? null),
		history: async (id: string) => db.select().from(auditLog).where(and(eq(auditLog.targetType, "registry_records"), eq(auditLog.targetId, id), eq(auditLog.action, "registry.status"))).orderBy(asc(auditLog.createdAt), asc(auditLog.seq)),
		searchFullText: async (input: SearchInput & { language: "ru" | "en" }): Promise<SearchHit[]> => {
			const vector = input.language === "ru" ? registryRecords.searchRu : registryRecords.searchEn;
			const config = input.language === "ru" ? "russian" : "english";
			const query = sql`replace(plainto_tsquery(${config}::regconfig, ${input.query})::text, ' & ', ' | ')::tsquery`;
			const score = sql<number>`ts_rank(${vector}, ${query}, 32)`;
			const fields = [["problem", registryRecords.problem], ["decision", registryRecords.decision], ["exceptions_text", registryRecords.exceptionsText], ["grounds", registryRecords.grounds], ["consequences", registryRecords.consequences], ["question", registryRecords.question], ["summary", registryRecords.summary]] as const;
			const matchedFields = sql<string[]>`array_remove(ARRAY[${sql.join(fields.map(([name, column]) => sql`CASE WHEN to_tsvector(${config}::regconfig, coalesce(${column}, '')) @@ ${query} THEN ${name} END`), sql`, `)}], NULL)`;
			return db.select({ record: registryRecords, score, matchedFields }).from(registryRecords)
				.where(and(...recordFilters(input), sql`${vector} @@ ${query}`, gte(score, input.threshold)))
				.orderBy(desc(score), asc(registryRecords.id)).limit(input.limit);
		},
		searchTrigram: async (input: SearchInput): Promise<SearchHit[]> => {
			// The same passage the threshold was measured on (docs/reports/registry-search-measurement.md, trigram row):
			// similarity over problem, decision and summary joined by a space. matchedFields lists the fields sharing a trigram with the query.
			const score = sql<number>`similarity(concat_ws(' ', ${registryRecords.problem}, ${registryRecords.decision}, ${registryRecords.summary}), ${input.query})`;
			const matchedFields = sql<string[]>`array_remove(ARRAY[CASE WHEN similarity(coalesce(${registryRecords.problem}, ''), ${input.query}) > 0 THEN 'problem' END, CASE WHEN similarity(coalesce(${registryRecords.decision}, ''), ${input.query}) > 0 THEN 'decision' END, CASE WHEN similarity(coalesce(${registryRecords.summary}, ''), ${input.query}) > 0 THEN 'summary' END], NULL)`;
			return db.select({ record: registryRecords, score, matchedFields }).from(registryRecords)
				.where(and(...recordFilters(input), gte(score, input.threshold)))
				.orderBy(desc(score), asc(registryRecords.id)).limit(input.limit);
		},
	},
	links: {
		create: async (input: LinkInsert): Promise<Link> => refusing((reason) => new RegistryRefusedError(reason), async () =>
			(await db.insert(registryLinks).values(input).returning())[0]!),
		forRecord: async (recordId: string): Promise<Link[]> =>
			db.select().from(registryLinks).where(or(eq(registryLinks.fromRecordId, recordId), eq(registryLinks.toRecordId, recordId)))
				.orderBy(asc(registryLinks.createdAt), asc(registryLinks.id)),
	},
	embeddings: {
		create: async (input: EmbeddingInsert): Promise<Embedding> => refusing((reason) => new RegistryRefusedError(reason), async () =>
			(await db.insert(registryEmbeddings).values(input).returning())[0]!),
		forRecord: async (recordId: string, modelVersion?: string): Promise<Embedding[]> =>
			db.select().from(registryEmbeddings).where(and(eq(registryEmbeddings.recordId, recordId), ...(modelVersion === undefined ? [] : [eq(registryEmbeddings.modelVersion, modelVersion)])))
				.orderBy(asc(registryEmbeddings.modelVersion)),
		searchVector: async (input: SearchInput & { embedding: number[]; modelVersion: string }): Promise<SearchHit[]> => {
			// postgres-js sends number[] as float8[], which has no <=> operator; bind the vector literal text and cast it.
			const distance = sql<number>`${registryEmbeddings.embedding} <=> ${JSON.stringify(input.embedding)}::vector`;
			const score = sql<number>`1 - (${distance})`;
			return db.select({ record: registryRecords, score, matchedFields: sql<string[]>`ARRAY[]::text[]` }).from(registryEmbeddings)
				.innerJoin(registryRecords, eq(registryRecords.id, registryEmbeddings.recordId))
				.where(and(eq(registryEmbeddings.modelVersion, input.modelVersion), ...recordFilters(input), gte(score, input.threshold)))
				.orderBy(desc(score), asc(registryRecords.id)).limit(input.limit);
		},
	},
	results: {
		create: async (input: ResultInsert): Promise<Result> => refusing((reason) => new RegistryRefusedError(reason), async () =>
			(await db.insert(registryInquiryResults).values(input).returning())[0]!),
		forInquiry: async (inquiryId: string): Promise<Result[]> =>
			db.select().from(registryInquiryResults).where(eq(registryInquiryResults.inquiryId, inquiryId)).orderBy(asc(registryInquiryResults.ranking), desc(registryInquiryResults.score), asc(registryInquiryResults.recordId)),
		setVerdict: async (id: string, verdict: Pick<ResultInsert, "verdict" | "difference" | "conflictsWithId" | "verdictAt">): Promise<Result | null> =>
			refusing((reason) => new RegistryRefusedError(reason), async () =>
				(await db.update(registryInquiryResults).set(verdict).where(and(eq(registryInquiryResults.id, id), isNull(registryInquiryResults.verdict))).returning())[0] ?? null),
	},
});

export type RegistryRepository = ReturnType<typeof registryRepo>;
