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
plans, the user's rules, the latest user messages and the current turn, and answers ok, idle or loop. Idle wakes the
session with the next item. Loop (duty 7 of the stage-finishing rule, personnel.md) means the session circles on a
stage whose mandatory checks passed: repeated review or test rounds, or added tests or speed with no defect named;
it goes the same way as idle (one verdict, no extra model call, the same counter, limit and fail-closed checks),
but its wake tells the session to finish the stage by the rule instead of continuing. Transcript parsing, rules loading and the model call are shared with reflection
(features/reflection/hooks/reflect.py); reflection's own behaviour is not touched.

The wake does not act by itself: it reaches the main session, which knows the whole context and decides, and
its text tells the session to ignore the wake when the user has written since or work is running. So the hook
does not try to make a wake exactly correct against a transcript that is written concurrently; it fails closed.
The transcript size is taken when the hook starts (a last line without its newline means the stop cannot be
identified: silent). The model takes up to a few minutes (its deadline is derived from the hook timeout in
feature.json); before the wake is emitted, what was appended after that size is checked: growth that starts or
belongs to a new turn (a user message or queued input, an assistant record other than the final message landing
late, a tool call or result) supersedes the verdict, and so does a half-written line or a doubt. Bookkeeping
(system records, attachments that are not queued input, and the late final message itself) does not.

Under the file lock run exactly these steps, as one: that check of the appended growth, the look at reflection's wake
stamp (reflection woke for this same stop: silent), the read of the wake counter, its update and the emission of
the wake. The scan, the model call and the logging are outside it. That suffices because the wake does not act by
itself (the main session judges it) and any new turn appended before the check supersedes it; the lock only makes
two checks of the same session count and emit one after the other, so the counter never skips or doubles a wake.
The counter is one small file per session (wakes-<session>.json: count and the transcript size at the last wake).
At most MAX_WAKES wakes in a row; a message of the user newer than the last wake resets it. Only a record that
names the user as its origin counts as the user's; a poll answer does not (nothing in its record says a human gave
it).

The scan of the transcript (hundreds of MB in a long session) is cached per session (scan-<session>.json: the byte
offset reached, the plans, the background tasks and the shell directory so far, with hashes of the transcript's start
and of the bytes before the offset). The next stop reads only what was appended; any doubt (another file, another
code, a damaged cache) means a full scan, so the result never differs from a full one.

Every decision goes to ~/.claude/chief-assistant/log.jsonl with its verdict, cost, time and reason; an idle
verdict also carries idle_point (the open item, normalized), so repeats at one point can be counted.

Input: hook JSON on stdin. Output: exit 2 with the wake text on stderr, or exit 0 with nothing.
"""

import contextlib
import hashlib
import json
import os
import re
import shlex
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
SCAN_VERSION = 1  # the layout of the saved scan state; a cache of another version is not used
FINGERPRINT = 4096  # bytes hashed at the start of the transcript and just before the saved point
SCAN_KEEP_DAYS = 7  # a session's scan cache unused for this long is removed when another is written
MODEL = "haiku"
VERDICTS = ["ok", "idle", "loop"]
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
# messages, positively identified by their origin, reset the count; poll answers, reflection's wakes, task
# notifications and records without an origin do not.
MAX_WAKES = 3
PLAN_LIMIT = 12_000  # Characters of one plan sent to the model; a plan is a short working document.
PLAN_BUDGET = 4 * PLAN_LIMIT  # All plans together: four full-size plans, so one active plan plus a few it read for reference.
PLAN_DIR = "docs/superpowers/plans/"
# Record kinds seen in Claude Code 2.1.330 transcripts (sampled read-only from the 60 largest local ones). A kind outside
# these sets still counts as bookkeeping, but is written once to the decision log so the sets can be extended.
KNOWN_TYPES = frozenset({
    "assistant", "user", "attachment", "system", "api-request", "data-flow-records", "api-request-blob", "custom-title",
    "last-prompt", "atis-latch", "agent-name", "bridge-session", "queue-operation", "relocated", "mode", "pr-link",
    "file-history-delta", "file-history-snapshot", "session-owner", "frame-link", "permission-mode", "tools-used",
    "api-request-shape", "cost-state", "artifact-autoreact-ledger", "artifact-comment-monitor", "derived-from",
    "data-flow-incomplete",
})
KNOWN_ATTACHMENTS = frozenset({
    "deferred_tools_record", "environment", "total_tokens_reminder", "queued_command", "silent_turn_reminder",
    "edited_text_file", "hook_success", "prompt_snapshot", "deferred_tools_delta", "hook_additional_context", "date",
    "file", "mcp_instructions_delta", "model", "session_context", "credential_org", "instructions",
    "remote_session_change", "skill_listing", "agent_listing_delta", "auto_mode", "command_permissions",
    "hook_cancelled", "compact_file_reference", "invoked_skills", "thinking_drop", "inlined_image_paths", "task_status",
    "hook_system_message", "read_truncation_notice", "at_mention_reference", "directory", "already_read_file",
    "data-flow-records",
})
KNOWN_SYSTEM = frozenset({"stop_hook_summary", "turn_duration", "api_error", "compact_boundary", "informational"})
SEEN_KINDS_FILE = "seen-kinds.json"
# The statuses of an entry of the Stop payload's background_tasks that mean the task is not finished: it runs, or it is
# queued and about to run. Any other status (completed, failed, killed, ...) is an end state.
LIVE_STATUSES = (subagent_tasks.RUNNING, "pending")
# Both Stop hooks start together on one stop; a stamp of reflection counts as this stop's when it is not older than this
# hook's start by more than the gap between the two process starts (a few seconds at most; an older wake of reflection
# is cleared by its own next Stop long before, so a margin this size cannot meet one).
STAMP_SKEW = 10.0
TAIL_BYTES = 256 * 1024  # How far back from the stop's size the stop's own final message is looked for.
PLAN_TOOLS_EDIT = ("Edit", "Write", "MultiEdit")
SHELL_TOOLS = ("Bash", "PowerShell")  # the tools whose shell keeps its directory from one call to the next
MENTION_DEPTH = 8  # How deep into a tool input (agent prompts, nested fields) plan names are searched.
# A plan named in a string of a tool input, in any spelling: absolute or relative, either slash direction (the text
# is searched after its backslashes became slashes), in subfolders of the plans folder. The name must end at `.md`:
# not `.md.bak`, not `.mdx`. PLAN_PATH finds unquoted names; QUOTED_PLAN a quoted path, which may hold spaces.
PLAN_PATH = re.compile(r"""(?:[A-Za-z]:)?[^\s"'`<>|*?(),;=]*?docs/superpowers/plans/(?:[^\s"'`<>|*?()]+?/)*[^\s"'`<>|*?/()]+?\.md(?![\w-]|\.\w)""")
QUOTED_PLAN = re.compile(r"""(["'])((?:(?!\1).)*?docs/superpowers/plans/(?:(?!\1).)*?\.md)\1""")
REDIRECT_INTO_PLAN = re.compile(r"""\d?>>?\s*(?:"[^"]*|'[^']*|[^\s"']*)docs/superpowers/plans/""")
# A shell command that names a plan is an edit unless its segment starts with one of these pure readers.
PURE_READERS = frozenset({"cat", "type", "get-content", "gc", "head", "tail", "less", "more", "select-string", "sls",
                          "grep", "egrep", "fgrep", "rg", "wc"})
GIT_READS = frozenset({"show", "diff", "log"})
SED_IN_PLACE = re.compile(r"\s(?:-[A-Za-z]*i|--in-place)")
SEGMENT_PREFIX = re.compile(r"(?:[A-Za-z_]\w*=\S*|sudo|time|command|exec|nohup|call|&)\s+", re.IGNORECASE)
# Commands that change the directory later segments of the same shell line run in (bash and PowerShell spellings).
DIRECTORY_CHANGERS = frozenset({"cd", "chdir", "pushd", "set-location", "sl", "push-location"})
# A directory target holding one of these is not a literal path (home, a variable, a glob, an escape): unknown.
NON_LITERAL_DIRECTORY = frozenset("~$%`*?")
# Only these record types matter; every other line of a (possibly huge) transcript is skipped before parsing.
RECORD = re.compile(r'"type"\s*:\s*"(?:user|assistant|attachment)"')
LOCK_NAME = "state.lock"
LOCK_WAIT = 30.0  # Seconds to wait for the state lock.
LOCK_RETRY = 0.02
# The model phase must end early enough for the lock wait and the emission to fit the hook timeout of feature.json (the
# one source of that number). reflect.ask stops starting calls once started + CALL_TIMEOUT would pass the deadline, so
# the phase ends by the deadline; after it come the lock wait (LOCK_WAIT at most) and the final check and emission. The
# margin covers what is not counted: the interpreter start and the stdin read before `started`, the re-read of the
# transcript tail and the write of the wake (a chosen bound, a few seconds in practice).
MODEL_MARGIN = 15.0


def hook_timeout() -> float:
    manifest = json.loads((Path(__file__).resolve().parents[1] / "feature.json").read_text(encoding="utf-8"))
    return float(manifest["hooks"][0]["timeout"])


MODEL_DEADLINE = hook_timeout() - LOCK_WAIT - MODEL_MARGIN
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


def to_path(text: str) -> Path:
    """A path spelling as a Path: either slash direction, MSYS `/e/...` read as `E:/...` on Windows."""
    normal = text.replace("\\", "/")
    if os.name == "nt":
        normal = re.sub(r"^/([A-Za-z])/", r"\1:/", normal)
    return Path(normal)


def canonical(text: str, cwd: str, cache: dict) -> Path | None:
    """The existing plan file a path spelling names (absolute or relative to the project, either slash direction,
    MSYS `/e/...` on Windows), as its resolved full path; None when no such file exists. The resolved path is the
    plan's identity, so every spelling of one file is one plan."""
    key = (text, cwd)
    if key in cache:
        return cache[key]
    path = to_path(text)
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


def shell_segments(command: str) -> list[str]:
    """The simple commands of a shell line: split at `&&`, `||`, `;`, `|` and newlines that stand outside quotes."""
    segments: list[str] = []
    current: list[str] = []
    quote = ""
    index = 0
    while index < len(command):
        char = command[index]
        if quote:
            if char == quote:
                quote = ""
        elif char in "\"'":
            quote = char
        elif char in ";|\n" or command.startswith("&&", index):
            segments.append("".join(current))
            current = []
            index += 2 if command.startswith(("&&", "||"), index) else 1
            continue
        current.append(char)
        index += 1
    segments.append("".join(current))
    return [s.strip() for s in segments if s.strip()]


def unprefixed(segment: str) -> str:
    """A simple command without its leading environment assignments, `sudo`, `time`, `&`, ..."""
    rest = segment.strip()
    while True:
        prefix = SEGMENT_PREFIX.match(rest)
        if not prefix:
            return rest
        rest = rest[prefix.end():]


def words_of(rest: str) -> list[str]:
    """The words of a simple command, quotes removed (a quoted word with spaces stays one); plain whitespace split when
    the quotes do not balance. Backslashes are not escapes here: the text has already been made slash-only."""
    try:
        return shlex.split(rest, posix=True)
    except ValueError:
        return rest.split()


def command_name(words: list[str]) -> str:
    """The lowercased program name of a simple command: no folder, no `.exe`."""
    if not words:
        return ""
    first = words[0].strip("\"'").replace("\\", "/").rsplit("/", 1)[-1].lower()
    return first[:-4] if first.endswith(".exe") else first


def git_subcommand(words: list[str]) -> tuple[int, list[str]]:
    """For a `git` command: the index of its subcommand and the `-C <dir>` directories before it, in order."""
    index, directories = 1, []
    while index + 1 < len(words) and words[index] == "-C":
        directories.append(words[index + 1])
        index += 2
    return index, directories


def is_pure_read(segment: str) -> bool:
    """True when a simple command only reads: its first word is a recognised reader (`sed` only without -i, `git` only
    show, diff or log, after any `-C <dir>`). Anything else that names a plan (cp, mv, a script given the path, a
    redirect) is an edit."""
    rest = unprefixed(segment)
    words = words_of(rest)
    first = command_name(words)
    if not first:
        return False
    if first == "sed":
        return not SED_IN_PLACE.search(" " + rest)
    if first == "git":
        index, _ = git_subcommand(words)
        return index < len(words) and words[index] in GIT_READS
    return first in PURE_READERS


def moved(base: str | None, target: str) -> str | None:
    """The directory `target` names from `base`, or None when it cannot be known: no base for a relative target, or a
    target that is not a literal path (empty, `-`, `~`, `$HOME`, a glob, ...)."""
    if not target or target == "-" or NON_LITERAL_DIRECTORY & set(target):
        return None
    path = to_path(target)
    if path.is_absolute():
        return os.path.normpath(str(path))
    return os.path.normpath(str(Path(base) / path)) if base is not None else None


def directory_of(segment: str, workdir: str | None) -> tuple[str | None, str | None]:
    """(the directory this simple command runs in, the directory the next one runs in); None is unknown. `cd`,
    `pushd`, `Set-Location`, `Push-Location` (and their short names) change it for what follows, flags such as
    `-Path` skipped; `git -C <dir>` changes it for its own command only."""
    words = words_of(unprefixed(segment))
    first = command_name(words)
    if first in DIRECTORY_CHANGERS:
        targets = [w for w in words[1:] if w == "-" or not w.startswith("-")]
        return workdir, moved(workdir, targets[0] if targets else "")
    if first == "git":
        own = workdir
        for directory in git_subcommand(words)[1]:
            own = moved(own, directory)
        return own, workdir
    return workdir, workdir


def plan_mentions(name: str, args: object, cwd: str, cache: dict, shell: dict | None = None) -> list[tuple[Path, bool]]:
    """Every existing plan file a tool call of the main session refers to, as (resolved path, edited). Any string of
    the input can name a plan (a shell command, an agent's prompt, a nested field), not only `file_path`. The
    `file_path` of the file tools is an exact path (it may hold spaces); every other string is searched for
    `docs/superpowers/plans/<name>.md`, quoted or not. A plan is edited when an edit tool names it in `file_path`,
    or a shell command names it in a segment that redirects into it or is not a recognised pure read (cp, mv, a
    script given the path, ...); a plan named only by a pure reader, or in any other input, is read.
    `shell` is the session's tracked shell directory, `{"dir": <path or None>}`: the Bash and PowerShell tools keep
    their directory between calls, so a foreground call of either starts where the previous one ended and leaves
    its own end directory there (a background call starts there too, but its end is not kept)."""
    if not isinstance(args, dict):
        return []
    found: list[tuple[Path, bool]] = []
    direct = args.get("file_path")
    if isinstance(direct, str) and PLAN_DIR in direct.replace("\\", "/") and direct.endswith(".md"):
        path = canonical(direct, cwd, cache)
        if path is not None:
            found.append((path, name in PLAN_TOOLS_EDIT))
    command = args.get("command")
    persistent = shell is not None and name in SHELL_TOOLS and isinstance(command, str)
    for text in strings_of({key: value for key, value in args.items() if key != "file_path"}):
        normal = text.replace("\\", "/")
        is_command = text is command
        if PLAN_DIR not in normal and not (persistent and is_command):
            continue  # a command without a plan still moves the shell: the next call may name the plan
        # a shell command is judged per simple command; any other string is one unit that only reads
        units = shell_segments(normal) if is_command else [normal]
        workdir: str | None = shell["dir"] if persistent and is_command else cwd
        for unit in units:
            unit_dir = cwd
            if is_command:
                # a relative plan path means the directory the command runs in at that point, not always the payload's
                unit_dir, workdir = directory_of(unit, workdir)
            if PLAN_DIR not in unit:
                continue
            quoted = [m.group(2).strip() for m in QUOTED_PLAN.finditer(unit)]
            bare = [m.group(0) for m in PLAN_PATH.finditer(unit)]
            writes = text is command and bool(REDIRECT_INTO_PLAN.search(unit) or not is_pure_read(unit))
            # the tracked directory first, the payload's too: the tracking is a guess (a cd that failed, an unknown target)
            places = [d for d in dict.fromkeys((unit_dir, cwd)) if d is not None]
            named: set[Path] = set()
            for span in quoted + bare:
                for place in places:
                    path = canonical(span, place, cache)
                    if path is not None and path not in named:
                        named.add(path)
                        found.append((path, writes))
        if persistent and is_command and not args.get("run_in_background"):
            shell["dir"] = workdir
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


def record_origin(record: dict) -> object:
    """The `origin` of a user record, or of a queued_command attachment (it sits in the attachment); None when absent."""
    origin = record.get("origin")
    attachment = record.get("attachment")
    return origin if origin is not None else attachment.get("origin") if isinstance(attachment, dict) else None


def from_user(record: dict, text: str) -> bool:
    """Whether the user-role text of a record is positively the user's own words, judged by the record's origin only:
    `human` (typed) is the user's whatever the text says, even text that quotes a marker; `channel` (Telegram) is the
    user's unless it is one of the hub's own messages. Any other origin (task-notification, plugin, a subagent
    hand-back, ...) and a record with no origin are not the user's: Claude Code writes the user's words with an
    origin, and what carries none (reminders, compaction summaries, interrupt notes, harness prompts) is not them.
    Fail closed: an unidentified record never resets the wake count and is never shown as the user's."""
    origin = record_origin(record)
    kind = origin.get("kind") if isinstance(origin, dict) else None
    if kind == "human":
        return True
    return kind == "channel" and reflect.is_users(text)


def prompt_blocks(record: dict) -> list[dict] | None:
    """The content blocks a record carries as input of the turn: the message of a user record, or the prompt of a
    queued_command attachment (what the user typed while the assistant worked). A string counts as one text block.
    None for any other record."""
    kind = record.get("type")
    if kind == "user":
        message = record.get("message")
        content = message.get("content") if isinstance(message, dict) else None
    elif kind == "attachment":
        attachment = record.get("attachment")
        content = attachment.get("prompt") if isinstance(attachment, dict) and attachment.get("type") == "queued_command" else None
    else:
        return None
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return [b for b in content if isinstance(b, dict)] if isinstance(content, list) else None


def block_texts(blocks: list[dict]) -> str:
    """The text blocks joined, system reminders removed."""
    texts = (reflect.REMINDER.sub("", b["text"]).strip() for b in blocks if b.get("type") == "text" and isinstance(b.get("text"), str))
    return "\n".join(t for t in texts if t)


def users_input(record: dict) -> bool:
    """Whether a record is input of the user, judged on the record and not on the text events the shared parser makes
    of it: an image-only message and a queued prompt of blocks yield no text event, and are still the user's words (see
    `from_user`). A record needs text or a non-text block (an image) of its own: a tool result is output, not input."""
    blocks = prompt_blocks(record)
    if blocks is None:
        return False
    text = block_texts(blocks)
    media = any(b.get("type") not in ("text", "tool_result", "tool_use") for b in blocks)
    return (bool(text) or media) and from_user(record, text)


def with_text_prompts(lines: list[str]) -> list[str]:
    """The lines with every queued_command whose prompt is a list of blocks rewritten to a string prompt of its text
    blocks: the shared parser (`reflect.line_events`) reads a queued prompt only when it is a string, and would drop
    the caption of a pasted image."""
    out = []
    for line in lines:
        if '"queued_command"' in line:
            record = parsed(line)
            attachment = record.get("attachment") if record is not None else None
            if isinstance(attachment, dict) and attachment.get("type") == "queued_command" and isinstance(attachment.get("prompt"), list):
                attachment["prompt"] = "\n".join(b["text"] for b in attachment["prompt"] if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str))
                line = json.dumps(record, ensure_ascii=False)
        out.append(line)
    return out


def classify(line: str, text: str) -> str:
    """The event kind of a user-role text for `reflect.events_of`, from the record's origin (see `from_user`) instead of
    reflection's text classification: "user" for the user's words, "event" for everything else."""
    record = parsed(line)
    return "user" if record is not None and from_user(record, text) else "event"


def safe_key(key: str) -> str:
    return re.sub(r'[^A-Za-z0-9_.-]', '_', key)[:100]


def code_stamp() -> str:
    """A hash of the code a scan result depends on (this file and the two it uses), computed once per process: a cache
    made by other code is not trusted."""
    global _STAMP
    if _STAMP is None:
        digest = hashlib.sha1()
        for source in (__file__, subagent_tasks.__file__, reflect.__file__):
            try:
                digest.update(Path(source).read_bytes())
            except (OSError, TypeError):
                digest.update(b"?")
        _STAMP = digest.hexdigest()
    return _STAMP


_STAMP: str | None = None


def scan_file(key: str) -> Path:
    return STATE_DIR / f"scan-{safe_key(key)}.json"


def fingerprints(f, offset: int) -> tuple[str, str]:
    """Hashes of the first and of the last (up to) FINGERPRINT bytes before `offset`: a cache continues only a file
    whose start and whose bytes just before the saved point are the ones it saw."""
    f.seek(0)
    head = f.read(min(offset, FINGERPRINT))
    low = max(offset - FINGERPRINT, 0)
    f.seek(low)
    tail = f.read(offset - low)
    return hashlib.sha1(head).hexdigest(), hashlib.sha1(tail).hexdigest()


def load_scan(path: Path, f, cwd: str, limit: int | None) -> dict | None:
    """The saved state of an earlier scan of this file, when it is safe to continue it: made by this code, for this
    cwd, at a point of the file that is still there (and not past `limit`) with the same bytes around it, and of the
    right shape throughout. None otherwise (a full scan then follows)."""
    try:
        saved = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(saved, dict) or saved["version"] != SCAN_VERSION or saved["stamp"] != code_stamp() or saved["cwd"] != cwd:
            return None
        offset = saved["offset"]
        size = os.fstat(f.fileno()).st_size
        if type(offset) is not int or offset < 0 or offset > size or (limit is not None and offset > limit):
            return None
        if [saved["head"], saved["tail"]] != list(fingerprints(f, offset)):
            return None
        for name in ("edited", "read", "polls"):
            if not isinstance(saved[name], list) or not all(isinstance(item, str) for item in saved[name]):
                return None
        if not (saved["shell"] is None or isinstance(saved["shell"], str)) or type(saved["reset_at"]) is not int:
            return None
        return {"offset": offset, "edited": [Path(p) for p in saved["edited"]], "read": [Path(p) for p in saved["read"]],
                "shell": saved["shell"], "reset_at": saved["reset_at"], "polls": saved["polls"],
                "tasks": subagent_tasks.Tasks.from_state(saved["tasks"])}
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None


def save_scan(path: Path, f, cwd: str, state: dict) -> None:
    """Writes the scan state (temp file, then replace) and removes cache files unused for SCAN_KEEP_DAYS. Best effort:
    a cache that cannot be written only means the next scan is a full one."""
    try:
        head, tail = fingerprints(f, state["offset"])
        saved = {"version": SCAN_VERSION, "stamp": code_stamp(), "cwd": cwd, "head": head, "tail": tail, **state}
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(f"{path.name}.tmp-{os.getpid()}-{threading.get_ident()}")
        try:
            temp.write_text(json.dumps(saved), encoding="utf-8")
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)
        oldest = time.time() - SCAN_KEEP_DAYS * 86400
        for old in path.parent.glob("scan-*"):
            with contextlib.suppress(OSError):
                if old.stat().st_mtime < oldest:
                    old.unlink()
    except (OSError, ValueError, TypeError):
        pass


def scan(transcript: Path, cwd: str, background_tasks: object = None, limit: int | None = None, key: str | None = None) -> dict:
    """One streaming pass over the transcript up to `limit` bytes (the stop point; the whole file when None). It can
    be hundreds of MB, so lines of other record types are skipped before parsing. Every record is judged block by
    block: a user record holding a tool result and the user's own text counts for both. Returns:
      plans       the existing plan files the session edited (latest first), then those it only referred to (latest first)
      reset_at    the byte offset where the line of the user's latest message starts; -1 when none
      poll        whether a poll is pending
      background  (id, info) of the background tasks that still run: every running entry of the Stop payload's own
                  list when it is given, else the tasks the session launched by the transcript
    Subagent (sidechain) records are not the session's own and are skipped.

    With a `key` (the session) the state of the pass is saved (scan-<key>.json), and the next scan of the same file
    goes on from the saved byte offset instead of reading the whole transcript again: the result is the same as that
    of a full pass, and any doubt about the saved state (see `load_scan`) means a full pass. What is saved is only what
    the records so far decide; the payload's task list and the check that the plan files exist are applied on every call.
    Known limit: a plan the session mentioned before the file existed and created later is picked up on the next full
    pass only (the existence check is not part of the saved state, the mention is).

    Measured (Python 3.x, one machine, real session transcripts, `scan` with a key; cold = no saved state, warm = same
    size again, +2 MB = saved state of a transcript 2 MB shorter, the cache file is the saved state):
      644 MB  no cache 2.76 s   cold 4.41 s (first read from disk)   warm 0.020 s   +2 MB 0.035 s   cache file 276 kB
      165 MB  no cache 1.09 s   cold 1.07 s                          warm 0.009 s   +2 MB 0.032 s   cache file  79 kB
       50 MB  no cache 0.39 s   cold 0.40 s                          warm 0.008 s   +2 MB 0.027 s   cache file  37 kB
    The cache file grows with the tasks the session started (about 0.4 kB per MB of transcript), so no pruning."""
    if key is None:
        return run_scan(transcript, cwd, background_tasks, limit, None, None)[0]
    path = scan_file(key)
    with transcript.open("rb") as f:
        resume = load_scan(path, f, cwd, limit)
        try:
            found, state = run_scan(transcript, cwd, background_tasks, limit, resume, f)
        except Exception:
            if resume is None:
                raise
            found, state = run_scan(transcript, cwd, background_tasks, limit, None, f)  # a saved state that does not fit the code
            resume = None
        if resume is None or state["offset"] != resume["offset"]:
            save_scan(path, f, cwd, state)
    return found


def run_scan(transcript: Path, cwd: str, background_tasks: object, limit: int | None, resume: dict | None, handle) -> tuple[dict, dict]:
    """The pass of `scan`, from the saved state `resume` (a full pass when None). Returns the result and the state to
    save: the byte offset it stands for is the end of the last complete line read (a last line without its newline
    may still be growing, so it is read again next time), with everything the records before it decided."""
    edited: dict[Path, bool] = {}
    read: dict[Path, bool] = {}
    cache: dict = {}
    shell: dict = {"dir": cwd}  # where the Bash / PowerShell shell stands after the calls so far (None: not known)
    reset_at = -1
    polls: set[str] = set()
    tasks = subagent_tasks.Tasks()
    point = 0
    if resume is not None:
        edited, read = dict.fromkeys(resume["edited"], True), dict.fromkeys(resume["read"], True)
        shell["dir"], reset_at, polls, tasks, point = resume["shell"], resume["reset_at"], set(resume["polls"]), resume["tasks"], resume["offset"]
    saved: dict | None = None

    def snapshot(offset: int) -> dict:
        return {"offset": offset, "edited": [str(p) for p in edited], "read": [str(p) for p in read], "shell": shell["dir"],
                "reset_at": reset_at, "polls": sorted(polls), "tasks": json.loads(json.dumps(tasks.to_state()))}

    with (transcript.open("rb") if handle is None else contextlib.nullcontext(handle)) as f:
        f.seek(point)
        for raw in f:
            if limit is not None and point + len(raw) > limit:
                break  # past the stop point: whatever is there is not part of what the verdict is about
            start = point
            point += len(raw)
            if saved is None and handle is not None and not raw.endswith(b"\n"):
                saved = snapshot(start)  # only the last line can lack its newline; the state before it is what is saved
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
                        for path, writes in plan_mentions(name, args, cwd, cache, shell):
                            touch(edited if writes else read, path)
                elif kind == "tool_result":
                    ident = data.get("tool_use_id", "")
                    # The result closes the poll but is no proof of a human answer (a hook can answer it too): no reset.
                    polls.discard(ident)
            if users_input(record):
                reset_at = start
                polls.clear()
        if saved is None and handle is not None:
            saved = snapshot(point)
    ordered = list(reversed(edited)) + [p for p in reversed(read) if p not in edited]
    if isinstance(background_tasks, list):
        background = [(e.get("id"), e) for e in background_tasks if isinstance(e, dict) and e.get("status") in LIVE_STATUSES]
    else:
        background = subagent_tasks.live_by_transcript(tasks)
    return {"plans": [p for p in ordered if p.is_file()], "reset_at": reset_at, "poll": bool(polls), "background": background}, saved


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


def message_id(record: dict) -> str | None:
    """The API message id of an assistant record; Claude Code writes one record per content block, all with the id."""
    message = record.get("message")
    ident = message.get("id") if isinstance(message, dict) else None
    return ident if isinstance(ident, str) and ident else None


def is_final_text(record: dict, final_text: str | None) -> bool:
    """Whether an assistant record is the stop's final message: text only, equal to the payload's last_assistant_message."""
    if record.get("type") != "assistant" or not final_text:
        return False
    text, call = record_text(record)
    return not call and text.strip() == final_text.strip()


def final_message_ids(transcript: Path, size: int, final_text: str | None) -> set[str]:
    """The message ids of the stop's final message among the last TAIL_BYTES of the first `size` bytes (the final
    record is the last text record, so it sits at the very end)."""
    if not final_text or size <= 0:
        return set()
    start = max(0, size - TAIL_BYTES)
    with transcript.open("rb") as f:
        f.seek(start)
        data = f.read(size - start)
    lines = data.splitlines()
    if start:
        lines = lines[1:]  # the first line of a tail read may be cut
    for raw in reversed(lines):
        record = parsed(raw.decode("utf-8", errors="replace"))
        if record is not None and is_final_text(record, final_text):
            ident = message_id(record)
            return {ident} if ident else set()
    return set()


def has_tool_block(record: dict) -> bool:
    """Whether the message of a record holds a tool_use or a tool_result block (only blocks: other fields may name tools)."""
    message = record.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    return isinstance(content, list) and any(isinstance(b, dict) and b.get("type") in ("tool_use", "tool_result") for b in content)


def unknown_kind(record: dict) -> str | None:
    """The label of a record kind that is not in the known sets (a type, `attachment/<type>` or `system/<subtype>`;
    a missing type or subtype is a kind of its own); None for a known one."""
    kind = record.get("type")
    if not isinstance(kind, str):
        return "no-type"
    if kind == "attachment":
        attachment = record.get("attachment")
        inner = attachment.get("type") if isinstance(attachment, dict) else None
        return None if inner in KNOWN_ATTACHMENTS else f"attachment/{inner or ''}"
    if kind == "system":
        subtype = record.get("subtype")
        return None if subtype in KNOWN_SYSTEM else f"system/{subtype or ''}"
    return None if kind in KNOWN_TYPES else kind


def starts_new_turn(record: dict, final_text: str | None, prompt_id: str | None, final_ids: set[str], seen_final: bool) -> bool:
    """Whether one record that landed after the stop's size starts, or belongs to, a new turn, so the verdict about
    this stop is stale. Every other record kind is the stop's own bookkeeping (hooks, timing, snapshots, titles,
    usage records, ...): Claude Code writes a dozen kinds after a clean stop (a `data-flow-records` record follows
    `turn_duration` in 108 of 182 clean stops in 2.1.330), and a list of the harmless ones kept dropping real
    verdicts. New turn: a user record of any origin; an assistant record that holds a tool call or text other than the
    stop's final message (the final, with this prompt's id, counts once); an assistant record with neither text nor
    tool call (thinking) unless it shares the final message's id; any tool_use or tool_result block; a queued_command
    attachment (a hook wake or a notification waiting for the next turn); a queue-operation (input waiting).
    `promptId` sits on user records only, so an assistant record may carry none (a mismatch is checked when it does)."""
    kind = record.get("type")
    if kind in ("user", "queue-operation") or has_tool_block(record):
        return True
    if kind == "attachment":
        attachment = record.get("attachment")
        return isinstance(attachment, dict) and attachment.get("type") == "queued_command"
    if kind == "assistant":
        text, call = record_text(record)
        if call:
            return True
        if not text.strip():
            ident = message_id(record)
            return ident is None or ident not in final_ids
        if seen_final or not is_final_text(record, final_text):
            return True
        return record.get("promptId") not in (None, prompt_id)
    return False


def grew_beyond(transcript: Path, size: int, final_text: str | None = None, prompt_id: str | None = None,
                unknown: set[str] | None = None) -> bool:
    """Whether the transcript holds, after its first `size` bytes, growth that starts or belongs to a new turn (see
    `starts_new_turn`) or a line that is not complete JSON: a half-written line means a record is being written, and a
    doubt counts as stale. Kinds of record outside the known sets are added to `unknown` when it is given."""
    with transcript.open("rb") as f:
        f.seek(size)
        data = f.read()
    if not data:
        return False
    if not data.endswith(b"\n"):
        return True
    records = [parsed(raw.decode("utf-8", errors="replace")) for raw in data.splitlines()]
    if any(record is None for record in records):
        return True
    final_ids = final_message_ids(transcript, size, final_text)
    # A thinking-only record of the final message may precede its late text record, so the late ids come first.
    final_ids |= {ident for record in records if is_final_text(record, final_text) and (ident := message_id(record))}
    grew = False
    seen_final = False
    for record in records:
        label = unknown_kind(record)
        if label is not None and unknown is not None:
            unknown.add(label)
        if starts_new_turn(record, final_text, prompt_id, final_ids, seen_final):
            grew = True
        seen_final = seen_final or is_final_text(record, final_text)
    return grew


def normalized(item: str) -> str:
    return " ".join(item.lower().split())


def loop_wake_text(answer: dict, wakes: int) -> str:
    """The wake for a session that circles on a stage whose checks passed: finish the stage, do not continue."""
    item = answer.get("item") or "the current stage"
    head = (f"{OWN_MARKER} Your work on {item} looks like a loop: {answer.get('evidence', '')}. "
            "First check whether the user has written since or work is running (a background task, an agent); if so, ignore this "
            "reminder and answer it with one short line at most.")
    rule = ("Otherwise finish the stage by the owner's stage-finishing rule instead of continuing: passing the mandatory checks and "
            "readiness criteria fixed before the stage is the ground to finish it; an extra test is allowed only for a concrete defect, "
            "a material risk or an unverified mandatory requirement; minor remarks, optimisations, speed and test coverage go to a "
            "separate backlog task; a repeat review only checks the fixes and regressions; security, data integrity and recovery "
            "checks are never skipped. "
            f"Finish: {answer.get('next', '')} Report the stage as finished with the evidence of the passed checks and move to the next "
            "stage, or say exactly which mandatory check has not passed.")
    if wakes >= MAX_WAKES - 1:
        return f"{head} {rule} This is the last reminder you get until the user writes."
    return f"{head} {rule}"


def wake_text(answer: dict, wakes: int) -> str:
    if answer.get("verdict") == "loop":
        return loop_wake_text(answer, wakes)
    item =answer.get("item") or answer.get("evidence") or "the open item"
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
        try:
            size = path.stat().st_size  # a plan may be huge: its size is asked of the file system, never read whole
        except OSError:
            continue
        charge = min(size, PLAN_LIMIT)  # bytes bound the characters from above; the cut note is not plan text
        if used + charge > PLAN_BUDGET:
            omitted = plans[index:]
            break
        try:
            with open(path, encoding="utf-8", errors="replace") as handle:
                excerpt = handle.read(PLAN_LIMIT + 1)  # one character past the limit tells that the plan was cut
        except OSError:
            continue
        used += charge
        if len(excerpt) > PLAN_LIMIT:
            excerpt = excerpt[:PLAN_LIMIT] + f"\n... [plan cut at {PLAN_LIMIT} chars; the file is {size} bytes; open it with Read]"
        shown.append(f"--- {path}\n{excerpt}")
    if omitted:
        shown.append("PLANS NOT SHOWN (the size budget is spent; open one with Read if it matters): " + ", ".join(str(p) for p in omitted))
    return "\n\n".join(shown)


def final_message(payload: dict, events: list[dict]) -> str:
    return payload.get("last_assistant_message") or next((e["text"] for e in reversed(events) if e["kind"] == "assistant"), "")


def model_text(payload: dict, transcript: Path, found: dict, events: list[dict], wakes: int) -> str:
    """`events` come from `reflect.events_of` with `classify`: only records the origin names as the user's are `user`
    events, so the user's latest messages and the current turn are built from the same, origin-based judgement."""
    users = [e for e in events if e["kind"] == "user"]
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
    return STATE_DIR / f"wakes-{safe_key(key)}.json"


def read_count(key: str, found: dict) -> int:
    """The wakes in a row of this session: the saved count, unless the user wrote after the
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


def unseen_kinds(kinds: set[str]) -> list[str]:
    """The record kinds of `kinds` not yet written to the decision log; remembers them. Best effort, called under the
    state lock: a broken or unwritable file only means a kind is logged again."""
    try:
        try:
            seen = set(json.loads((STATE_DIR / SEEN_KINDS_FILE).read_text(encoding="utf-8")))
        except (OSError, ValueError, TypeError):
            seen = set()
        fresh = sorted(kinds - seen)
        if fresh:
            (STATE_DIR / SEEN_KINDS_FILE).write_text(json.dumps(sorted(seen | kinds)), encoding="utf-8")
        return fresh
    except (OSError, ValueError, TypeError):
        return sorted(kinds)


def reflection_woke(payload: dict, since: float) -> bool:
    """Whether reflection (a sibling Stop hook, run on the same stop at the same time) woke the session at or after
    `since`. Its stamp (`reflect.wake_file`, the wall-clock time of its wake) is only read: reflection's own next
    Stop clears it. A missing or broken stamp reads as no wake."""
    try:
        return float(reflect.wake_file(payload).read_text(encoding="utf-8")) >= since
    except (OSError, ValueError):
        return False


def assess(payload: dict, emit=None) -> str | None:
    """The wake text when the session stopped with agreed work left, else None. `emit` gets the text inside the locked
    step that validated the verdict and counted the wake. Logs every decision."""
    started = time.monotonic()
    started_wall = time.time()  # the stop's boundary on the wall clock: reflection's stamp is a wall-clock time
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
    found = scan(transcript, cwd, payload.get("background_tasks"), limit=size, key=key)
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
    lines = with_text_prompts(reflect.tail_lines(transcript, classify=classify))  # the window is counted by the same origin judgement
    # A poll answer is shown as a plain tool result (answers=False): nothing in its record says a human gave it.
    events = reflect.events_of(lines, classify=classify, answers=False)
    text = model_text(payload, transcript, found, events, wakes)
    dirs = list(dict.fromkeys(p.parent for p in found["plans"]))
    answer, cost, error = reflect.ask(MODEL, VERDICTS, text, cwd, dirs, started, prompt_file=PROMPT_FILE, schema_text=SCHEMA, deadline=MODEL_DEADLINE)
    seconds = round(time.monotonic() - started, 2)
    if answer is None:
        log({**entry, "decision": "failed", "cost": cost, "seconds": seconds, "reason": "", "error": error})
        return None
    verdict = answer.get("verdict")  # `ask` accepts only a verdict from VERDICTS
    if verdict not in ("idle", "loop"):
        log({**entry, "decision": "ok", "verdict": "ok", "cost": cost, "seconds": seconds, "reason": answer.get("evidence", "")})
        return None
    unknown: set[str] = set()
    fresh: list[str] = []
    with state_lock():
        grew = grew_beyond(transcript, size, payload.get("last_assistant_message"), payload.get("prompt_id"), unknown)
        if unknown:
            fresh = unseen_kinds(unknown)
        if grew:
            outcome, before, wake = "superseded", wakes, None
        elif reflection_woke(payload, started_wall - STAMP_SKEW):
            outcome, before, wake = "reflection-woke", wakes, None
        else:
            before = read_count(key, found)
            outcome = "wake-limit" if before >= MAX_WAKES else "wake"
            wake = wake_text(answer, before) if outcome == "wake" else None
            if wake:
                save_count(key, before + 1, size)
                if emit:
                    emit(wake)
    seconds = round(time.monotonic() - started, 2)
    if fresh:
        log({**entry, "decision": "unknown-record", "kinds": fresh, "reason": "record kinds outside the known sets, counted as bookkeeping"})
    if wake is None:
        reasons = {"superseded": "the transcript grew while the model was thinking", "wake-limit": f"{before} wakes in a row without a message of the user",
                   "reflection-woke": "reflection woke the session for this same stop"}
        log({**entry, "wakes": before, "decision": outcome, "cost": cost, "seconds": seconds, "reason": reasons[outcome]})
        return None
    point = normalized(answer.get("item") or answer.get("next") or "")
    log({**entry, "wakes": before, "decision": verdict, "verdict": verdict, "cost": cost, "seconds": seconds, "reason": answer.get("evidence", ""), "idle_point": point})
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
        try:
            log({"session": payload.get("session_id"), "decision": "crashed", "error": f"{type(e).__name__}: {str(e)[:300]}"})
        except Exception:  # the log is best-effort here: an unwritable log must not turn a crash into a traceback
            pass
        return
    if text:
        sys.exit(WAKE_EXIT)


if __name__ == "__main__":
    main()
