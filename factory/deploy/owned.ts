// Files and directories a run created, removed by identity.
//
// A run may delete only what it created. A path is a name, not the thing: between creation and cleanup another process
// can remove the file and put its own under the same name, so "the path is in my list" does not mean "that file is
// mine". Here every file and directory is recorded at creation together with its identity (device, file index and
// creation time, see identity.ts), and cleanup re-reads the identity of what the path names now and deletes only on a
// match. A name that now holds something else is left alone and reported. An identity that is unknown (file index 0)
// is refused when recording, because it could never prove anything.
//
// Three rules keep the checks honest. Creation is exclusive ("wx", mkdtemp, link), so a created name never was somebody
// else's file, and the identity is taken from the open handle or the new name, never from a later look at the path.
// Directories are removed without recursion, so a directory holding something this run did not create refuses to go
// (ENOTEMPTY) instead of taking that with it. And a directory is checked again immediately before each of its entries
// is removed and before it is removed itself: a directory that is no longer the one this run made (renamed away and
// replaced) is not entered, and the cleanup of it stops there and reports it (fail closed).
//
// One window remains and cannot be closed from user space with path-based calls: between the last identity check and
// the unlink (or rmdir) the name or its parent can still be swapped. It is a few microseconds wide, and it needs another
// process that acts at exactly that moment with the owner's rights, which is outside the threat model of these tools
// (T8 in docs/agent-factory/security.md: the tools defend against mistakes, crashes, stale state and concurrency
// between our own runs, not against an active adversary racing them). An unlink only ever removes the one name, an
// rmdir only an empty directory, never a tree.
import { link, lstat, mkdir, mkdtemp, open, readdir, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { idOfStats, isKnownId, sameId, type FileId } from "./identity.ts";

export type { FileId };

/** `beforeStep` runs just before each identity re-check that guards a removal; tests use it to swap a directory at that moment. */
export interface RemoveOptions {
	beforeStep?: () => Promise<void>;
}

export type Removal = "removed" | "left" | "absent";

export interface RemoveAllResult {
	removed: string[];
	/** Names that now hold a file this run did not create; not touched. */
	left: string[];
	problems: string[];
	/** True when the guard refused a removal and the rest was left. */
	stopped: boolean;
}

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The identity of what `path` names right now (a link itself, never what it points to), or undefined when nothing is there. */
const identityAt = async (path: string): Promise<FileId | undefined> => {
	try {
		return idOfStats(await lstat(path, { bigint: true }));
	} catch (error) {
		if (codeOf(error) === "ENOENT") return undefined;
		throw error;
	}
};

/** Refuses an identity that proves nothing, so it never gets onto a list. */
const requireKnown = (path: string, id: FileId | undefined): FileId => {
	if (!isKnownId(id)) throw new Error(`${path}: unknown identity (the filesystem gave no file index); it cannot be recorded`);
	return id;
};

export class OwnedFiles {
	private readonly entries = new Map<string, FileId>();

	/**
	 * Creates `path` exclusively and records its identity. An existing file is refused (EEXIST) and not recorded, so a
	 * file that was there before this run can never be on the list. The caller closes the handle before removal.
	 */
	async create(path: string): Promise<FileHandle> {
		const handle = await open(path, "wx");
		try {
			this.entries.set(path, requireKnown(path, idOfStats(await handle.stat({ bigint: true }))));
		} catch (error) {
			await handle.close();
			throw error;
		}
		return handle;
	}

	/**
	 * Records a file that already exists and was made by this run's own child process (see OwnedDir.adoptChildren). A
	 * path that is recorded already keeps its first identity.
	 */
	async adopt(path: string, id?: FileId): Promise<void> {
		if (this.entries.has(path)) return;
		const found = id ?? (await identityAt(path));
		if (found === undefined) throw new Error(`${path} vanished before it could be recorded`);
		this.entries.set(path, requireKnown(path, found));
	}

	/**
	 * Gives the recorded file `staged` a second name `final` by hard link, which never overwrites (EEXIST). Both names
	 * are one file, so `final` is recorded with the identity of `staged`, with no look at the path in between.
	 */
	async publish(staged: string, final: string): Promise<void> {
		const id = this.entries.get(staged);
		if (id === undefined) throw new Error(`${staged} was not created by this run`);
		await link(staged, final);
		this.entries.set(final, id);
	}

	/** Forgets `path` without removing it: the run keeps that file as its result. */
	release(path: string): void {
		this.entries.delete(path);
	}

	/** Removes `path` when it still is the file this run recorded under that name. */
	async remove(path: string): Promise<Removal> {
		const recorded = this.entries.get(path);
		if (recorded === undefined) throw new Error(`${path} was not created by this run`);
		const now = await identityAt(path);
		if (now === undefined) {
			this.entries.delete(path);
			return "absent";
		}
		if (!sameId(now, recorded)) {
			this.entries.delete(path);
			return "left";
		}
		await unlink(path);
		this.entries.delete(path);
		return "removed";
	}

	/**
	 * Removes everything recorded, newest first; one failure does not stop the rest. `proceed` is asked before each
	 * file; when it says no, nothing more is removed and `stopped` is set.
	 */
	async removeAll(proceed?: () => Promise<boolean>): Promise<RemoveAllResult> {
		const result: RemoveAllResult = { removed: [], left: [], problems: [], stopped: false };
		for (const path of [...this.entries.keys()].reverse()) {
			if (proceed !== undefined && !(await proceed())) {
				result.stopped = true;
				break;
			}
			try {
				const outcome = await this.remove(path);
				if (outcome === "removed") result.removed.push(path);
				else if (outcome === "left") result.left.push(path);
			} catch (error) {
				this.entries.delete(path);
				result.problems.push(`${path}: ${describe(error)}`);
			}
		}
		return result;
	}

	get size(): number {
		return this.entries.size;
	}
}

export class OwnedDir {
	readonly files = new OwnedFiles();

	readonly path: string;
	private readonly id: FileId;
	private readonly children: OwnedDir[] = [];

	private constructor(path: string, id: FileId) {
		this.path = path;
		this.id = id;
	}

	/** Makes a private directory `<parent>/<prefix><random>` (exclusive by construction) and records its identity. */
	static async make(parent: string, prefix: string): Promise<OwnedDir> {
		const path = await mkdtemp(join(parent, prefix));
		const id = await identityAt(path);
		if (id === undefined) throw new Error(`${path} vanished right after it was created`);
		return new OwnedDir(path, requireKnown(path, id));
	}

	/** Makes the subdirectory `name` (exclusively: an existing one is refused) and records its identity. */
	async child(name: string): Promise<OwnedDir> {
		const path = join(this.path, name);
		await mkdir(path);
		const id = await identityAt(path);
		if (id === undefined) throw new Error(`${path} vanished right after it was created`);
		const made = new OwnedDir(path, requireKnown(path, id));
		this.children.push(made);
		return made;
	}

	/**
	 * Records everything that is in the directory now, subdirectories included (a link is recorded as itself, never
	 * followed). Only for a directory this run made privately (mkdtemp) and handed to its own helper or code under
	 * test, so everything inside was written by this run. Call it when that code has finished writing; what appears
	 * later is not recorded, and so is not removed.
	 */
	async adoptChildren(): Promise<void> {
		for (const name of await readdir(this.path)) {
			const path = join(this.path, name);
			let stats;
			try {
				stats = await lstat(path, { bigint: true });
			} catch (error) {
				if (codeOf(error) === "ENOENT") continue;
				throw error;
			}
			const id = idOfStats(stats);
			if (!stats.isDirectory()) {
				await this.files.adopt(path, id);
				continue;
			}
			let sub = this.children.find((candidate) => candidate.path === path);
			if (sub === undefined) {
				sub = new OwnedDir(path, requireKnown(path, id));
				this.children.push(sub);
			}
			await sub.adoptChildren();
		}
	}

	/**
	 * Removes the recorded subdirectories and files and then the directory itself, each by its recorded identity and
	 * without recursion. Returns what could not be done; a directory that still holds something this run did not
	 * create stays, with that thing, and is reported. A path that now names a different directory is not touched.
	 */
	async remove(options: RemoveOptions = {}): Promise<string[]> {
		const now = await identityAt(this.path);
		if (now === undefined) return [];
		if (!sameId(now, this.id)) return [];
		const problems: string[] = [];
		// Asked immediately before each removal below: is this still the directory this run made? (Residual window: T8.)
		const stillMine = async (): Promise<boolean> => {
			await options.beforeStep?.();
			return sameId(await identityAt(this.path), this.id);
		};
		const replaced = `${this.path} was replaced during cleanup, so no more was removed from it`;
		for (const sub of this.children.splice(0).reverse()) {
			if (!(await stillMine())) return [...problems, replaced];
			problems.push(...(await sub.remove(options)));
		}
		const result = await this.files.removeAll(stillMine);
		problems.push(...result.problems);
		if (result.stopped || !(await stillMine())) return [...problems, replaced];
		try {
			await rmdir(this.path);
		} catch (error) {
			const code = codeOf(error);
			if (code === "ENOTEMPTY" || code === "EEXIST") problems.push(`${this.path} is not empty (${code}): it holds something this run did not create; kept`);
			else problems.push(`${this.path}: ${describe(error)}`);
		}
		return problems;
	}
}
