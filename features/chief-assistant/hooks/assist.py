"""Stop hook: the chief engineer's assistant checks that the session does not stop with agreed work left.

The session sometimes ends a turn although nothing blocks it, no question is pending, no background task
runs and the active plan has open items; it then idles until the user asks for progress. Reflection does
not see this: its checks cover what the user asked in the turn, and it skips wake-started turns on purpose.
This hook runs at the end of every turn of the main session, wake-started ones included (asyncRewake: the
answer has already gone out; exit 2 with the reason on stderr wakes the session).

Legit stops are decided in code without a model call: a poll is pending, a background task the session
launched still runs, no plan was touched by the session (or it is gone), the wake limit is reached.
Whether a background task runs is answered by the shared module of the subagent-tasks-guard feature
(features/subagent-tasks-guard/hooks/subagent_tasks.py), never by a heuristic of this hook: the Stop payload's
own background_tasks list is the truth when it is present, otherwise the transcript decides.
Otherwise one cheap model (Haiku, through reflect.ask, the call reflection uses) reads the plans, the user's
rules, the latest user messages and the current turn, and answers ok or idle. Idle wakes the session with
the next item. Transcript parsing, rules loading and the model call are shared with reflection
(features/reflection/hooks/reflect.py); reflection's own behaviour is not touched.

The model takes up to a minute, so its verdict can be stale when it arrives: the user may have written, or a
new turn may have begun. A verdict is bound to one identified stop. The Stop payload names no turn or message
(it holds session_id, transcript_path, cwd, last_assistant_message, background_tasks and the like, no prompt id
and no message uuid) and the final record may reach the transcript late, so the stop is identified from the
transcript's own chain: every user, assistant and system record carries uuid and parentUuid in one line. The
boundary is taken before anything else is read: the byte offset after the last complete line, the last main-chain
record (the tail) and the records chained to it. The stop id is the parent of the final assistant message when it
has landed, else the tail itself, which is that same parent. The scan reads up to the boundary only. The verdict
is accepted only if everything appended after the boundary is bookkeeping (system records, other attachments) or
the late write of the final message itself: a single assistant record without tool call that continues the chain
and holds the final text, with at most thinking records before it. Text equality alone never counts.

The check, the wake count and the per-session record of the woken stop (wakes.json: stop id, boundary offset,
wake count) are one step under a file lock. The wake count lives in that record, because the transcript lags: two
checks for two stops must not both issue a wake past the limit, and a stop already woken is never woken twice.
The record's count is dropped when the user wrote (or answered a poll) after the boundary it was saved at.

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
# Loop guard. The session may stop idle again right after a wake, and a stop at the same point is woken
# again: the hook never suppresses a repeat. But a session that ignores the wakes must not be woken for
# ever, so at most MAX_WAKES wakes in a row without a message of the user in between. The last of them
# asks the session to tell the user which item it stands on and why it keeps stopping; after that the
# hook stays silent until the user writes. Only the user's own messages (and answers to polls) reset the
# count; reflection's wakes and task notifications neither count nor reset it.
MAX_WAKES = 3
PLAN_LIMIT = 12_000  # Characters of one plan sent to the model; a plan is a short working document.
PLAN_BUDGET = 4 * PLAN_LIMIT  # All plans together: four full-size plans, so one active plan plus a few it read for reference.
PLAN_DIR = "docs/superpowers/plans/"
PLAN_TOOLS_EDIT = ("Edit", "Write", "MultiEdit")
MENTION_DEPTH = 8  # How deep into a tool input (agent prompts, nested fields) plan names are searched.
# A plan named in any string of a tool input, in any spelling: absolute or relative, either slash direction (the text
# is searched after its backslashes became slashes). The name must end at `.md`: not `.md.bak`, not `.mdx`.
PLAN_PATH = re.compile(r"""(?:[A-Za-z]:)?[^\s"'`<>|*?(),;=]*?docs/superpowers/plans/[^\s"'`<>|*?/\\()]+?\.md(?![\w-]|\.\w)""")
REDIRECT_INTO_PLAN = re.compile(r"""\d?>>?\s*["']?[^\s"']*docs/superpowers/plans/""")
WRITE_WORDS = re.compile(r"(?i)\b(?:set-content|add-content|out-file|tee|patch|patchlib|write_text|write|truncate)\b|\bsed\s+-[a-z]*i")
NOTE_MARK = "<task-notification>"
# Only these record types matter; every other line of a (possibly huge) transcript is skipped before parsing.
RECORD = re.compile(r'"type"\s*:\s*"(?:user|assistant|attachment)"')
TAIL_WINDOW = 1 << 16  # Bytes read from the end of the transcript to find the stop; the window grows until the tail record is in it.
STATE_SESSIONS = 50 # Sessions kept in wakes.json; the oldest are dropped.
LOCK_NAME = "state.lock"
STATE_NAME = "wakes.json"
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
    `docs/superpowers/plans/<name>.md`. A plan is edited when an edit tool names it in `file_path`, or a shell command
    that names it also writes; any other mention is a read."""
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
        writes = text is command and writes_a_plan(normal)
        for match in PLAN_PATH.finditer(normal):
            path = canonical(match.group(0), cwd, cache)
            if path is not None:
                found.append((path, writes))
    return found


def writes_a_plan(command: str) -> bool:
    """Whether a shell command that names a plan also writes: a redirect into a plan, or a writing command word. The
    plan paths are cut out first, so a plan named `write-up.md` is not a write."""
    return bool(REDIRECT_INTO_PLAN.search(command) or WRITE_WORDS.search(PLAN_PATH.sub(" ", command)))


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
      wakes       the consecutive wakes of this hook the transcript shows since the user's last message
      reset_at    the byte offset where the line of the user's latest message (or poll answer) starts; -1 when none
      poll        whether a poll is pending
      background  (id, info) of the background tasks the session launched that still run
      point       the byte offset after the last line read
    Subagent (sidechain) records are not the session's own and are skipped."""
    edited: dict[Path, bool] = {}
    read: dict[Path, bool] = {}
    cache: dict = {}
    wakes = 0
    reset_at = -1
    polls: set[str] = set()
    tasks = subagent_tasks.Tasks()
    point = 0
    with transcript.open("rb") as f:
        for raw in f:
            line = raw.decode("utf-8", errors="replace")
            if limit is not None and point + len(raw) > limit:
                break  # past the stop point: whatever is there is not part of what the verdict is about
            if limit is None and not raw.endswith(b"\n") and parsed(line) is None:
                break  # a record still being written
            start = point
            point += len(raw)
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
                            wakes = 0  # the user answered the poll
                            reset_at = start
                elif kind == "user":
                    if OWN_MARKER in data:
                        wakes += 1
                    elif reflect.WAKE_MARKER in data or NOTE_MARK in data:
                        pass  # reflection's wake and task notifications (finishing tasks is the tasks module's business)
                    else:
                        text = reflect.REMINDER.sub("", data).strip()
                        if text and reflect.is_users(text):
                            wakes = 0
                            reset_at = start
                            polls.clear()
    ordered = list(reversed(edited)) + [p for p in reversed(read) if p not in edited]
    if isinstance(background_tasks, list):
        background = subagent_tasks.live_by_background_list(tasks, background_tasks, None)
    else:
        background = subagent_tasks.live_by_transcript(tasks)
    return {"plans": [p for p in ordered if p.is_file()], "wakes": wakes, "reset_at": reset_at, "poll": bool(polls),
            "background": background, "point": point}


def last_records(transcript: Path, size: int) -> tuple[list[tuple[int, dict]], int, bool]:
    """The complete lines at the end of the first `size` bytes of the file, as (offset, record), read in growing
    windows until a record of the main chain (a user or assistant record) is among them. Also the offset after the last
    complete line (a last line that is not valid JSON and has no newline is still being written) and whether the
    window reached the file start."""
    window = TAIL_WINDOW
    while True:
        start = max(0, size - window)
        with transcript.open("rb") as f:
            f.seek(start)
            data = f.read(size - start)
        pieces = data.splitlines(keepends=True)
        offset = start
        if start > 0 and pieces:
            offset += len(pieces[0])  # a window can begin inside a line
            pieces = pieces[1:]
        rows: list[tuple[int, dict]] = []
        point = offset
        for raw in pieces:
            record = parsed(raw.decode("utf-8", errors="replace"))
            if not raw.endswith(b"\n") and record is None:
                break
            if record is not None:
                rows.append((offset, record))
            offset += len(raw)
            point = offset
        if start == 0 or any(r.get("type") in ("user", "assistant") and not r.get("isSidechain") for _, r in rows):
            return rows, point, start == 0
        window *= 4


def boundary_of(transcript: Path, final: str) -> dict:
    """The stop this check is about, fixed before anything else of the transcript is read. Returns:
      point          the byte offset after the last complete line
      tail           the last record of the main chain (user or assistant), or None
      chain          the uuids that belong to the stop: the tail and the system or attachment records chained to it
      tail_is_final  whether the tail is the final assistant message itself (it has already landed in the file)
      stop           the identity of the stop: the parent of the final message when it has landed, else the tail itself
                     (which is that same parent, so a final message landing later keeps the id)
    A transcript with no uuids falls back to the offset."""
    size = transcript.stat().st_size
    rows, point, _ = last_records(transcript, size)
    tail = None
    chain: set[str] = set()
    for _, record in rows:
        if record.get("isSidechain"):
            continue
        kind = record.get("type")
        uuid = record.get("uuid")
        if kind in ("user", "assistant"):
            tail = record
            chain = {uuid} if uuid else set()
        elif kind in ("system", "attachment") and uuid and record.get("parentUuid") in chain:
            if kind == "attachment" and (record.get("attachment") or {}).get("type") == "queued_command":
                continue
            chain.add(uuid)
    is_final = False
    if tail is not None and tail.get("type") == "assistant" and final:
        text, has_call = record_text(tail)
        is_final = not has_call and text.strip() == final.strip()
    if tail is None or not tail.get("uuid"):
        stop = f"offset:{point}"
    elif is_final and tail.get("parentUuid"):
        stop = tail["parentUuid"]
    else:
        stop = tail["uuid"]
    return {"point": point, "chain": sorted(chain), "tail_is_final": is_final, "stop": stop}


def normalized(item: str) -> str:
    return " ".join(item.lower().split())


def wake_text(answer: dict, wakes: int) -> str:
    item = answer.get("item") or answer.get("evidence") or "the open item"
    head = f"{OWN_MARKER} You ended your turn, but agreed work is still open ({item}): {answer.get('evidence', '')}."
    step = f"Next step: {answer.get('next', '')}"
    if wakes >= MAX_WAKES - 1:
        return (f"{head} This is the last reminder you get until the user writes. First write the user plainly, in their language, "
                f"which plan item you stand on ({item}) and why you keep stopping. {step} Then do it, or say exactly what blocks you.")
    return f"{head} {step} Do that now. If you are blocked or waiting on the user, say exactly what blocks you."


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


def model_text(payload: dict, transcript: Path, found: dict, events: list[dict], wakes: int | None = None) -> str:
    users = [e for e in events if e["kind"] in reflect.USER_KINDS and OWN_MARKER not in e["text"] and reflect.WAKE_MARKER not in e["text"]]
    latest = "\n".join(reflect.line_of(e, reflect.CALL_LIMIT, reflect.RESULT_LIMIT, reflect.TEXT_LIMIT) for e in users[-reflect.USER_MESSAGES:])
    return "\n\n".join([
        f"RULES\n{reflect.rules(payload, transcript)}",
        f"PLANS\n{plans_text(found['plans'])}",
        f"WAKES\n{found['wakes'] if wakes is None else wakes} consecutive wake(s) of yours since the user's last message",
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
    """Excludes every other check of this hook (threads and processes) while the verdict is checked and recorded.
    The lock file stays on disk; only the lock on it is taken and released."""
    with THREAD_LOCK:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with (STATE_DIR / LOCK_NAME).open("a+b") as handle:
            lock_file(handle)
            try:
                yield
            finally:
                unlock_file(handle)


def _read_state() -> dict:
    try:
        state = json.loads((STATE_DIR / STATE_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return state if isinstance(state, dict) else {}


def load_state() -> dict:
    """Per session, the stop the hook last woke the session at (its identity and byte offset) and the wakes in a row
    so far. A missing or broken file reads as empty."""
    return _read_state()


def save_state(state: dict) -> None:
    """Writes a temp file and replaces wakes.json with it, so a reader never sees half a file."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    temp = STATE_DIR / f"{STATE_NAME}.tmp-{os.getpid()}-{threading.get_ident()}"
    try:
        temp.write_text(json.dumps(state), encoding="utf-8")
        os.replace(temp, STATE_DIR / STATE_NAME)
    finally:
        temp.unlink(missing_ok=True)


def record_text(record: dict) -> tuple[str, bool]:
    """The text blocks of an assistant record joined, and whether it holds a tool call."""
    message = record.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return content, False
    blocks = [b for b in content if isinstance(b, dict)] if isinstance(content, list) else []
    texts = [b.get("text") for b in blocks if b.get("type") == "text" and isinstance(b.get("text"), str)]
    return "\n".join(texts), any(b.get("type") == "tool_use" for b in blocks)


def appended_after(transcript: Path, boundary: dict, final: str) -> bool:
    """Whether the transcript grew past the stop (boundary_of) with anything but the stop's own tail: a record of the
    user, an assistant record that is a tool call or does not hang off the stop's chain, a second final text, or a
    queued command. The final message itself may land in the file late (the hook starts when the turn ends, the file is
    written a moment later), chained to the stop: that one record, and the system and attachment records chained to the
    stop, are not new. A record without a uuid (queue bookkeeping) is not activity."""
    accepted_text = bool(boundary["tail_is_final"])
    chain = set(boundary["chain"])
    with transcript.open("rb") as f:
        f.seek(boundary["point"])
        tail = f.read()
    for raw in tail.splitlines():
        record = parsed(raw.decode("utf-8", errors="replace"))
        if record is None or record.get("isSidechain"):
            continue
        kind = record.get("type")
        uuid = record.get("uuid")
        if kind == "user":
            return True
        if kind == "assistant":
            text, has_call = record_text(record)
            if has_call or record.get("parentUuid") not in chain:
                return True
            if text:
                if accepted_text or not final or text.strip() != final.strip():
                    return True
                accepted_text = True
            if uuid:
                chain.add(uuid)
        elif kind == "attachment" and (record.get("attachment") or {}).get("type") == "queued_command":
            return True
        elif kind in ("system", "attachment") and uuid and record.get("parentUuid") in chain:
            chain.add(uuid)
    return False


def effective_wakes(found: dict, previous: object) -> int:
    """The consecutive wakes: what the transcript shows, or what the locked state recorded when that is more (a wake
    just issued may not be in the file yet), as long as the user has not written since the state's stop."""
    if isinstance(previous, dict) and isinstance(previous.get("count"), int) and found["reset_at"] < previous.get("point", 0):
        return max(found["wakes"], previous["count"])
    return found["wakes"]


def commit_wake(key: str, boundary: dict, transcript: Path, final: str, found: dict) -> tuple[str, int]:
    """Decides under the lock whether the verdict still stands and, if so, records the woken stop and the wake count.
    Returns the outcome ("wake", "superseded": the transcript grew past the stop, "duplicate": this stop was already
    woken, "wake-limit": the wakes in a row are used up) and the wakes before this one."""
    with state_lock():
        if appended_after(transcript, boundary, final):
            return "superseded", found["wakes"]
        state = load_state()
        previous = state.get(key)
        count = effective_wakes(found, previous)
        if isinstance(previous, dict) and previous.get("stop") == boundary["stop"]:
            return "duplicate", count
        if count >= MAX_WAKES:
            return "wake-limit", count
        state.pop(key, None)
        state[key] = {"stop": boundary["stop"], "point": boundary["point"], "count": count + 1, "at": now().isoformat(timespec="seconds")}
        save_state(dict(list(state.items())[-STATE_SESSIONS:]))
    return "wake", count


def assess(payload: dict) -> str | None:
    """The wake text when the session stopped with agreed work left, else None. Logs every decision."""
    started = time.monotonic()
    session = payload.get("session_id")
    transcript = reflect.resolve_transcript(payload.get("transcript_path"), session)
    if not transcript.is_file():
        log({"session": session, "decision": "no-transcript"})
        return None
    cwd = payload.get("cwd") or "."
    final = payload.get("last_assistant_message") or ""
    boundary = boundary_of(transcript, final)  # the stop is fixed first: everything below is about this stop only
    found = scan(transcript, cwd, payload.get("background_tasks"), limit=boundary["point"])
    key = session or transcript.stem
    wakes = effective_wakes(found, _read_state().get(key))
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
    outcome, before = commit_wake(key, boundary, transcript, final_message(payload, events), found)
    seconds = round(time.monotonic() - started, 2)
    if outcome != "wake":
        reasons = {"superseded": "the transcript grew while the model was thinking", "duplicate": "this stop was already woken",
                   "wake-limit": f"{before} wakes in a row without a message of the user"}
        log({**entry, "wakes": before, "decision": outcome, "cost": cost, "seconds": seconds, "reason": reasons[outcome]})
        return None
    point = normalized(answer.get("item") or answer.get("next") or "")
    log({**entry, "wakes": before, "decision": "idle", "verdict": "idle", "cost": cost, "seconds": seconds, "reason": answer.get("evidence", ""), "idle_point": point})
    return wake_text(answer, before)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    payload = json.load(sys.stdin)
    if skipped(payload):
        return
    try:
        text = assess(payload)
    except Exception as e:  # a broken assistant must never hold the turn
        log({"session": payload.get("session_id"), "decision": "crashed", "error": f"{type(e).__name__}: {str(e)[:300]}"})
        return
    if text:
        sys.stderr.reconfigure(encoding="utf-8")
        sys.stderr.write(text)
        sys.exit(WAKE_EXIT)


if __name__ == "__main__":
    main()
