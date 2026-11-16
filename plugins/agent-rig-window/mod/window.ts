// What the window does with the session's files: snapshots of usage and a request queue. The module runs inside
// Claude Code with no Node, so everything outside comes in as Deps (the engine's `$` calls, wired in register.ts).
import type { Request, Response, Usage, UsageSnapshot } from "./protocol";

import { CLAIM_BEAT_FILE, CLAIMS_DIR, errorText, idOfFile, parseRequest, responseText } from "./protocol";

const REQUESTS_DIR = "requests";
const RESPONSES_DIR = "responses";
const USAGE_FILE = "usage.json";
const RESPONSE_SUFFIX = ".json";
// Polls in a row on which a compaction failed with no turn running before the failure is answered:
// a turn may start just as it is tried (the same rule the telegram hub's module uses).
const COMPACT_TRIES = 3;
const MODE_UNAVAILABLE = "the permission mode is not exposed by the engine API";

// The part of the engine's session.compact result the answer needs.
export type Compaction = { skip?: string; tokensBefore?: number; tokensAfter?: number };

export type Deps = {
  // File names in the directory; empty when it is missing.
  list(dir: string): Promise<string[]>;
  // The file's text; undefined when it cannot be read.
  read(path: string): Promise<string | undefined>;
  // Writes the file whole or not at all, creating directories.
  writeAtomic(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  // Takes the claim directory: true for the one caller that made it, false when it already exists (any other
  // refusal rejects). The step is atomic across processes: it is what makes one request run in one process.
  claim(dir: string): Promise<boolean>;
  removeTree(dir: string): Promise<void>;
  usage(): Promise<Usage>;
  // Compacts the conversation; rejects while a turn runs.
  compact(instructions: string | undefined): Promise<Compaction>;
  // Runs the session's own /rename; the engine queues it until the session is idle.
  rename(name: string): Promise<void>;
  // Runs the session's own /autocompact with the window (a number or "auto"); resolves to the command's text, if any.
  autocompact(window: number | "auto"): Promise<string | undefined>;
  now(): number;
};

type Pending = { request: Request; failed: number };

export class Window {
  // Ids picked up and not yet answered and removed: a request is handled once.
  private seen = new Set<string>();
  // Ids this window claimed and has not answered: their beat is rewritten on every poll.
  private claimed = new Set<string>();
  private pending: Pending[] = [];
  private polling = false;
  private working = false;
  private turnRuns = false;
  private rateLimits: Usage["rateLimits"] | undefined;

  constructor(
    private dir: string,
    private deps: Deps,
  ) {}

  // Called at session start and from the session.measure hook; `rateLimits` is the measure event's reading.
  async measured(rateLimits?: Usage["rateLimits"]): Promise<void> {
    if (rateLimits !== undefined) this.rateLimits = rateLimits;
    try {
      await this.deps.writeAtomic(`${this.dir}/${USAGE_FILE}`, JSON.stringify(await this.snapshot()));
    } catch {
      // The files are not writable now: the next measurement tries again.
    }
  }

  // Called from the turn hooks of the main loop.
  turn(runs: boolean): void {
    this.turnRuns = runs;
    if (!runs) void this.work();
  }

  // Called by the module's timer: picks up the requests that arrived and answers those that need no idle session.
  async poll(): Promise<void> {
    void this.work();
    if (this.polling) return;
    this.polling = true;
    try {
      await Promise.all([...this.claimed].map(id => this.beat(id)));
      const names = await this.deps.list(`${this.dir}/${REQUESTS_DIR}`);
      const listed = new Set<string>();
      for (const name of [...names].sort()) {
        const id = idOfFile(name);
        if (id === undefined) continue;
        listed.add(id);
        if (this.seen.has(id)) continue;
        this.seen.add(id);
        await this.intake(id);
      }
      // An id whose request is gone (another window answered it) is forgotten.
      for (const id of this.seen) if (!listed.has(id) && !this.claimed.has(id)) this.seen.delete(id);
    } catch {
      // The directory cannot be read now: the next poll tries again.
    } finally {
      this.polling = false;
    }
  }

  private async snapshot(): Promise<UsageSnapshot> {
    const usage = await this.deps.usage();
    const snapshot: UsageSnapshot = {
      at: new Date(this.deps.now()).toISOString(),
      context: usage.context,
      rateLimits: this.rateLimits ?? usage.rateLimits,
    };
    if (usage.cost !== undefined) snapshot.cost = usage.cost;
    return snapshot;
  }

  private async beat(id: string): Promise<void> {
    try {
      await this.deps.writeAtomic(`${this.dir}/${CLAIMS_DIR}/${id}/${CLAIM_BEAT_FILE}`, String(this.deps.now()));
    } catch {
      // The next poll writes it again.
    }
  }

  // One request, one executor: the window that makes the claim directory runs and answers the request; another
  // process with the same session id (a second window, `claude -p --resume`) finds the claim taken and skips it.
  private async intake(id: string): Promise<void> {
    const claimDir = `${this.dir}/${CLAIMS_DIR}/${id}`;
    try {
      if (!(await this.deps.claim(claimDir))) return;
    } catch {
      // The claim could not be tried: the next poll tries again.
      this.seen.delete(id);
      return;
    }
    // Read after the claim: a request already answered and removed (rig then removes its claim) is not run again.
    const text = await this.deps.read(`${this.dir}/${REQUESTS_DIR}/${id}.json`);
    if (text === undefined) {
      await this.deps.removeTree(claimDir).catch(() => undefined);
      this.seen.delete(id);
      return;
    }
    this.claimed.add(id);
    await this.beat(id);
    const parsed = parseRequest(id, text);
    if (!parsed.ok) return this.answer({ id, ok: false, error: parsed.error });
    const request = parsed.value;
    // The read-only ops answer at once; compact, rename and autocompact wait for the turn to end.
    if (request.op === "usage") {
      try {
        return await this.answer({ id, ok: true, result: await this.snapshot() });
      } catch (e) {
        return this.answer({ id, ok: false, error: errorText(e) });
      }
    }
    if (request.op === "mode") return this.answer({ id, ok: false, error: MODE_UNAVAILABLE });
    this.pending.push({ request, failed: 0 });
    void this.work();
  }

  // The turn-gated requests, oldest first, one at a time, each once no turn runs.
  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      for (let head = this.pending[0]; head && !this.turnRuns; head = this.pending[0]) {
        const outcome = await this.run(head);
        if (outcome === undefined) return;
        this.pending.shift();
        await this.answer(outcome);
      }
    } finally {
      this.working = false;
    }
  }

  // undefined: not done, tried again at the next poll.
  private async run(head: Pending): Promise<Response | undefined> {
    const { request } = head;
    try {
      if (request.op === "rename") {
        const name = typeof request.args.name === "string" ? request.args.name.replace(/\s+/g, " ").trim() : "";
        if (name === "") return { id: request.id, ok: false, error: "args.name must be a non-empty string" };
        await this.deps.rename(name);
        return { id: request.id, ok: true, result: { name } };
      }
      if (request.op === "autocompact") {
        const window = request.args.window;
        if (window !== "auto" && !(typeof window === "number" && Number.isSafeInteger(window) && window > 0)) {
          return { id: request.id, ok: false, error: 'args.window must be a positive integer or "auto"' };
        }
        const text = (await this.deps.autocompact(window))?.trim();
        return { id: request.id, ok: true, result: text ? { window, text } : { window } };
      }
      const instructions = typeof request.args.instructions === "string" ? request.args.instructions : undefined;
      const compaction = await this.deps.compact(instructions);
      return { id: request.id, ok: true, result: compaction };
    } catch (e) {
      // Rejected with a turn running, or one just starting: tried again.
      if (request.op === "compact" && (this.turnRuns || ++head.failed < COMPACT_TRIES)) return undefined;
      return { id: request.id, ok: false, error: errorText(e) };
    }
  }

  // Writes the response, then removes the request; an id whose request could not be removed stays seen.
  private async answer(response: Response): Promise<void> {
    try {
      await this.deps.writeAtomic(`${this.dir}/${RESPONSES_DIR}/${response.id}${RESPONSE_SUFFIX}`, responseText(response));
      await this.deps.remove(`${this.dir}/${REQUESTS_DIR}/${response.id}.json`);
      this.seen.delete(response.id);
      this.claimed.delete(response.id);
    } catch {
      // The answer is not written or the request not removed: the id stays seen, so it is not run twice.
    }
  }
}
