// Two windows (two Claude processes with one session id) over one request folder. Run with
// `claude plugin test plugins/agent-rig-window`; no engine is involved, the Deps are a map of files.
import { expect, test } from "claude-code/testing";

import type { Deps } from "./window";

import { Window } from "./window";

const DIR = "/home/tester/.agent-rig/sessions/sess-1";
const TOKENS = 1;

type Shared = { files: Map<string, string>; dirs: Set<string>; writes: string[]; now: number };

const shared = (): Shared => ({ files: new Map(), dirs: new Set(), writes: [], now: 1_000_000 });

// One process's view of the shared folder; `ran` records what this process executed.
function process(s: Shared, ran: string[]): Deps {
  return {
    list: async dir => [...s.files.keys()].filter(path => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/")).map(path => path.slice(dir.length + 1)),
    read: async path => s.files.get(path),
    writeAtomic: async (path, text) => {
      s.files.set(path, text);
      s.writes.push(path);
    },
    remove: async path => {
      s.files.delete(path);
    },
    // mkdir: atomic, fails on an existing directory.
    claim: async dir => {
      if (s.dirs.has(dir)) return false;
      s.dirs.add(dir);
      return true;
    },
    removeTree: async dir => {
      s.dirs.delete(dir);
      for (const path of [...s.files.keys()]) if (path.startsWith(`${dir}/`)) s.files.delete(path);
    },
    usage: async () => ({ context: { tokens: TOKENS, window: 10 }, rateLimits: [] }),
    compact: async () => {
      ran.push("compact");
      return { tokensBefore: 2, tokensAfter: 1 };
    },
    rename: async name => void ran.push(`rename:${name}`),
    autocompact: async () => {
      ran.push("autocompact");
      return undefined;
    },
    now: () => s.now,
  };
}

const put = (s: Shared, id: string, body: unknown) => s.files.set(`${DIR}/requests/${id}.json`, JSON.stringify(body));
const answers = (s: Shared) => s.writes.filter(path => path.includes("/responses/"));

test("one request is run once and answered once by two windows on one folder", async () => {
  const s = shared();
  const ranA: string[] = [];
  const ranB: string[] = [];
  const a = new Window(DIR, process(s, ranA));
  const b = new Window(DIR, process(s, ranB));
  put(s, "c1", { id: "c1", op: "compact" });
  put(s, "r1", { id: "r1", op: "rename", args: { name: "x" } });
  put(s, "u1", { id: "u1", op: "usage" });
  await Promise.all([a.poll(), b.poll()]);
  await Promise.all([a.poll(), b.poll()]);
  expect([...ranA, ...ranB].sort()).toEqual(["compact", "rename:x"]);
  expect(answers(s).sort()).toEqual([`${DIR}/responses/c1.json`, `${DIR}/responses/r1.json`, `${DIR}/responses/u1.json`]);
  expect(JSON.parse(s.files.get(`${DIR}/responses/c1.json`) ?? "null").ok).toBe(true);
  // Both windows are silent afterwards: no request comes back.
  await Promise.all([a.poll(), b.poll()]);
  expect(answers(s)).toHaveLength(3);
});

test("a claimed request is beaten while unanswered, and a window forgets ids answered by the other", async () => {
  const s = shared();
  const a = new Window(DIR, process(s, []));
  const b = new Window(DIR, process(s, []));
  a.turn(true);
  b.turn(true);
  put(s, "c1", { id: "c1", op: "compact" });
  await a.poll();
  await b.poll();
  expect(s.files.get(`${DIR}/claims/c1/beat`)).toBe(String(s.now));
  s.now += 5000;
  await a.poll();
  expect(s.files.get(`${DIR}/claims/c1/beat`)).toBe(String(s.now));
  a.turn(false);
  await a.poll();
  expect(s.files.has(`${DIR}/responses/c1.json`)).toBe(true);
});

test("a request answered and removed before the late window claims it is not run again", async () => {
  const s = shared();
  const ran: string[] = [];
  put(s, "c1", { id: "c1", op: "compact" });
  // The window listed the request, then rig removed the request and the claim; the claim is free again.
  const deps = process(s, ran);
  const list = deps.list;
  deps.list = async dir => {
    const names = await list(dir);
    s.files.delete(`${DIR}/requests/c1.json`);
    return names;
  };
  const w = new Window(DIR, deps);
  await w.poll();
  expect(ran).toEqual([]);
  expect(s.dirs.has(`${DIR}/claims/c1`)).toBe(false);
});
