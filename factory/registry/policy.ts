import type { Repo } from "../db/repo/index.ts";

type Registry = Repo["registry"];
type RecordRow = NonNullable<Awaited<ReturnType<Registry["records"]["get"]>>>;
type RecordDraft = Parameters<Registry["records"]["create"]>[0];
type PolicyRecord = Pick<RecordDraft, "id" | "status" | "statusChangedBy" | "authority" | "kind" | "scopeType" |
	"projectId" | "repository" | "machineId" | "action" | "target" | "category" | "problem" | "decision" | "exceptionsText" | "right">;
type Link = Awaited<ReturnType<Registry["links"]["forRecord"]>>[number];

export const sensitiveCategories = Object.freeze(["security", "permissions", "credentials", "publication", "spending", "deletion", "regulation"] as const);
const sensitive = new Set<string>(sensitiveCategories);
const text = (value: string | null | undefined) => (value ?? "").normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
export const isSensitive = (category: string | null) => sensitive.has(text(category));

// G2 and G8 grant automatic activation only to recognizable harmless questions and choices.
// Match the whole phrase so a sensitive instruction appended to a harmless option sends the poll to drafts.
const harmlessPolls = {
	formatting: {
		question: /^(?:(?:use |indent with )?(?:tabs or spaces|spaces or tabs)(?: for indentation)?|(?:how should we indent|what (?:indentation|line endings?) should we use)|(?:lf or crlf|crlf or lf)|(?:\u0442\u0430\u0431\u0443\u043b\u044f\u0446\u0438\u044f \u0438\u043b\u0438 \u043f\u0440\u043e\u0431\u0435\u043b\u044b|\u043f\u0440\u043e\u0431\u0435\u043b\u044b \u0438\u043b\u0438 \u0442\u0430\u0431\u0443\u043b\u044f\u0446\u0438\u044f))\??$/u,
		option: /^(?:(?:use )?(?:tabs|spaces|lf|crlf|\d+ spaces)(?: for indentation)?|\u0442\u0430\u0431\u0443\u043b\u044f\u0446\u0438\u044f|\u043f\u0440\u043e\u0431\u0435\u043b\u044b|\d+ \u043f\u0440\u043e\u0431\u0435\u043b(?:\u0430|\u043e\u0432)?)\.?$/u,
	},
	documentation: {
		question: /^(?:which spelling should we use|(?:us or uk|uk or us|american or british|british or american) spelling|\u043a\u0430\u043a\u043e\u0439 \u0432\u0430\u0440\u0438\u0430\u043d\u0442 \u0430\u043d\u0433\u043b\u0438\u0439\u0441\u043a\u043e\u0433\u043e \u0438\u0441\u043f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u044c)\??$/u,
		option: /^(?:us|uk|american|british)(?: (?:english|spelling))?\.?$/u,
	},
} satisfies Record<string, { question: RegExp; option: RegExp }>;

export function harmlessPoll(category: string | null, question: string, options: readonly string[]): boolean {
	const normalized = text(category);
	if (!Object.hasOwn(harmlessPolls, normalized)) return false;
	const policy = harmlessPolls[normalized as keyof typeof harmlessPolls];
	return policy.question.test(text(question)) && options.every(option => policy.option.test(text(option)));
}

// Executable guards stay in code. These checks recognize proposals to relax them, including structured
// permission actions. Activation never changes the runtime enforcement of confirmations, profiles or allowlists.
const guardRules: readonly [name: string, mentions: RegExp, exemption?: RegExp][] = [
	["second_press", /\b(?:second (?:press|click|approval)|confirmations?|two[- ](?:press(?:es)?|step|factor)|x[- ]confirm|owner(?:'s)? approval)\b|\u0432\u0442\u043e\u0440(?:\u043e\u0435|\u043e\u0433\u043e|\u0443\u044e) (?:\u043d\u0430\u0436\u0430\u0442\u0438|\u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u0438)|\u0434\u0432(?:\u0430|\u0443\u0445) \u043d\u0430\u0436\u0430\u0442\u0438/u,
		/\b(?:(?:one|single|first) (?:press|click|confirmation) (?:is |will be )?(?:enough|sufficient|suffices)|no second (?:press|click|approval|confirmation) (?:is )?(?:needed|required))\b|(?:\u043e\u0434\u043d\u043e\u0433\u043e|\u043f\u0435\u0440\u0432\u043e\u0433\u043e) \u043d\u0430\u0436\u0430\u0442\u0438\u044f \u0434\u043e\u0441\u0442\u0430\u0442\u043e\u0447\u043d\u043e/u],
	["profile", /\b(?:sandbox|(?:permission |execution |sandbox )?profiles?|allowed tools?)\b|(?:\u043f\u0435\u0441\u043e\u0447\u043d\u0438\u0446|\u043f\u0440\u043e\u0444\u0438\u043b)[\u0430-\u044f]*/u,
		/\b(?:unrestricted|unsandboxed) (?:access|execution|profile)\b/u],
	["allowlist", /\b(?:allow[- ]?lists?|allowed (?:repositories|directories|paths|hosts))\b|(?:\u0431\u0435\u043b\u044b\u0439 \u0441\u043f\u0438\u0441\u043e\u043a|\u0441\u043f\u0438\u0441\u043e\u043a \u0440\u0430\u0437\u0440\u0435\u0448[\u0435\u0451]\u043d\u043d\u044b\u0445)/u,
		/\b(?:(?:allow|grant|permit) (?:access to )?(?:any|all) (?:repositories|directories|paths|hosts)|unrestricted (?:repository|directory|path|host|network) access)\b/u],
];
const relaxation = /\b(?:skip(?:ped|ping)?|bypass(?:ed|ing)?|disabl(?:e|ed|ing)|remov(?:e|ed|ing)|ignor(?:e|ed|ing)|waiv(?:e|ed|ing)|overrid(?:e|den|ing)|turn(?:ed)? off|(?:never|do not|no longer) (?:require|enforce|check)|without|optional|(?:not|no longer) (?:needed|required|enforced)|can be omitted|unnecessary)\b|(?:\u043e\u0442\u043a\u043b\u044e\u0447|\u043e\u0431\u043e\u0439\u0442\u0438|\u043e\u0442\u043c\u0435\u043d|\u0438\u0433\u043d\u043e\u0440|\u043d\u0435 \u0442\u0440\u0435\u0431\u0443)/u;
const prohibitsRelaxation = /^(?:(?:never |do not |must not |cannot )(?!require\b|enforce\b|check\b)|no (?:one|agent) (?:may|can) |\u0437\u0430\u043f\u0440\u0435\u0449\u0435\u043d\u043e |\u043d\u0435\u043b\u044c\u0437\u044f )/u;

export function guardConflicts(record: PolicyRecord): string[] {
	const right = record.right;
	const fields = [record.decision, record.exceptionsText, typeof right === "object" && right !== null
		? [Reflect.get(right, "action"), Reflect.get(right, "target")].filter(value => typeof value === "string").join(" ").replace(/[_-]/gu, " ")
		: null];
	const statements = fields.flatMap(value => text(value).split(/[.!?;,]+|\b(?:but|however)\b/u)).filter(part => !prohibitsRelaxation.test(part.trim()));
	return guardRules.filter(([, mentions, exemption]) =>
		statements.some(part => exemption?.test(part) || (mentions.test(part) && relaxation.test(part)))).map(([name]) => name);
}

export const scopeKeys = ["repository", "machineId", "action", "target"] as const;
const overlaps = (a: PolicyRecord, b: PolicyRecord) =>
	(a.scopeType === "global" || b.scopeType === "global" || a.projectId === b.projectId) &&
	scopeKeys.every(key => a[key] == null || b[key] == null || a[key] === b[key]);
const sameScope = (a: PolicyRecord, b: PolicyRecord) =>
	a.scopeType === b.scopeType && a.projectId === b.projectId && scopeKeys.every(key => (a[key] ?? null) === (b[key] ?? null));

export const ownerAuthority = (row: { authority: string | null; statusChangedBy?: unknown }) =>
	row.authority === "owner" || (typeof row.statusChangedBy === "object" && row.statusChangedBy !== null && Reflect.get(row.statusChangedBy, "type") === "owner");

function competingAnswers(a: PolicyRecord, b: PolicyRecord): boolean {
	const question = text(a.problem).replace(/[?.!]+$/u, "");
	const answer = text(a.decision);
	const otherAnswer = text(b.decision);
	return question !== "" && question === text(b.problem).replace(/[?.!]+$/u, "") && answer !== "" && otherAnswer !== "" && answer !== otherAnswer;
}

const replacing = (from: PolicyRecord, to: PolicyRecord, links: readonly Link[]) =>
	links.some(link => link.linkType === "supersedes" && link.fromRecordId === from.id && link.toRecordId === to.id);
const explicitlyConflicts = (a: PolicyRecord, b: PolicyRecord, links: readonly Link[]) =>
	links.some(link => link.linkType === "conflicts_with" && ((link.fromRecordId === a.id && link.toRecordId === b.id) ||
		(link.fromRecordId === b.id && link.toRecordId === a.id)));

export async function recordConflicts(registry: Registry, candidate: PolicyRecord, links: readonly Link[], replaced: readonly string[] = []): Promise<string[]> {
	const active = await registry.records.list({ status: "active" });
	const exceptionTargets = new Set(links.filter(link => link.linkType === "exception_to" && link.fromRecordId === candidate.id).map(link => link.toRecordId));
	const conflicts = [];
	for (const other of active) {
		if (other.id === candidate.id || replaced.includes(other.id) || replacing(candidate, other, links)) continue;
		if (explicitlyConflicts(candidate, other, links)) {
			conflicts.push(other.id);
			continue;
		}
		if (candidate.kind !== other.kind || !ownerAuthority(other) || !sameScope(candidate, other) || !competingAnswers(candidate, other)) continue;
		if (candidate.kind === "decision" || (candidate.kind === "exception" && exceptionTargets.size &&
			(await registry.links.forRecord(other.id)).some(link => link.linkType === "exception_to" &&
				link.fromRecordId === other.id && exceptionTargets.has(link.toRecordId)))) conflicts.push(other.id);
	}
	return conflicts;
}

export type ConflictReport = { guards: string[]; records: string[] };

export async function regulationConflicts(registry: Registry, clauses: readonly RecordRow[]): Promise<ConflictReport> {
	if (clauses.length === 0) return { guards: [], records: [] };
	const active = (await registry.records.list({ status: "active" })).filter(row => row.kind === "rule" ||
		(row.kind === "decision" && ownerAuthority(row)));
	const guards = new Set<string>();
	const records = new Set<string>();
	for (const clause of clauses) {
		for (const guard of guardConflicts(clause)) guards.add(guard);
		const links = await registry.links.forRecord(clause.id);
		for (const other of clauses) {
			if (other.id !== clause.id && (explicitlyConflicts(clause, other, links) ||
				(sameScope(clause, other) && competingAnswers(clause, other)))) records.add(other.id);
		}
		for (const other of active) {
			const replaced = other.kind === "rule" && !clauses.some(retained => retained.id === other.id) && replacing(clause, other, links);
			if (other.id !== clause.id && !replaced && (explicitlyConflicts(clause, other, links) ||
				(other.kind === "rule" ? sameScope(clause, other) : overlaps(clause, other)) && competingAnswers(clause, other))) {
				records.add(other.id);
			}
		}
	}
	return { guards: [...guards].sort(), records: [...records].sort() };
}
