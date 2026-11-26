"""Stop hook: the chief engineer's assistant checks that the session does not stop with agreed work left.

The session sometimes ends a turn although nothing blocks it, no question is pending, no background task
runs and the active plan has open items; it then idles until the user asks for progress. Reflection does
not see this: its checks cover what the user asked in the turn, and it skips wake-started turns on purpose.
This hook runs at the end of every turn of the main session, wake-started ones included (asyncRewake: the
answer has already gone out; exit 2 with the reason on stderr wakes the session).

Legit stops are decided in code without a model call: a poll is pending, a background task the session
launched still runs, no plan was touched by the session (or it is gone), the wake limit is reached.
Otherwise one cheap model (Haiku, through reflect.ask, the call reflection uses) reads the plans, the user's
rules, the latest user messages and the current turn, and answers ok or idle. Idle wakes the session with
the next item. Transcript parsing, rules loading and the model call are shared with reflection
(features/reflection/hooks/reflect.py); reflection's own behaviour is not touched.

Every decision goes to ~/.claude/chief-assistant/log.jsonl with its verdict, cost, time and reason; an idle
verdict also carries idle_point (the open item, normalized), so repeats at one point can be counted.

Input: hook JSON on stdin. Output: exit 2 with the wake text on stderr, or exit 0 with nothing.
"""

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "reflection" / "hooks"))
import reflect  # noqa: E402

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
MAX_PLANS = 3
PLAN_LIMIT = 12_000  # Characters of one plan sent to the model; a plan is a short working document.
STALE_HOURS = 24  # A background launch older than this is taken for a dead one (no completion was ever written).
PLAN_DIR = "docs/superpowers/plans/"
PLAN_TOOLS = ("Read", "Edit", "Write", "MultiEdit")
ASSISTANT_ENTRY = re.compile(r'"type"\s*:\s*"assistant"')
USER_ENTRY = re.compile(r'"type"\s*:\s*"user"')
TOOL_USE_ID = re.compile(r'"tool_use_id"\s*:\s*"([^"]+)"')
LAUNCH_ID = re.compile(r"ID: (\S+?)\.(?:\s|$)|agentId: (\S+)")
NOTE_TASK = re.compile(r"<task-id>\s*(.*?)\s*</task-id>", re.DOTALL)
NOTE_TOOL = re.compile(r"<tool-use-id>\s*(.*?)\s*</tool-use-id>", re.DOTALL)
NOTE_MARK = "<task-notification>"
ASSISTANT_PREFILTER = ("plans", "run_in_background", reflect.POLL_TOOL)


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


def stamp_time(stamp: str) -> datetime | None:
    try:
        return datetime.fromisoformat(stamp).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def scan(transcript: Path, cwd: str) -> dict:
    """One streaming pass over the whole transcript (it can be hundreds of MB, so most lines are skipped
    on a cheap test before parsing). Returns the plans the session touched (the most recent first), the
    consecutive wakes since the user's last message, whether a poll is pending, and the number of
    background tasks still running."""
    plans: dict[Path, bool] = {}
    wakes = 0
    polls: set[str] = set()
    launches: dict[str, dict] = {}  # tool_use id -> {"stamp": ..., "ids": {task ids}}
    finished: set[str] = set()
    tracked: set[str] = set()  # ids whose tool_result must be parsed: launches and polls
    with transcript.open(encoding="utf-8", errors="replace") as f:
        for line in f:
            if '"queued_command"' not in line:
                if USER_ENTRY.search(line):
                    if '"tool_result"' in line and not any(i in tracked for i in TOOL_USE_ID.findall(line)):
                        continue
                elif ASSISTANT_ENTRY.search(line):
                    if not any(mark in line for mark in ASSISTANT_PREFILTER):
                        continue
                else:
                    continue
            for kind, stamp, data in reflect.line_events([line]):
                if kind == "tool_use":
                    name, args, ident = data.get("name"), data.get("input"), data.get("id", "")
                    if name == reflect.POLL_TOOL:
                        polls.add(ident)
                        tracked.add(ident)
                    elif isinstance(args, dict) and args.get("run_in_background") is True:
                        launches[ident] = {"stamp": stamp, "ids": set()}
                        tracked.add(ident)
                    path = plan_path(args, cwd) if name in PLAN_TOOLS else None
                    if path is not None:
                        plans.pop(path, None)
                        plans[path] = True
                elif kind == "tool_result":
                    ident = data.get("tool_use_id", "")
                    if ident in polls:
                        polls.discard(ident)
                        if not data.get("is_error"):
                            wakes = 0  # the user answered the poll
                    elif ident in launches:
                        if data.get("is_error"):
                            del launches[ident]
                        else:
                            found = LAUNCH_ID.search(reflect.block_text(data.get("content")))
                            if found:
                                launches[ident]["ids"].add(found.group(1) or found.group(2))
                elif kind == "user":
                    if OWN_MARKER in data:
                        wakes += 1
                    elif reflect.WAKE_MARKER in data:
                        pass
                    elif NOTE_MARK in data:
                        if "<status>" in data:
                            finished.update(NOTE_TASK.findall(data) + NOTE_TOOL.findall(data))
                    else:
                        text = reflect.REMINDER.sub("", data).strip()
                        if text and reflect.is_users(text):
                            wakes = 0
                            polls.clear()
    limit = now().timestamp() - STALE_HOURS * 3600
    running = 0
    for ident, launch in launches.items():
        if ident in finished or launch["ids"] & finished:
            continue
        started = stamp_time(launch["stamp"])
        if started is not None and started.timestamp() < limit:
            continue
        running += 1
    existing = [path for path in reversed(plans) if path.is_file()]
    return {"plans": existing[:MAX_PLANS], "wakes": wakes, "poll": bool(polls), "background": running}


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


def model_text(payload: dict, transcript: Path, found: dict, events: list[dict]) -> str:
    plans = "\n\n".join(f"--- {p}\n{reflect.clip(p.read_text(encoding='utf-8', errors='replace'), PLAN_LIMIT)}" for p in found["plans"])
    users = [e for e in events if e["kind"] in reflect.USER_KINDS and OWN_MARKER not in e["text"] and reflect.WAKE_MARKER not in e["text"]]
    latest = "\n".join(reflect.line_of(e, reflect.CALL_LIMIT, reflect.RESULT_LIMIT, reflect.TEXT_LIMIT) for e in users[-reflect.USER_MESSAGES:])
    final = payload.get("last_assistant_message") or next((e["text"] for e in reversed(events) if e["kind"] == "assistant"), "")
    return "\n\n".join([
        f"RULES\n{reflect.rules(payload, transcript)}",
        f"PLANS\n{plans}",
        f"WAKES\n{found['wakes']} consecutive wake(s) of yours since the user's last message",
        f"USER'S LATEST MESSAGES\n{latest or '(none)'}",
        f"THIS TURN\n{reflect.conversation(reflect.current_turn(events))}",
        f"FINAL MESSAGE\n{reflect.clip(final, reflect.CONVERSATION_BUDGET)}",
    ])


def assess(payload: dict) -> str | None:
    """The wake text when the session stopped with agreed work left, else None. Logs every decision."""
    started = time.monotonic()
    session = payload.get("session_id")
    transcript = reflect.resolve_transcript(payload.get("transcript_path"), session)
    if not transcript.is_file():
        log({"session": session, "decision": "no-transcript"})
        return None
    cwd = payload.get("cwd") or "."
    found = scan(transcript, cwd)
    entry = {"session": session or transcript.stem, "cwd": cwd, "wakes": found["wakes"]}

    def settle(decision: str, reason: str = "") -> None:
        log({**entry, "decision": decision, "reason": reason, "seconds": round(time.monotonic() - started, 2)})

    if found["poll"]:
        settle("poll", "a poll waits for the user")
        return None
    if found["background"]:
        settle("background", f"{found['background']} background task(s) still running")
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
