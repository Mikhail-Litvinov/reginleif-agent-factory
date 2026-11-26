// PsqlSession reads the output of a child process in chunks, and a chunk boundary can fall inside a multibyte character
// (an identifier such as a table named "таблица" or a stderr message that quotes one). Each chunk decoded on its own would
// turn the split character into replacement characters, so stdout and stderr are decoded as streams (a decoder that holds
// the incomplete tail of one chunk until the next arrives).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Utf8Lines, Utf8Text } from "../deploy/lib.ts";

const NAME = "таблица_日本語_😀";

// Every split of the bytes into two chunks, so that each multibyte character is cut at each of its inner positions.
const splits = (text: string): Buffer[][] => {
	const bytes = Buffer.from(text, "utf8");
	return Array.from({ length: bytes.length - 1 }, (_, i) => [bytes.subarray(0, i + 1), bytes.subarray(i + 1)]);
};

describe("a multibyte identifier split across chunks", () => {
	it("Utf8Lines returns the line whole, whatever byte the chunks split at", () => {
		for (const chunks of splits(`${NAME}\n`)) {
			const decoder = new Utf8Lines();
			assert.deepEqual(chunks.flatMap((chunk) => decoder.write(chunk)), [NAME], `split after ${chunks[0]?.length} bytes`);
		}
	});

	it("Utf8Lines keeps the incomplete line and drops the carriage return", () => {
		const decoder = new Utf8Lines();
		assert.deepEqual(decoder.write(Buffer.from(`${NAME}\r\nsecond`)), [NAME]);
		assert.deepEqual(decoder.write(Buffer.from("\nthird\n")), ["second", "third"]);
	});

	it("Utf8Text returns the text whole, whatever byte the chunks split at", () => {
		for (const chunks of splits(`relation "${NAME}" does not exist`)) {
			const decoder = new Utf8Text();
			const text = chunks.map((chunk) => decoder.write(chunk)).join("") + decoder.end();
			assert.equal(text, `relation "${NAME}" does not exist`, `split after ${chunks[0]?.length} bytes`);
			assert.equal(text.includes("�"), false);
		}
	});

	// PsqlSession starts `docker exec`, so the wiring is checked on its source: both streams go through the stream decoders and
	// no chunk is turned into text on its own (that is the defect: a `chunk.toString()` or a `StringDecoder`-less `+= chunk`).
	it("PsqlSession decodes both of its streams through the stream decoders, never a chunk on its own", () => {
		const source = readFileSync(new URL("../deploy/lib.ts", import.meta.url), "utf8");
		const start = source.indexOf("export class PsqlSession");
		const body = source.slice(start, source.indexOf("\n}\n", start));
		assert.ok(start >= 0);
		assert.match(body, /new Utf8Lines\(\)/);
		assert.match(body, /new Utf8Text\(\)/);
		assert.match(body, /stdout\.write\(chunk\)/);
		assert.match(body, /stderr\.write\(chunk\)/);
		assert.doesNotMatch(body, /chunk\.toString|String\(chunk\)|\+= chunk|\.setEncoding/);
	});
});
