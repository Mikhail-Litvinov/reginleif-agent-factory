// Run with `claude plugin test plugins/agent-rig-window`. The world beneath the module is a map of files, a clock
// that moves when the test moves it, and fakes for the session calls.
import type { On } from "claude-code";

import { expect, mock, test } from "claude-code/testing";

const HOME = "/home/tester";
const SESSION = "sess-1";
const DIR = `${HOME}/.agent-rig/sessions/${SESSION}`;
const POLL_MS = 1000;
const WINDOW = 200_000;
const TOKENS = 1234;
const OK = { exitCode: 0, stdout: "", stderr: "" };

// The engine hands paths over in the platform spelling (C:home...); the fake files are keyed by one spelling.
const norm = (path: string): string => path.replace(/^[A-Za-z]:/, "").replaceAll("\\", "/");

type World = {
  files: Map<string, string>;
  compactions: (string | undefined)[];
  renames: string[];
  compactResult: { skip?: string };
  clock: ReturnType<typeof mock.clock>;
};

// Every `$` call the module makes, answered by the test; `session.start` is the engine's own echo.
function world(on: On): World {
  const w: World = { files: new Map(), compactions: [], renames: [], compactResult: {}, clock: mock.clock(on) };
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("env.get", (_, e) => ({ value: e.name === "HOME" ? HOME : undefined }));
  on("session.id", () => ({ value: SESSION }));
  on("session.usage", () => ({ value: { startedAt: 0, context: { tokens: TOKENS, window: WINDOW }, rateLimits: [{ kind: "five_hour", percentUsed: 5 }] } }));
  on("fs.write", (_, e) => {
    w.files.set(norm(e.path), e.text);
    return { value: undefined };
  });
  on("fs.read", (_, e) => {
    const text = w.files.get(norm(e.path));
    return text === undefined ? { deny: "missing" } : { value: text };
  });
  on("fs.list", (_, e) => ({
    value:
    [...w.files.keys()]
      .filter(path => path.startsWith(`${norm(e.path)}/`))
      .map(path => ({ name: path.slice(norm(e.path).length + 1), kind: "file" as const, size: 0, mtimeMs: 0, isLink: false })),
  }));
  // mv and rm, the only commands the module runs.
  on("process.run", (_, e) => {
    const [command, ...args] = e.argv;
    if (command === "mv") {
      const [, from, to] = args;
      const text = from === undefined ? undefined : w.files.get(norm(from));
      if (from !== undefined && to !== undefined && text !== undefined) {
        w.files.delete(norm(from));
        w.files.set(norm(to), text);
      }
    } else if (command === "rm") {
      for (const path of args.slice(1)) w.files.delete(norm(path));
    }
    return { value: OK };
  });
  on("session.compact", (_, e) => {
    w.compactions.push(e.instructions);
    return w.compactResult.skip === undefined ? { messages: [{ role: "user" as const, text: "summary", toolUses: [] }], tokensBefore: 10, tokensAfter: 5 } : { skip: w.compactResult.skip };
  });
  on("session.measure", (_, e) => ({ changed: e.changed }));
  on("command.run", (_, e) => {
    w.renames.push(e.args);
    return { value: {} };
  });
  return w;
}

const request = (w: World, id: string, body: unknown) => w.files.set(`${DIR}/requests/${id}.json`, typeof body === "string" ? body : JSON.stringify(body));
const response = (w: World, id: string): Record<string, unknown> | undefined => {
  const text = w.files.get(`${DIR}/responses/${id}.json`);
  return text === undefined ? undefined : JSON.parse(text);
};
const start = ($: { session: { start: (a: { cwd: string; surface: "terminal"; isInteractive: boolean }) => Promise<unknown> } }) =>
  $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });

test("a snapshot is written at start and on every measure, with the measure's rate limits", async ($, on) => {
  const w = world(on);
  await start($);
  const first = JSON.parse(w.files.get(`${DIR}/usage.json`) ?? "null");
  expect(first.context.tokens).toBe(TOKENS);
  expect(first.rateLimits[0].kind).toBe("five_hour");
  expect(typeof first.at).toBe("string");

  const rateLimits = [{ kind: "seven_day", percentUsed: 42 }];
  await $.session.measure({ context: { tokens: 9, window: WINDOW }, rateLimits, changed: ["rateLimits"] });
  await w.clock.settle();
  const second = JSON.parse(w.files.get(`${DIR}/usage.json`) ?? "null");
  expect(second.rateLimits).toEqual(rateLimits);
  // No stray temp file stays beside the snapshot.
  expect([...w.files.keys()].filter(path => path.includes(".tmp"))).toEqual([]);
});

test("usage and mode are answered at once; the request is removed", async ($, on) => {
  const w = world(on);
  await start($);
  request(w, "u1", { id: "u1", op: "usage" });
  request(w, "m1", { id: "m1", op: "mode" });
  await w.clock.advance(POLL_MS);
  const usage = response(w, "u1");
  expect(usage?.ok).toBe(true);
  expect(JSON.stringify(usage?.result)).toContain(String(TOKENS));
  const mode = response(w, "m1");
  expect(mode?.ok).toBe(false);
  expect(String(mode?.error)).toContain("permission mode");
  expect(w.files.has(`${DIR}/requests/u1.json`)).toBe(false);
  expect(w.files.has(`${DIR}/requests/m1.json`)).toBe(false);
});

test("compact and rename run when no turn runs", async ($, on) => {
  const w = world(on);
  await start($);
  request(w, "c1", { id: "c1", op: "compact", args: { instructions: "keep the plan" } });
  request(w, "r1", { id: "r1", op: "rename", args: { name: "  new   name " } });
  await w.clock.advance(POLL_MS);
  expect(w.compactions).toEqual(["keep the plan"]);
  expect(w.renames).toEqual(["new name"]);
  expect(response(w, "c1")?.ok).toBe(true);
  expect(response(w, "r1")?.result).toEqual({ name: "new name" });
  expect(w.files.has(`${DIR}/requests/c1.json`)).toBe(false);
});

test("a compaction skipped by a hook is answered as a result with the reason", async ($, on) => {
  const w = world(on);
  w.compactResult = { skip: "vetoed" };
  await start($);
  request(w, "c1", { id: "c1", op: "compact" });
  await w.clock.advance(POLL_MS);
  expect(response(w, "c1")?.result).toEqual({ skip: "vetoed" });
});

test("a request that arrives during a turn waits until the turn ends", async ($, on) => {
  const w = world(on);
  on("turn.start", (_, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_, e) => ({ text: e.answer }));
  await start($);
  await $.turn.start({ text: "hi", turnId: "t1" });
  request(w, "c1", { id: "c1", op: "compact" });
  request(w, "r1", { id: "r1", op: "rename", args: { name: "x" } });
  await w.clock.advance(POLL_MS * 3);
  expect(w.compactions).toEqual([]);
  expect(response(w, "c1")).toBeUndefined();
  expect(w.files.has(`${DIR}/requests/c1.json`)).toBe(true);

  await $.turn.complete({ answer: "done", durationMs: 1, isAborted: false, turnId: "t1", reason: "answer" });
  await w.clock.advance(POLL_MS);
  expect(response(w, "c1")?.ok).toBe(true);
  expect(response(w, "r1")?.ok).toBe(true);
  expect(w.compactions.length).toBe(1);
});

test("a malformed request or an unknown op is an error response, never a crash", async ($, on) => {
  const w = world(on);
  await start($);
  request(w, "bad1", "{not json");
  request(w, "bad2", "[1]");
  request(w, "bad3", { id: "other", op: "usage" });
  request(w, "bad4", { id: "bad4", op: "explode" });
  request(w, "bad5", { id: "bad5", op: "usage", args: 7 });
  request(w, "bad6", { id: "bad6", op: "rename", args: {} });
  await w.clock.advance(POLL_MS);
  for (const id of ["bad1", "bad2", "bad3", "bad4", "bad5", "bad6"]) {
    expect(response(w, id)?.ok).toBe(false);
    expect(w.files.has(`${DIR}/requests/${id}.json`)).toBe(false);
  }
  expect(String(response(w, "bad4")?.error)).toContain("unknown op");
  // The queue still works afterwards.
  request(w, "ok1", { id: "ok1", op: "usage" });
  await w.clock.advance(POLL_MS);
  expect(response(w, "ok1")?.ok).toBe(true);
});

test("a request whose id is not a safe file name is ignored", async ($, on) => {
  const w = world(on);
  await start($);
  for (const id of ["a b", "..x", "x.y", "a".repeat(65)]) request(w, id, { id, op: "usage" });
  w.files.set(`${DIR}/requests/note.txt`, "{}");
  await w.clock.advance(POLL_MS);
  expect([...w.files.keys()].filter(path => path.includes("/responses/"))).toEqual([]);
});
