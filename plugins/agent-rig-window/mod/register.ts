// The in-window module of rig (hooks.json -> modules): usage snapshots and a request queue under
// ~/.agent-rig/sessions/<session id>/. The logic is in window.ts; here are only the engine's `$` calls.
import type { Register } from "claude-code";

import { ID_PATTERN, moveCommand, removeCommand } from "./protocol";
import { Window } from "./window";

const POLL_MS = 1000;
const ROOT_DIR = ".agent-rig/sessions";
const TEMP_SUFFIX = ".tmp";
const DRIVE_PATTERN = /^[A-Za-z]:/;

let cancelPoll: (() => void) | undefined;
let window: Window | undefined;
let tempCount = 0;

export const register: Register = on => {
  on("session.start", async ($, e, next) => {
    const result = await next(e);
    cancelPoll?.();
    cancelPoll = undefined;
    const home = (await $.env.get("HOME")) ?? (await $.env.get("USERPROFILE"));
    const id = await $.session.id();
    if (home === undefined || !ID_PATTERN.test(id)) {
      $.ui.log("agent-rig-window: no home directory or an unusable session id; the window files are off", { to: "debug" });
      return result;
    }
    const base = home.replaceAll("\\", "/").replace(/\/$/, "");
    const isWindows = DRIVE_PATTERN.test(base);
    const run = async (argv: string[]): Promise<boolean> => (await $.process.run(argv)).exitCode === 0;
    const w = new Window(`${base}/${ROOT_DIR}/${id}`, {
      list: async dir => {
        try {
          return (await $.fs.list(dir)).filter(entry => entry.kind !== "dir").map(entry => entry.name);
        } catch {
          return [];
        }
      },
      read: async path => {
        try {
          const text = await $.fs.read(path);
          return typeof text === "string" ? text : undefined;
        } catch {
          return undefined;
        }
      },
      // The engine's $.fs has no rename: write beside, then move over; where the move fails, write in place.
      writeAtomic: async (path, text) => {
        const temp = `${path}${TEMP_SUFFIX}${++tempCount}`;
        await $.fs.write(temp, text);
        try {
          if (await run(moveCommand(isWindows, temp, path))) return;
        } catch {
          // Falls through to the plain write.
        }
        await $.fs.write(path, text);
        await run(removeCommand(isWindows, temp)).catch(() => false);
      },
      remove: async path => {
        if (!(await run(removeCommand(isWindows, path)))) throw new Error(`could not remove ${path}`);
      },
      usage: () => $.session.usage({ breakdown: "summary" }),
      compact: async instructions => {
        const result = await $.session.compact(instructions === undefined ? undefined : { instructions });
        return result.skip === undefined
          ? { tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter }
          : { skip: result.skip };
      },
      rename: async name => {
        await $.command.run({ command: "rename", args: name });
      },
      autocompact: async window => {
        const result = await $.command.run({ command: "autocompact", args: String(window) });
        return result.text;
      },
      now: () => Date.now(),
    });
    window = w;
    await w.measured();
    const timer = $.clock.every(POLL_MS, () => void w.poll());
    cancelPoll = () => timer.cancel();
    return result;
  });

  // The account's rate limits as this session read them.
  on("session.measure", async ($, e, next) => {
    void window?.measured(e.rateLimits);
    return next(e);
  });

  // The main loop's turns: a compaction or a rename waits for none to run.
  on("turn.start", async ($, e, next) => {
    if (e.agentId === undefined) window?.turn(true);
    return next(e);
  });
  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined) window?.turn(false);
    return next(e);
  });
};
