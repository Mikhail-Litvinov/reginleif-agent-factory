"""Records one Claude Code session in ~/.agent-rig/sessions/<session_id>.json.

Run by the SessionStart and SessionEnd hooks as `python -I session_record.py start|end`, with the hook's JSON on stdin.
`start` writes the record and finds the Claude process: the CLAUDE_PID value when it is a claude ancestor of the hook,
otherwise the nearest claude ancestor. `end` only sets ended_at. The hook prints nothing and always exits 0.
Process table: PowerShell Get-CimInstance on Windows, /proc on Linux. Other systems get pid null and a pid_error.
"""
import contextlib
import json
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath

SESSION_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,128}")
POWERSHELL_TIMEOUT_SECONDS = 10
MAX_ANCESTOR_DEPTH = 64
FILETIME_EPOCH_100NS = 116444736000000000
FILETIME_TICKS_PER_US = 10
SECOND_US = 1000000
CLAUDE_NAMES = ("claude.exe", "claude")
EVENTS = ("start", "end")
SESSIONS_DIR_PARTS = (".agent-rig", "sessions")
PROC_STAT_STARTTIME_INDEX = 19
PROC_STAT_PPID_INDEX = 1
WINDOWS_TABLE_COMMAND = (
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,"
    "@{n='Created';e={if($_.CreationDate){$_.CreationDate.ToFileTimeUtc()}else{0}}} | ConvertTo-Json -Compress"
)
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


@dataclass
class Process:
    pid: int
    parent: int
    name: str
    created_us: int | None


def session_id_valid(value):
    return isinstance(value, str) and SESSION_ID_PATTERN.fullmatch(value) is not None


def ancestors(table, start):
    chain = []
    seen = set()
    pid = start
    for _ in range(MAX_ANCESTOR_DEPTH):
        process = table.get(pid)
        if process is None or pid in seen:
            break
        seen.add(pid)
        chain.append(process)
        pid = process.parent
    return chain


def is_claude(process):
    return process.name.lower() in CLAUDE_NAMES


def claude_pid_hint(env):
    value = env.get("CLAUDE_PID", "")
    return int(value) if value.isdigit() else None


def resolve_claude(table, start, env):
    chain = ancestors(table, start)
    hint = claude_pid_hint(env)
    if hint is not None:
        for process in chain:
            if process.pid == hint and is_claude(process):
                return process, None
    for process in chain:
        if is_claude(process):
            return process, None
    return None, f"no claude ancestor of the hook process (walk from pid {start})"


def parse_windows_table(text):
    data = json.loads(text)
    rows = data if isinstance(data, list) else [data]
    table = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("process row is not an object")
        pid = row["ProcessId"]
        created = row["Created"]
        created_us = (created - FILETIME_EPOCH_100NS) // FILETIME_TICKS_PER_US if created else None
        table[pid] = Process(pid=pid, parent=row["ParentProcessId"], name=row["Name"], created_us=created_us)
    return table


def windows_process_table(run=subprocess.run):
    try:
        done = run(
            ["powershell", "-NoProfile", "-Command", WINDOWS_TABLE_COMMAND],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            timeout=POWERSHELL_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as error:
        return None, f"process table: {error}"
    if done.returncode != 0:
        return None, f"process table: powershell exit {done.returncode}"
    try:
        return parse_windows_table(done.stdout.decode("utf-8", errors="replace")), None
    except (ValueError, KeyError, TypeError) as error:
        return None, f"process table: {error}"


def parse_proc_stat(text):
    close = text.rindex(")")
    comm = text[text.index("(") + 1 : close]
    fields = text[close + 1 :].split()
    return comm, int(fields[PROC_STAT_PPID_INDEX]), int(fields[PROC_STAT_STARTTIME_INDEX])


def read_btime(stat_path):
    for line in stat_path.read_text(encoding="utf-8").splitlines():
        if line.startswith("btime "):
            return int(line.split()[1])
    raise ValueError("no btime line in proc stat")


def linux_process_table(proc=Path("/proc"), clock_ticks=None):
    ticks = clock_ticks or os.sysconf("SC_CLK_TCK")
    try:
        btime = read_btime(proc / "stat")
        entries = [entry for entry in proc.iterdir() if entry.name.isdigit()]
    except (OSError, ValueError) as error:
        return None, f"process table: {error}"
    table = {}
    for entry in entries:
        try:
            comm, ppid, start_ticks = parse_proc_stat((entry / "stat").read_text(encoding="utf-8"))
        except (OSError, ValueError, IndexError):
            continue
        name = comm
        with contextlib.suppress(OSError):
            argv = (entry / "cmdline").read_bytes().split(b"\0")
            if argv[0]:
                name = PurePosixPath(argv[0].decode("utf-8", errors="replace")).name
        pid = int(entry.name)
        created_us = btime * SECOND_US + start_ticks * SECOND_US // ticks
        table[pid] = Process(pid=pid, parent=ppid, name=name, created_us=created_us)
    return table, None


def load_process_table():
    if sys.platform == "win32":
        return windows_process_table()
    return linux_process_table()


def iso_seconds(moment):
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def iso_micro_from_us(microseconds):
    return (EPOCH + timedelta(microseconds=microseconds)).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def parse_hook_input(text):
    try:
        data = json.loads(text)
    except ValueError:
        return None
    return data if isinstance(data, dict) else None


def read_record(path):
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) else None


def write_json_atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
            handle.write("\n")
        os.replace(temp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temp)
        raise


def string_or_null(data, key):
    value = data.get(key)
    return value if isinstance(value, str) else None


def run_event(event, stdin_text, home, env, start_pid, load_table, now):
    if event not in EVENTS:
        return
    data = parse_hook_input(stdin_text)
    if data is None or not session_id_valid(data.get("session_id")):
        return
    path = home.joinpath(*SESSIONS_DIR_PARTS, f"{data['session_id']}.json")
    if event == "end":
        record = read_record(path)
        if record is None:
            return
        record["ended_at"] = iso_seconds(now)
        write_json_atomic(path, record)
        return

    previous = read_record(path)
    started_at = previous.get("started_at") if previous and isinstance(previous.get("started_at"), str) else iso_seconds(now)
    table, pid_error = load_table()
    pid = None
    pid_created = None
    if table is not None:
        process, pid_error = resolve_claude(table, start_pid, env)
        if process is not None:
            pid = process.pid
            if process.created_us is not None:
                pid_created = iso_micro_from_us(process.created_us)
    record = {
        "session_id": data["session_id"],
        "cwd": string_or_null(data, "cwd"),
        "transcript_path": string_or_null(data, "transcript_path"),
        "config_dir": env.get("CLAUDE_CONFIG_DIR", ""),
        "pid": pid,
        "pid_created": pid_created,
        "pid_error": pid_error,
        "source": string_or_null(data, "source"),
        "started_at": started_at,
        "ended_at": None,
    }
    write_json_atomic(path, record)


def main(argv):
    event = argv[1] if len(argv) > 1 else ""
    if event == "created-at":
        try:
            pids = [int(value) for value in argv[2:]]
            if any(pid <= 0 for pid in pids):
                raise ValueError("invalid process id")
            table, error = load_process_table()
            if table is None:
                raise ValueError(error or "process table unavailable")
            result = {}
            for pid in pids:
                process = table.get(pid)
                result[str(pid)] = iso_micro_from_us(process.created_us) if process is not None and process.created_us is not None else None
            print(json.dumps(result))
            return 0
        except Exception as error:
            sys.stderr.write(f"session_record: {error}\n")
            return 1
    try:
        text = sys.stdin.buffer.read().decode("utf-8")
        run_event(event, text, Path.home(), dict(os.environ), os.getppid(), load_process_table, datetime.now(timezone.utc))
    except Exception as error:
        sys.stderr.write(f"session_record: {error}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
