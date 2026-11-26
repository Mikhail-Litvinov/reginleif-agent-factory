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
new turn may have begun. The verdict is accepted only if nothing but non-activity records was appended after
the stop point, and the check and the per-session record of the woken stop (wakes.json) are one step under a
file lock, so two checks of the same stop wake once.

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
PLAN_TOOLS_READ = ("Read",)
NOTE_MARK = "<task-notification>"
# Only these record types matter; every other line of a (possibly huge) transcript is skipped before parsing.
RECORD = re.compile(r'"type"\s*:\s*"(?:user|assistant|attachment)"')
STATE_SESSIONS = 50  # Sessions kept in wakes.json; the oldest are dropped.
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


def plan_path(args: object, cwd: str) -> Path | None:
    """The plan file a Read/Edit/Write call names, or None for any other file."""
    raw = args.get("file_path") if isinstance(args, dict) else None
    if not isinstance(raw, str):
        return None
    normal = raw.replace("\\", "/")
    if PLAN_DIR not in normal or not normal.endswith(".md"):
        return None
    path = Path(normal)
    return path if path.is_absolute() else Path(cwd) / path


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


def scan(transcript: Path, cwd: str, background_tasks: object = None) -> dict:
    """One streaming pass over the whole transcript (it can be hundreds of MB, so lines of other record types
    are skipped before parsing). Every record is judged block by block: a user record holding a tool result and
    the user's own text counts for both. Returns:
      plans       the existing plan files the session edited (latest first), then those it only read (latest first)
      wakes       the consecutive wakes of this hook since the user's last message
      poll        whether a poll is pending
      background  (id, info) of the background tasks the session launched that still run
      point       the byte offset after the last complete line: the stop point the verdict is about
    Subagent (sidechain) records are not the session's own and are skipped."""
    edited: dict[Path, bool] = {}
    read: dict[Path, bool] = {}
    wakes = 0
    polls: set[str] = set()
    tasks = subagent_tasks.Tasks()
    point = 0
    with transcript.open("rb") as f:
        for raw in f:
            line = raw.decode("utf-8", errors="replace")
            if not raw.endswith(b"\n") and parsed(line) is None:
                break  # a record still being written: the stop point is before it
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
                    elif name in PLAN_TOOLS_EDIT or name in PLAN_TOOLS_READ:
                        path = plan_path(args, cwd)
                        if path is not None:
                            touch(edited if name in PLAN_TOOLS_EDIT else read, path)
                elif kind == "tool_result":
                    ident = data.get("tool_use_id", "")
                    if ident in polls:
                        polls.discard(ident)
                        if not data.get("is_error"):
                            wakes = 0  # the user answered the poll
                elif kind == "user":
                    if OWN_MARKER in data:
                        wakes += 1
                    elif reflect.WAKE_MARKER in data or NOTE_MARK in data:
                        pass  # reflection's wake and task notifications (finishing tasks is the tasks module's business)
                    else:
                        text = reflect.REMINDER.sub("", data).strip()
                        if text and reflect.is_users(text):
                            wakes = 0
                            polls.clear()
    ordered = list(reversed(edited)) + [p for p in reversed(read) if p not in edited]
    if isinstance(background_tasks, list):
        background = subagent_tasks.live_by_background_list(tasks, background_tasks, None)
    else:
        background = subagent_tasks.live_by_transcript(tasks)
    return {"plans": [p for p in ordered if p.is_file()], "wakes": wakes, "poll": bool(polls), "background": background, "point": point}


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
        shown.append("PLANS NOT SHOWN (the size budget is spent; open one with Read if it matters): " + ", ".join(p.name for p in omitted))
    return "\n\n".join(shown)


def final_message(payload: dict, events: list[dict]) -> str:
    return payload.get("last_assistant_message") or next((e["text"] for e in reversed(events) if e["kind"] == "assistant"), "")


def model_text(payload: dict, transcript: Path, found: dict, events: list[dict]) -> str:
    users = [e for e in events if e["kind"] in reflect.USER_KINDS and OWN_MARKER not in e["text"] and reflect.WAKE_MARKER not in e["text"]]
    latest = "\n".join(reflect.line_of(e, reflect.CALL_LIMIT, reflect.RESULT_LIMIT, reflect.TEXT_LIMIT) for e in users[-reflect.USER_MESSAGES:])
    return "\n\n".join([
        f"RULES\n{reflect.rules(payload, transcript)}",
        f"PLANS\n{plans_text(found['plans'])}",
        f"WAKES\n{found['wakes']} consecutive wake(s) of yours since the user's last message",
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


def load_state() -> dict:
    """Per session, the stop point the hook last woke the session at. A missing or broken file reads as empty."""
    try:
        state = json.loads((STATE_DIR / STATE_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return state if isinstance(state, dict) else {}


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


def appended_after(transcript: Path, point: int, final: str) -> bool:
    """Whether anything that is activity was appended to the transcript after the stop point: a record of the
    user or the assistant (a message, a tool call, a tool result, a notification) or a queued command. Queue
    bookkeeping, system records and other attachments are not activity. The final message itself may land in the
    file late (the hook starts when the turn ends, the file is written a moment later): that record is not new."""
    with transcript.open("rb") as f:
        f.seek(point)
        tail = f.read()
    for raw in tail.splitlines():
        record = parsed(raw.decode("utf-8", errors="replace"))
        if record is None or record.get("isSidechain"):
            continue
        kind = record.get("type")
        if kind == "attachment":
            attachment = record.get("attachment")
            if isinstance(attachment, dict) and attachment.get("type") == "queued_command":
                return True
        elif kind == "assistant":
            text, has_call = record_text(record)
            if has_call or not final or text.strip() != final.strip():
                return True
        elif kind == "user":
            return True
    return False


def commit_wake(key: str, point: int, transcript: Path, final: str) -> str:
    """Decides under the lock whether the verdict still stands and, if so, records the woken stop: "wake",
    "superseded" (the transcript grew) or "duplicate" (this stop was already woken)."""
    with state_lock():
        if appended_after(transcript, point, final):
            return "superseded"
        state = load_state()
        previous = state.get(key)
        if isinstance(previous, dict) and previous.get("point") == point:
            return "duplicate"
        state.pop(key, None)
        state[key] = {"point": point, "at": now().isoformat(timespec="seconds")}
        save_state(dict(list(state.items())[-STATE_SESSIONS:]))
    return "wake"


def assess(payload: dict) -> str | None:
    """The wake text when the session stopped with agreed work left, else None. Logs every decision."""
    started = time.monotonic()
    session = payload.get("session_id")
    transcript = reflect.resolve_transcript(payload.get("transcript_path"), session)
    if not transcript.is_file():
        log({"session": session, "decision": "no-transcript"})
        return None
    cwd = payload.get("cwd") or "."
    found = scan(transcript, cwd, payload.get("background_tasks"))
    key = session or transcript.stem
    entry = {"session": key, "cwd": cwd, "wakes": found["wakes"]}

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
    if found["wakes"] >= MAX_WAKES:
        settle("wake-limit", f"{found['wakes']} wakes in a row without a message of the user")
        return None
    events = reflect.events_of(reflect.tail_lines(transcript))
    text = model_text(payload, transcript, found, events)
    dirs = list(dict.fromkeys(p.parent for p in found["plans"]))
    answer, cost, error = reflect.ask(MODEL, VERDICTS, text, cwd, dirs, started, prompt_file=PROMPT_FILE, schema_text=SCHEMA)
    seconds = round(time.monotonic() - started, 2)
    if answer is None:
        log({**entry, "decision": "failed", "cost": cost, "seconds": seconds, "reason": "", "error": error})
        return None
    if answer.get("verdict") != "idle":
        log({**entry, "decision": "ok", "verdict": "ok", "cost": cost, "seconds": seconds, "reason": answer.get("evidence", "")})
        return None
    outcome = commit_wake(key, found["point"], transcript, final_message(payload, events))
    seconds = round(time.monotonic() - started, 2)
    if outcome != "wake":
        reason = "the transcript grew while the model was thinking" if outcome == "superseded" else "this stop was already woken"
        log({**entry, "decision": outcome, "cost": cost, "seconds": seconds, "reason": reason})
        return None
    point = normalized(answer.get("item") or answer.get("next") or "")
    log({**entry, "decision": "idle", "verdict": "idle", "cost": cost, "seconds": seconds, "reason": answer.get("evidence", ""), "idle_point": point})
    return wake_text(answer, found["wakes"])


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
