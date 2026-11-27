import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Repo } from "../db/repo/index.ts";

type RegistryRecordInput = Parameters<Repo["registry"]["records"]["create"]>[0];
export type RegistryImportSource = { path: string; rootPath: string; projectId?: string };
export type RegistryImportResult = { added: number; records: RegistryRecordInput[] };

type Section = { title: string | null; text: string; startLine: number; endLine: number; authority: "owner" | "agent" };

// Identity covers everything that owns the record: scope, project, source authority, path and text.
const stableId = (owner: { scopeType: string; projectId: string | null; authority: string }, relativePath: string, text: string): string => {
	const normalizedText = text.normalize("NFC").replace(/\s+/gu, " ").trim();
	const key = ["registry-import", owner.scopeType, owner.projectId ?? "", owner.authority, relativePath, normalizedText].join("\0");
	const bytes = createHash("sha256").update(key).digest().subarray(0, 16);
	bytes[6] = (bytes[6]! & 0x0f) | 0x50;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const sections = (content: string): Section[] => {
	const lines = content.split(/\r?\n/u);
	const starts: { line: number; title: string | null }[] = [];
	for (let index = 0; index < lines.length; index++) {
		const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(lines[index]!);
		if (match) starts.push({ line: index + 1, title: match[2]!.trim() });
	}
	const boundaries = starts.length ? [{ line: 1, title: null }, ...starts] : [{ line: 1, title: null }];
	const result: Section[] = [];
	for (let index = 0; index < boundaries.length; index++) {
		const current = boundaries[index]!;
		const next = boundaries[index + 1];
		const raw = lines.slice(current.line - 1, (next?.line ?? lines.length + 1) - 1);
		let first = 0;
		let last = raw.length - 1;
		while (first <= last && !raw[first]!.trim()) first++;
		while (last >= first && !raw[last]!.trim()) last--;
		if (first > last) continue;
		const startLine = current.line + first;
		const endLine = current.line + last;
		result.push({ title: current.title, text: raw.slice(first, last + 1).join("\n"), startLine, endLine, authority: "agent" });
	}
	return result;
};

const decisionTableRows = (content: string): Section[] => {
	const lines = content.split(/\r?\n/u);
	const result: Section[] = [];
	for (let index = 0; index < lines.length - 2; index++) {
		const header = lines[index]!.trim();
		if (!header.startsWith("|") || !header.endsWith("|")) continue;
		const headers = header.slice(1, -1).split("|").map(cell => cell.trim().toLowerCase());
		const decisionColumn = headers.indexOf("decision");
		const sourceColumn = headers.indexOf("source");
		if (headers[0] !== "#" || decisionColumn < 1) continue;
		const separator = lines[index + 1]!.trim();
		if (!separator.startsWith("|") || !separator.endsWith("|") || !separator.slice(1, -1).split("|").every(cell => /^\s*:?-{3,}:?\s*$/u.test(cell))) continue;
		for (index += 2; index < lines.length; index++) {
			const row = lines[index]!.trim();
			if (!row.startsWith("|") || !row.endsWith("|")) break;
			const cells = row.slice(1, -1).split("|").map(cell => cell.trim());
			const id = cells[0];
			const decision = cells[decisionColumn];
			if (!id || !/^[A-Z]{0,4}\d{1,3}$/u.test(id) || !decision) continue;
			const source = sourceColumn < 0 ? "" : cells[sourceColumn] ?? "";
			const authority = /^owner(?:$|[; (])/iu.test(source) ? "owner" : "agent";
			result.push({ title: id, text: decision, startLine: index + 1, endLine: index + 1, authority });
		}
	}
	return result;
};

export async function importRegistryDrafts(repo: Pick<Repo, "registry">, sources: readonly RegistryImportSource[]): Promise<RegistryImportResult> {
	let added = 0;
	const records: RegistryRecordInput[] = [];
	for (const source of sources) {
		const sourcePath = path.resolve(source.path);
		const sourceRoot = path.resolve(source.rootPath);
		const relativePath = path.relative(sourceRoot, sourcePath).split(path.sep).join("/");
		const content = await readFile(sourcePath, "utf8");
		const importedSections = source.projectId ? sections(content) : decisionTableRows(content);
		for (const section of importedSections) {
			const record: RegistryRecordInput = {
				id: stableId({ scopeType: source.projectId ? "project" : "global", projectId: source.projectId ?? null, authority: section.authority }, relativePath, section.text),
				kind: "decision",
				authority: section.authority,
				status: "draft",
				scopeType: source.projectId ? "project" : "global",
				projectId: source.projectId ?? null,
				problem: section.title,
				decision: section.text,
				reuse: "standing",
				source: "import",
				sourceRef: `${sourcePath}:L${section.startLine}-L${section.endLine}`,
				createdBy: { type: section.authority, id: "registry-import" },
			};
			const result = await repo.registry.records.createImportedIfAbsent(record);
			if (result.inserted) added++;
			records.push(result.record as RegistryRecordInput);
		}
	}
	return { added, records };
}
