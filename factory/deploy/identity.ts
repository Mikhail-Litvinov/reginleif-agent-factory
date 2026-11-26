// The identity of a file or directory, in one place: owned.ts and setup-secrets.ts both decide "is this the thing I
// created?" with it, so the rule cannot drift between them.
//
// An identity is device, file index and creation time (all read as bigint, because an NTFS index does not fit a
// double). Two rules make a match mean something:
//  - an unknown identity proves nothing: a file index of 0 is what a filesystem or a query returns when it has none, and
//    two zeros are equal without being the same file, so an identity with ino 0 never matches anything (not even itself);
//  - the creation time is part of it, because a deleted file's index can be given to the next file made on the volume,
//    and the creation time tells the old file from the new one that reuses its index.
import type { BigIntStats } from "node:fs";

export interface FileId {
	dev: bigint;
	ino: bigint;
	birthtimeNs: bigint;
}

/** The identity held by a bigint stat result. */
export const idOfStats = (stats: Pick<BigIntStats, "dev" | "ino" | "birthtimeNs">): FileId => ({ dev: stats.dev, ino: stats.ino, birthtimeNs: stats.birthtimeNs });

/** True when the identity can prove anything at all (it has a file index). */
export const isKnownId = (id: FileId | undefined): id is FileId => id !== undefined && typeof id.ino === "bigint" && id.ino !== 0n;

/** True only when both identities are known and every part of them is equal. */
export const sameId = (a: FileId | undefined, b: FileId | undefined): boolean =>
	isKnownId(a) && isKnownId(b) && a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
