"""Stop hook: the chief engineer's assistant checks that the session does not stop with agreed work left.

The session sometimes ends a turn although nothing blocks it, no question is pending, no background task
runs and the active plan has open items; it then idles until the user asks for progress. Reflection does
not see this: its checks cover what the user asked in the turn, and it skips wake-started turns on purpose.
This hook runs at the end of every turn of the main session, wake-started ones included (asyncRewake: the
answer has already gone out; exit 2 with the reason on stderr wakes the session).

Legit stops are decided in code without a model call: a poll is pending, a background task still runs, no plan
was touched by the session (or it is gone), the wake limit is reached. The Stop payload's own background_tasks
list is the truth about background tasks when it is present (every running entry counts, the hook's own
included: silence is the safe side); without it the shared module of the subagent-tasks-guard feature reads
the transcript. Otherwise one cheap model (Haiku, through reflect.ask, the call reflection uses) reads the
plans, the user's rules, the latest user messages and the current turn, and answers ok or idle. Idle wakes the
session with the next item. Transcript parsing, rules loading and the model call are shared with reflection
(features/reflection/hooks/reflect.py); reflection's own behaviour is not touched.

The wake does not act by itself: it reaches the main session, which knows the whole context and decides, and
its text tells the session to ignore the wake when the user has written since or work is running. So the hook
does not try to make a wake exactly correct against a transcript that is written concurrently; it fails closed.
The transcript size is taken when the hook starts (a last line without its newline means the stop cannot be
identified: silent). The model takes up to a minute; before the wake is emitted, everything appended after that
size must be the stop's own bookkeeping: system records, attachments that are not queued input, and at most one
assistant record with text and no tool call (the final message landing late). Anything else, a half-written
line included, means the verdict is superseded: silent.

The check, the wake counter and the emission are one step under a file lock. The counter is one small file per
session (wakes-<session>.json: count and the transcript size at the last wake). At most MAX_WAKES wakes in a
row; a message of the user (or a poll answer) newer than the last wake resets it.

Every decision goes to ~/.claude/chief-assistant/log.jsonl with its verdict, cost, time and reason; an idle
verdict also carries idle_point (the open item, normalized), so repeats at one point can be counted.

Input: hook JSON on stdin. Output: exit 2 with the wake text on stderr, or exit 0 with nothing.
"""

import contextlib
import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "reflection" / "hooks"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "subagent-tasks-guard" / "hooks"))
import reflect  # noqa: E402
import subagent_tasks  # noqa: E402

STATE_DIR = Path.home() / ".claude" / "chief-assistant"
LOG_FILE = STATE_DIR / "log.jsonl"
PROMPT_FILE = Path(__file__).with_name("assist_prompt.md")
MODEL = "haiku"
VERDICTS = ["ok", "idle"]
SCHEMA = json.dumps({
    "type": "object",
    "properties": {
        "verdict": {"enum": VERDICTS},
        "next": {"type": "string"},
        "item": {"type": "string"},
        "evidence": {"type": "string"},
    },
    "required": ["verdict", "next", "item", "evidence"],
    "additionalProperties": False,
})
WAKE_EXIT = 2
OWN_MARKER = "[chief-assistant]"
# Loop guard: a session that ignores the wakes must not be woken for ever, so at most MAX_WAKES wakes in a row
# without a message of the user in between. The last one asks the session to tell the user which item it stands
# on and why it keeps stopping; after that the hook stays silent until the user writes. Only the user's own
# messages (and answers to polls) reset the count; reflection's wakes and task notifications do not.
MAX_WAKES = 3
PLAN_LIMIT = 12_000  # Characters of one plan sent to the model; a plan is a short working document.
PLAN_BUDGET = 4 * PLAN_LIMIT  # All plans together: four full-size plans, so one active plan plus a few it read for reference.
PLAN_DIR = "docs/superpowers/plans/"
PLAN_TOOLS_EDIT = ("Edit", "Write", "MultiEdit")
MENTION_DEPTH = 8  # How deep into a tool input (agent prompts, nested fields) plan names are searched.
# A plan named in a string of a tool input, in any spelling: absolute or relative, either slash direction (the text
# is searched after its backslashes became slashes), in subfolders of the plans folder. The name must end at `.md`:
# not `.md.bak`, not `.mdx`. PLAN_PATH finds unquoted names; QUOTED_PLAN a quoted path, which may hold spaces.
PLAN_PATH = re.compile(r"""(?:[A-Za-z]:)?[^\s"'`<>|*?(),;=]*?docs/superpowers/plans/(?:[^\s"'`<>|*?()]+?/)*[^\s"'`<>|*?/()]+?\.md(?![\w-]|\.\w)""")
QUOTED_PLAN = re.compile(r"""(["'])((?:(?!\1).)*?docs/superpowers/plans/(?:(?!\1).)*?\.md)\1""")
REDIRECT_INTO_PLAN = re.compile(r"""\d?>>?\s*(?:"[^"]*|'[^']*|[^\s"']*)docs/superpowers/plans/""")
WRITE_WORDS = re.compile(r"(?i)\b(?:set-content|add-content|out-file|tee|patch|patchlib|write_text|write|truncate)\b|\bsed\s+-[a-z]*i")
# Only these record types matter; every other line of a (possibly huge) transcript is skipped before parsing.
RECORD = re.compile(r'"type"\s*:\s*"(?:user|assistant|attachment)"')
LOCK_NAME = "state.lock"
LOCK_WAIT = 30.0  # Seconds to wait for the state lock (the hook's own timeout is 330).
LOCK_RETRY = 0.02
THREAD_LOCK = threading.Lock()  # The file lock does not exclude threads of one process on every platform.


def now() -> datetime:
    return datetime.now(timezone.utc)


def log(entry: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    entry = {"at": now().isoformat(timespec="seconds"), **entry}
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def skipped(payload: dict) -> bool:
    """Claude's own non-interactive runs and the reviewer's own runs. stop_hook_active is not looked at:
    the loop guard bounds the wakes, and a turn that a wake started must be checked too."""
    entry = os.environ.get("CLAUDE_CODE_ENTRYPOINT", "")
    return bool(os.environ.get(reflect.CHILD_ENV)) or entry.startswith("sdk") or os.environ.get("CLAUDE_CODE_SESSION_ATTENDED") == "0"


def canonical(text: str, cwd: str, cache: dict) -> Path | None:
    """The existing plan file a path spelling names (absolute or relative to the project, either slash direction,
    MSYS `/e/...` on Windows), as its resolved full path; None when no such file exists. The resolved path is the
    plan's identity, so every spelling of one file is one plan."""
    key = (text, cwd)
    if key in cache:
        return cache[key]
    normal = text.replace("\\", "/")
    if os.name == "nt":
        normal = re.sub(r"^/([A-Za-z])/", r"\1:/", normal)
    path = Path(normal)
    if not path.is_absolute():
        path = Path(cwd) / path
    try:
        found = path.resolve() if path.is_file() else None
    except OSError:
        found = None
    cache[key] = found
    return found


def strings_of(value: object, depth: int = 0):
    """Every string inside a tool input, nested dicts and lists included."""
    if isinstance(value, str):
        yield value
    elif depth < MENTION_DEPTH and isinstance(value, dict):
        for item in value.values():
            yield from strings_of(item, depth + 1)
    elif depth < MENTION_DEPTH and isinstance(value, list):
        for item in value:
            yield from strings_of(item, depth + 1)


def plan_mentions(name: str, args: object, cwd: str, cache: dict) -> list[tuple[Path, bool]]:
    """Every existing plan file a tool call of the main session refers to, as (resolved path, edited). Any string of
    the input can name a plan (a shell command, an agent's prompt, a nested field), not only `file_path`. The
    `file_path` of the file tools is an exact path (it may hold spaces); every other string is searched for
    `docs/superpowers/plans/<name>.md`, quoted or not. A plan is edited when an edit tool names it in `file_path`,
    or a shell command that names it also writes (a redirect into a plan, or a writing command word outside the
    plan names, so a plan called `write-up.md` is not a write); any other mention is a read."""
    if not isinstance(args, dict):
        return []
    found: list[tuple[Path, bool]] = []
    direct = args.get("file_path")
    if isinstance(direct, str) and PLAN_DIR in direct.replace("\\", "/") and direct.endswith(".md"):
        path = canonical(direct, cwd, cache)
        if path is not None:
            found.append((path, name in PLAN_TOOLS_EDIT))
    command = args.get("command")
    for text in strings_of({key: value for key, value in args.items() if key != "file_path"}):
        normal = text.replace("\\", "/")
        if PLAN_DIR not in normal:
            continue
        quoted = [m.group(2).strip() for m in QUOTED_PLAN.finditer(normal)]
        bare = [m.group(0) for m in PLAN_PATH.finditer(normal)]
        paths = {span: canonical(span, cwd, cache) for span in quoted + bare}
        writes = False
        if text is command:
            rest = normal  # a quoted span that is no file (`bash -c "sed -i ... plan"`) may hold the write word
            for span in bare + [s for s in quoted if paths[s] is not None]:
                rest = rest.replace(span, " ")
            writes = bool(REDIRECT_INTO_PLAN.search(normal) or WRITE_WORDS.search(rest))
        found.extend((path, writes) for path in paths.values() if path is not None)
    return found


def parsed(line: str) -> dict | None:
    try:
        record = json.loads(line)
    except ValueError:
        return None
    return record if isinstance(record, dict) else None


def touch(plans: dict, path: Path) -> None:
    """Records a plan use; the dict order is the recency order (the latest use last)."""
    plans.pop(path, None)
    plans[path] = True


def scan(transcript: Path, cwd: str, background_tasks: object = None, limit: int | None = None) -> dict:
    """One streaming pass over the transcript up to `limit` bytes (the stop point; the whole file when None). It can
    be hundreds of MB, so lines of other record types are skipped before parsing. Every record is judged block by
    block: a user record holding a tool result and the user's own text counts for both. Returns:
      plans       the existing plan files the session edited (latest first), then those it only referred to (latest first)
      reset_at    the byte offset where the line of the user's latest message (or poll answer) starts; -1 when none
      poll        whether a poll is pending
      background  (id, info) of the background tasks that still run: every running entry of the Stop payload's own
                  list when it is given, else the tasks the session launched by the transcript
    Subagent (sidechain) records are not the session's own and are skipped."""
    edited: dict[Path, bool] = {}
    read: dict[Path, bool] = {}
    cache: dict = {}
    reset_at = -1
    polls: set[str] = set()
    tasks = subagent_tasks.Tasks()
    point = 0
    with transcript.open("rb") as f:
        for raw in f:
            if limit is not None and point + len(raw) > limit:
                break  # past the stop point: whatever is there is not part of what the verdict is about
            start = point
            point += len(raw)
            line = raw.decode("utf-8", errors="replace")
            if not RECORD.search(line):
                continue
            record = parsed(line)
            if record is None or record.get("isSidechain"):
                continue
            tasks.feed(record)
            for kind, stamp, data in reflect.line_events([line]):
                if kind == "tool_use":
                    name, args, ident = data.get("name"), data.get("input"), data.get("id", "")
                    if name == reflect.POLL_TOOL:
                        polls.add(ident)
                    else:
                        for path, writes in plan_mentions(name, args, cwd, cache):
                            touch(edited if writes else read, path)
                elif kind == "tool_result":
                    ident = data.get("tool_use_id", "")
                    if ident in polls:
                        polls.discard(ident)
                        if not data.get("is_error"):
                            reset_at = start  # the user answered the poll
                elif kind == "user":
                    if OWN_MARKER in data or reflect.WAKE_MARKER in data:
                        continue  # the wakes of this hook and of reflection are not the user's messages (is_users drops notifications)
                    text = reflect.REMINDER.sub("", data).strip()
                    if text and reflect.is_users(text):
                        reset_at = start
                        polls.clear()
    ordered = list(reversed(edited)) + [p for p in reversed(read) if p not in edited]
    if isinstance(background_tasks, list):
        background = [(e.get("id"), e) for e in background_tasks if isinstance(e, dict) and e.get("status") == subagent_tasks.RUNNING]
    else:
        background = subagent_tasks.live_by_transcript(tasks)
    return {"plans": [p for p in ordered if p.is_file()], "reset_at": reset_at, "poll": bool(polls), "background": background}


def record_text(record: dict) -> tuple[str, bool]:
    """The text blocks of an assistant record joined, and whether it holds a tool call."""
    message = record.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return content, False
    blocks = [b for b in content if isinstance(b, dict)] if isinstance(content, list) else []
    texts = [b.get("text") for b in blocks if b.get("type") == "text" and isinstance(b.get("text"), str)]
    return "\n".join(texts), any(b.get("type") == "tool_use" for b in blocks)


def ends_cleanly(transcript: Path, size: int) -> bool:
    """Whether the first `size` bytes end at a line end; otherwise the stop cannot be identified (a line is being written)."""
    if size <= 0:
        return False
    with transcript.open("rb") as f:
        f.seek(size - 1)
        return f.read(1) == b"\n"


def grew_beyond(transcript: Path, size: int) -> bool:
    """Whether the transcript holds, after its first `size` bytes, anything but the stop's own bookkeeping: system
    records, attachments that are not queued input, and one assistant record with text and no tool call (the final
    message landing late). Anything else (a user record, a tool call, a second text, a record of another type, a line
    that is not complete JSON) means the verdict may be stale, and a doubt counts as stale."""
    with transcript.open("rb") as f:
        f.seek(size)
        data = f.read()
    if not data:
        return False
    if not data.endswith(b"\n"):
        return True
    texts = 0
    for raw in data.splitlines():
        record = parsed(raw.decode("utf-8", errors="replace"))
        if record is None:
            return True
        kind = record.get("type")
        if kind == "assistant":
            text, call = record_text(record)
            texts += bool(text)
            if call or texts > 1:
                return True
        elif kind == "attachment":
            if (record.get("attachment") or {}).get("type") == "queued_command":
                return True
        elif kind != "system":
            return True
    return False


def normalized(item: str) -> str:
    return " ".join(item.lower().split())


def wake_text(answer: dict, wakes: int) -> str:
    item = answer.get("item") or answer.get("evidence") or "the open item"
    head = (f"{OWN_MARKER} You ended your turn, but agreed work seems to be still open ({item}): {answer.get('evidence', '')}. "
            "First check whether the user has written since or work is running (a background task, an agent); if so, ignore this "
            "reminder and answer it with one short line at most.")
    step = f"Next step: {answer.get('next', '')}"
    if wakes >= MAX_WAKES - 1:
        return (f"{head} Otherwise this is the last reminder you get until the user writes. Write the user plainly, in their language, "
                f"which plan item you stand on ({item}) and why you keep stopping. {step} Then do it, or say exactly what blocks you.")
    return f"{head} Otherwise: {step} Do that now. If you are blocked or waiting on the user, say exactly what blocks you."


def plans_text(plans: list[Path]) -> str:
    """The plans in order (the most relevant first), each cut to PLAN_LIMIT, while their total stays within
    PLAN_BUDGET. The plans that no longer fit are named in one line, so the model knows they exist and can Read them."""
    shown: list[str] = []
    used = 0
    omitted: list[Path] = []
    for index, path in enumerate(plans):
        text = path.read_text(encoding="utf-8", errors="replace")
        size = min(len(text), PLAN_LIMIT)  # the clip note is not plan text and does not count
        if used + size > PLAN_BUDGET:
            omitted = plans[index:]
            break
        used += size
        shown.append(f"--- {path}\n{reflect.clip(text, PLAN_LIMIT)}")
    if omitted:
        shown.append("PLANS NOT SHOWN (the size budget is spent; open one with Read if it matters): " + ", ".join(str(p) for p in omitted))
    return "\n\n".join(shown)


def final_message(payload: dict, events: list[dict]) -> str:
    return payload.get("last_assistant_message") or next((e["text"] for e in reversed(events) if e["kind"] == "assistant"), "")


def model_text(payload: dict, transcript: Path, found: dict, events: list[dict], wakes: int) -> str:
    users = [e for e in events if e["kind"] in reflect.USER_KINDS and OWN_MARKER not in e["text"] and reflect.WAKE_MARKER not in e["text"]]
    latest = "\n".join(reflect.line_of(e, reflect.CALL_LIMIT, reflect.RESULT_LIMIT, reflect.TEXT_LIMIT) for e in users[-reflect.USER_MESSAGES:])
    return "\n\n".join([
        f"RULES\n{reflect.rules(payload, transcript)}",
        f"PLANS\n{plans_text(found['plans'])}",
        f"WAKES\n{wakes} consecutive wake(s) of yours since the user's last message",
        f"USER'S LATEST MESSAGES\n{latest or '(none)'}",
        f"THIS TURN\n{reflect.conversation(reflect.current_turn(events))}",
        f"FINAL MESSAGE\n{reflect.clip(final_message(payload, events), reflect.CONVERSATION_BUDGET)}",
    ])


def lock_file(handle) -> None:
    deadline = time.monotonic() + LOCK_WAIT
    handle.seek(0)
    if os.name == "nt":
        import msvcrt
        while True:
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                return
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("the chief-assistant state lock is held too long")
                time.sleep(LOCK_RETRY)
    import fcntl
    while True:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return
        except OSError:
            if time.monotonic() >= deadline:
                raise TimeoutError("the chief-assistant state lock is held too long")
            time.sleep(LOCK_RETRY)


def unlock_file(handle) -> None:
    handle.seek(0)
    if os.name == "nt":
        import msvcrt
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@contextlib.contextmanager
def state_lock():
    """Excludes every other check of this hook (threads and processes) while the verdict is checked, counted and
    emitted. The lock file stays on disk; only the lock on it is taken and released."""
    with THREAD_LOCK:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with (STATE_DIR / LOCK_NAME).open("a+b") as handle:
            lock_file(handle)
            try:
                yield
            finally:
                unlock_file(handle)


def counter_file(key: str) -> Path:
    return STATE_DIR / f"wakes-{re.sub(r'[^A-Za-z0-9_.-]', '_', key)[:100]}.json"


def read_count(key: str, found: dict) -> int:
    """The wakes in a row of this session: the saved count, unless the user wrote (or answered a poll) after the
    transcript size it was saved at. A missing or broken file reads as zero."""
    try:
        state = json.loads(counter_file(key).read_text(encoding="utf-8"))
        count, point = state["count"], state["point"]
    except (OSError, ValueError, KeyError, TypeError):
        return 0
    return count if isinstance(count, int) and isinstance(point, int) and found["reset_at"] < point else 0


def save_count(key: str, count: int, point: int) -> None:
    """Writes a temp file and replaces the counter with it, so a reader never sees half a file."""
    path = counter_file(key)
    temp = path.with_name(f"{path.name}.tmp-{os.getpid()}-{threading.get_ident()}")
    try:
        temp.write_text(json.dumps({"count": count, "point": point}), encoding="utf-8")
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def assess(payload: dict, emit=None) -> str | None:
    """The wake text when the session stopped with agreed work left, else None. `emit` gets the text inside the locked
    step that validated the verdict and counted the wake. Logs every decision."""
    started = time.monotonic()
    session = payload.get("session_id")
    transcript = reflect.resolve_transcript(payload.get("transcript_path"), session)
    if not transcript.is_file():
        log({"session": session, "decision": "no-transcript"})
        return None
    cwd = payload.get("cwd") or "."
    key = session or transcript.stem
    size = transcript.stat().st_size  # the stop point: everything below is about the transcript up to here
    if not ends_cleanly(transcript, size):
        log({"session": key, "decision": "unidentified", "reason": "the transcript ends inside a line"})
        return None
    found = scan(transcript, cwd, payload.get("background_tasks"), limit=size)
    wakes = read_count(key, found)
    entry = {"session": key, "cwd": cwd, "wakes": wakes}

    def settle(decision: str, reason: str = "") -> None:
        log({**entry, "decision": decision, "reason": reason, "seconds": round(time.monotonic() - started, 2)})

    if found["poll"]:
        settle("poll", "a poll waits for the user")
        return None
    if found["background"]:
        ids = ", ".join(str(ident) for ident, _ in found["background"])
        settle("background", f"{len(found['background'])} background task(s) still running: {ids}")
        return None
    if not found["plans"]:
        settle("no-plan", "the session touched no plan file")
        return None
    if wakes >= MAX_WAKES:
        settle("wake-limit", f"{wakes} wakes in a row without a message of the user")
        return None
    events = reflect.events_of(reflect.tail_lines(transcript))
    text = model_text(payload, transcript, found, events, wakes)
    dirs = list(dict.fromkeys(p.parent for p in found["plans"]))
    answer, cost, error = reflect.ask(MODEL, VERDICTS, text, cwd, dirs, started, prompt_file=PROMPT_FILE, schema_text=SCHEMA)
    seconds = round(time.monotonic() - started, 2)
    if answer is None:
        log({**entry, "decision": "failed", "cost": cost, "seconds": seconds, "reason": "", "error": error})
        return None
    if answer.get("verdict") != "idle":
        log({**entry, "decision": "ok", "verdict": "ok", "cost": cost, "seconds": seconds, "reason": answer.get("evidence", "")})
        return None
    with state_lock():
        if grew_beyond(transcript, size):
            outcome, before, wake = "superseded", wakes, None
        else:
            before = read_count(key, found)
            outcome = "wake-limit" if before >= MAX_WAKES else "wake"
            wake = wake_text(answer, before) if outcome == "wake" else None
            if wake:
                save_count(key, before + 1, size)
                if emit:
                    emit(wake)
    seconds = round(time.monotonic() - started, 2)
    if wake is None:
        reasons = {"superseded": "the transcript grew while the model was thinking", "wake-limit": f"{before} wakes in a row without a message of the user"}
        log({**entry, "wakes": before, "decision": outcome, "cost": cost, "seconds": seconds, "reason": reasons[outcome]})
        return None
    point = normalized(answer.get("item") or answer.get("next") or "")
    log({**entry, "wakes": before, "decision": "idle", "verdict": "idle", "cost": cost, "seconds": seconds, "reason": answer.get("evidence", ""), "idle_point": point})
    return wake


def write_wake(text: str) -> None:
    sys.stderr.reconfigure(encoding="utf-8")
    sys.stderr.write(text)
    sys.stderr.flush()


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    payload = json.load(sys.stdin)
    if skipped(payload):
        return
    try:
        text = assess(payload, write_wake)
    except Exception as e:  # a broken assistant must never hold the turn
        log({"session": payload.get("session_id"), "decision": "crashed", "error": f"{type(e).__name__}: {str(e)[:300]}"})
        return
    if text:
        sys.exit(WAKE_EXIT)


if __name__ == "__main__":
    main()
