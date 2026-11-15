import type { RuntimePorts } from "../ports.js";
import type { Result } from "../result.js";

import { joinPath, toSlashPath } from "../file-system.js";
import { messagesFor } from "../messages.js";
import { err, errorText, ok } from "../result.js";

// Hub plugin/src/hub/skill-cleanup.ts: chunk size, backup retention and Windows rename retries.
const CHUNK_BYTES = 1024 * 1024;
const KEEP_BACKUPS = 3;
const RENAME_TRIES = 10;
const RENAME_RETRY_MS = 200;
const LF = 10;
const CR = 13;
const MARK = Buffer.from('"invoked_skills"');
type Edit = { start: number; end: number; bytes: Buffer; line: number; uuid: string | null; text: string };
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const busy = (value: unknown): boolean => object(value) && (value.code === "EPERM" || value.code === "EBUSY" || value.code === "EACCES");

export const cleanTranscript = async (runtime: RuntimePorts, path: string, replace: (from: string, to: string) => Promise<void> = (from, to) => runtime.fs.rename(from, to)): Promise<Result<{ backup: string; skillsRemoved: number }>> => {
	const m = messagesFor(runtime.language).session;
	const temp = `${path}.cleanup-tmp-${runtime.fs.uniqueSuffix()}`;
	const normalized = toSlashPath(path);
	const separator = normalized.lastIndexOf("/");
	const prefix = `${normalized.slice(separator + 1).replace(/\.jsonl$/, "")}.cleanup-`;
	const directory = separator < 0 ? "." : normalized.slice(0, separator) || "/";
	const backup = joinPath(directory, `${prefix}${runtime.clock.now().getTime()}.jsonl`);
	let backupWritten = false;
	let tempWritten = false;
	try {
		const info = await runtime.fs.stat(path);
		if (info === null) throw new Error(m.transcriptMissing());
		const size = info.size;
		const edits: Edit[] = [];
		let skillsRemoved = 0;
		{
			let parts: Buffer[] = [];
			let start = 0;
			let line = 0;
			const inspect = (bytes: Buffer): void => {
				line++;
				if (!bytes.includes(MARK)) return;
				const body = bytes.at(-1) === CR ? bytes.subarray(0, -1) : bytes;
				let value: unknown;
				let text: string | null;
				try { text = new TextDecoder("utf-8", { fatal: true }).decode(body); } catch { text = null; }
				try { value = JSON.parse(text ?? body.toString("utf8")); } catch { return; }
				if (!object(value) || value.type !== "attachment" || !object(value.attachment) || value.attachment.type !== "invoked_skills") return;
				if (text === null) throw new Error(m.transcriptRecord());
				const skills = value.attachment.skills;
				if (!Array.isArray(skills) || skills.some((skill: unknown) => !object(skill) || typeof skill.name !== "string" || typeof skill.content !== "string")) throw new Error(m.skillsRecord());
				skillsRemoved = skills.length;
				if (skills.length === 0) return;
				edits.push({ start, end: start + body.length, bytes: Buffer.from(JSON.stringify({ ...value, attachment: { ...value.attachment, skills: [] } })), line, uuid: typeof value.uuid === "string" ? value.uuid : null, text });
			};
			for (let pos = 0; pos < size;) {
				const buffer = Buffer.from(await runtime.fs.readRange(path, pos, Math.min(CHUNK_BYTES, size - pos)));
				const bytesRead = buffer.length;
				if (!bytesRead) throw new Error(m.transcriptShorter());
				const chunk = buffer.subarray(0, bytesRead);
				let from = 0;
				for (let index = chunk.indexOf(LF); index !== -1; index = chunk.indexOf(LF, from)) {
					parts.push(chunk.subarray(from, index)); inspect(Buffer.concat(parts)); parts = []; start = pos + index + 1; from = index + 1;
				}
				if (from < chunk.length) parts.push(chunk.subarray(from));
				pos += bytesRead;
			}
			if (parts.length) inspect(Buffer.concat(parts));
			const written = await runtime.fs.writeExclusive(backup, edits.map(({ line: number, uuid, text }) => `${JSON.stringify({ line: number, uuid, text })}\n`).join(""));
			if (!written.ok) throw new Error(written.error);
			if (!written.value) throw new Error(m.backupExists());
			backupWritten = true;
			const created = await runtime.fs.writeExclusive(temp, "");
			if (!created.ok) throw new Error(created.error);
			if (!created.value) throw new Error(m.temporaryExists());
			tempWritten = true;
			{
				let pos = 0;
				for (const edit of [...edits, { start: size, end: size, bytes: Buffer.alloc(0), line: 0, uuid: null, text: "" }]) {
					while (pos < edit.start) {
						const buffer = await runtime.fs.readRange(path, pos, Math.min(CHUNK_BYTES, edit.start - pos));
						const bytesRead = buffer.length;
						if (!bytesRead) throw new Error(m.transcriptShorter());
						await runtime.fs.appendBytes(temp, buffer); pos += bytesRead;
					}
					await runtime.fs.appendBytes(temp, edit.bytes); pos = edit.end;
				}
			}
		}
		if ((await runtime.fs.stat(path))?.size !== size) throw new Error(m.transcriptChanged());
		for (let attempt = 1; ; attempt++) {
			try { await replace(temp, path); break; } catch (error) {
				if (attempt >= RENAME_TRIES || !busy(error)) throw error;
				await runtime.clock.sleep(RENAME_RETRY_MS);
			}
		}
		backupWritten = false;
		tempWritten = false;
		const names = (await runtime.fs.listDirectory(directory)).filter((entry) => !entry.directory).map((entry) => entry.name).filter((name) => name.startsWith(prefix) && /^\d+\.jsonl$/.test(name.slice(prefix.length))).sort((a, b) => Number(b.slice(prefix.length, -6)) - Number(a.slice(prefix.length, -6)));
		for (const name of names.slice(KEEP_BACKUPS)) await runtime.fs.remove(joinPath(directory, name)).catch(() => undefined);
		return ok({ backup, skillsRemoved });
	} catch (error) {
		if (backupWritten) await runtime.fs.remove(backup).catch(() => undefined);
		if (tempWritten) await runtime.fs.remove(temp).catch(() => undefined);
		return err(errorText(error));
	}
};
