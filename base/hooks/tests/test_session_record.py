"""Tests for the session record hook: process resolution, record writes, bad input. No real sleeps; temp dirs removed."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "session_record.py"
SPEC = importlib.util.spec_from_file_location("session_record", SCRIPT)
RECORD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RECORD)

Process = RECORD.Process
SECOND_US = 1_000_000
EPOCH_2023_US = 1_700_000_000 * SECOND_US
HOOK_PARENT = 400
CLAUDE_OUTER = 100
CLAUDE_INNER = 300
NOW = datetime(2026, 11, 15, 10, 0, 0, tzinfo=timezone.utc)
LATER = datetime(2026, 11, 15, 11, 30, 0, tzinfo=timezone.utc)
SESSION = "probe-42"


def table(*rows):
    # rows: (pid, parent, name); creation time is 2023-11-14T22:13:20Z plus pid seconds, so it is never zero.
    return {pid: Process(pid=pid, parent=parent, name=name, created_us=EPOCH_2023_US + pid * SECOND_US) for pid, parent, name in rows}


TREE = table(
    (1, 0, "wininit.exe"),
    (CLAUDE_OUTER, 1, "claude.exe"),
    (150, CLAUDE_OUTER, "cmd.exe"),
    (CLAUDE_INNER, 150, "claude.exe"),
    (HOOK_PARENT, CLAUDE_INNER, "bash.exe"),
)


def session_table(claude_pid):
    return table((1, 0, "wininit.exe"), (claude_pid, 1, "claude.exe"), (HOOK_PARENT, claude_pid, "bash.exe"))


class ResolveClaudeTests(unittest.TestCase):
    def test_claude_pid_that_is_a_claude_ancestor_wins_over_the_nearest_one(self):
        process, error = RECORD.resolve_claude(TREE, HOOK_PARENT, {"CLAUDE_PID": str(CLAUDE_OUTER)})
        self.assertIsNone(error)
        self.assertEqual(process.pid, CLAUDE_OUTER)

    def test_without_claude_pid_the_nearest_claude_ancestor_is_taken(self):
        process, error = RECORD.resolve_claude(TREE, HOOK_PARENT, {})
        self.assertIsNone(error)
        self.assertEqual(process.pid, CLAUDE_INNER)

    def test_claude_pid_that_is_not_an_ancestor_falls_back_to_the_walk(self):
        other = {**TREE, 900: Process(pid=900, parent=1, name="claude.exe", created_us=EPOCH_2023_US)}
        process, error = RECORD.resolve_claude(other, HOOK_PARENT, {"CLAUDE_PID": "900"})
        self.assertIsNone(error)
        self.assertEqual(process.pid, CLAUDE_INNER)

    def test_claude_pid_that_is_an_ancestor_but_not_claude_falls_back_to_the_walk(self):
        for value in (str(HOOK_PARENT), "150"):
            with self.subTest(value=value):
                process, error = RECORD.resolve_claude(TREE, HOOK_PARENT, {"CLAUDE_PID": value})
                self.assertIsNone(error)
                self.assertEqual(process.pid, CLAUDE_INNER)

    def test_claude_pid_that_is_not_a_number_falls_back_to_the_walk(self):
        process, error = RECORD.resolve_claude(TREE, HOOK_PARENT, {"CLAUDE_PID": "abc"})
        self.assertIsNone(error)
        self.assertEqual(process.pid, CLAUDE_INNER)

    def test_name_match_is_case_insensitive(self):
        upper = table((1, 0, "wininit.exe"), (CLAUDE_INNER, 1, "Claude.EXE"), (HOOK_PARENT, CLAUDE_INNER, "bash.exe"))
        process, error = RECORD.resolve_claude(upper, HOOK_PARENT, {})
        self.assertIsNone(error)
        self.assertEqual(process.pid, CLAUDE_INNER)

    def test_no_claude_ancestor_gives_no_pid_and_an_error(self):
        wrappers = table((1, 0, "wininit.exe"), (200, 1, "cswap.exe"), (240, 200, "cmd.exe"), (HOOK_PARENT, 240, "bash.exe"))
        process, error = RECORD.resolve_claude(wrappers, HOOK_PARENT, {"CLAUDE_PID": "200"})
        self.assertIsNone(process)
        self.assertIn("claude", error)

    def test_wrapper_above_claude_is_never_chosen(self):
        above = table((1, 0, "wininit.exe"), (200, 1, "cswap.exe"), (240, 200, "cmd.exe"), (CLAUDE_INNER, 240, "claude.exe"), (HOOK_PARENT, CLAUDE_INNER, "bash.exe"))
        for env in ({}, {"CLAUDE_PID": "200"}, {"CLAUDE_PID": "240"}):
            with self.subTest(env=env):
                process, error = RECORD.resolve_claude(above, HOOK_PARENT, env)
                self.assertIsNone(error)
                self.assertEqual(process.pid, CLAUDE_INNER)

    def test_parent_missing_from_table_gives_an_error(self):
        process, error = RECORD.resolve_claude(TREE, 777, {})
        self.assertIsNone(process)
        self.assertIsNotNone(error)

    def test_parent_cycle_terminates(self):
        cycle = table((HOOK_PARENT, HOOK_PARENT, "bash.exe"))
        process, error = RECORD.resolve_claude(cycle, HOOK_PARENT, {})
        self.assertIsNone(process)
        self.assertIsNotNone(error)


class WindowsTableTests(unittest.TestCase):
    def test_parses_an_array_and_converts_the_filetime(self):
        # FILETIME 116444736000000000 is 1970-01-01T00:00:00Z; one second later is 10,000,000 units.
        text = json.dumps([{"ProcessId": 300, "ParentProcessId": 400, "Name": "claude.exe", "Created": 116444736010000000}])
        self.assertEqual(RECORD.parse_windows_table(text), {300: Process(pid=300, parent=400, name="claude.exe", created_us=SECOND_US)})

    def test_parses_a_single_object_that_powershell_prints_without_brackets(self):
        text = json.dumps({"ProcessId": 5, "ParentProcessId": 4, "Name": "System", "Created": 116444736010000000})
        self.assertEqual(sorted(RECORD.parse_windows_table(text)), [5])

    def test_zero_creation_time_is_unknown(self):
        text = json.dumps({"ProcessId": 4, "ParentProcessId": 0, "Name": "System", "Created": 0})
        self.assertIsNone(RECORD.parse_windows_table(text)[4].created_us)

    def test_empty_output_is_an_error(self):
        with self.assertRaises(ValueError):
            RECORD.parse_windows_table("")

    def test_timeout_is_ten_seconds_with_no_stdin_and_gives_an_error(self):
        seen = {}

        def fake_run(args, **kwargs):
            seen.update(kwargs)
            raise subprocess.TimeoutExpired(args, kwargs["timeout"])

        table_result, error = RECORD.windows_process_table(run=fake_run)
        self.assertIsNone(table_result)
        self.assertIn("process table", error)
        self.assertEqual(RECORD.POWERSHELL_TIMEOUT_SECONDS, 10)
        self.assertEqual(seen["timeout"], RECORD.POWERSHELL_TIMEOUT_SECONDS)
        self.assertIs(seen["stdin"], subprocess.DEVNULL)

    def test_successful_run_is_parsed(self):
        payload = json.dumps([{"ProcessId": 300, "ParentProcessId": 400, "Name": "claude.exe", "Created": 116444736010000000}])

        def fake_run(args, **kwargs):
            return subprocess.CompletedProcess(args, 0, stdout=payload.encode("utf-8"), stderr=b"")

        table_result, error = RECORD.windows_process_table(run=fake_run)
        self.assertIsNone(error)
        self.assertEqual(table_result[300].name, "claude.exe")

    def test_nonzero_exit_gives_an_error(self):
        def fake_run(args, **kwargs):
            return subprocess.CompletedProcess(args, 1, stdout=b"", stderr=b"boom")

        table_result, error = RECORD.windows_process_table(run=fake_run)
        self.assertIsNone(table_result)
        self.assertIsNotNone(error)


class LinuxTableTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.proc = Path(temp.name) / "proc"
        self.proc.mkdir()

    def add(self, pid, comm, ppid, start_ticks, cmdline=None):
        directory = self.proc / str(pid)
        directory.mkdir()
        # Fields after the closing parenthesis: state, ppid, 17 fields, starttime (field 22 overall, index 19 here).
        fields = ["S", str(ppid)] + ["0"] * 17 + [str(start_ticks)]
        (directory / "stat").write_text(f"{pid} ({comm}) " + " ".join(fields) + "\n", encoding="utf-8")
        if cmdline is not None:
            (directory / "cmdline").write_bytes(b"\0".join(part.encode("utf-8") for part in cmdline) + b"\0")

    def test_reads_names_parents_and_creation_times(self):
        (self.proc / "stat").write_text("cpu 1 2 3\nbtime 1700000000\n", encoding="utf-8")
        self.add(1, "init", 0, 10, ["/sbin/init"])
        self.add(50, "claude", 1, 250, ["/usr/local/bin/claude", "--print"])
        self.add(60, "my) tool", 50, 300, ["/bin/bash"])
        table_result, error = RECORD.linux_process_table(proc=self.proc, clock_ticks=100)
        self.assertIsNone(error)
        self.assertEqual(table_result[50], Process(pid=50, parent=1, name="claude", created_us=1700000002500000))
        self.assertEqual(table_result[60].name, "bash")
        self.assertEqual(table_result[60].parent, 50)
        self.assertEqual(RECORD.resolve_claude(table_result, 60, {})[0].pid, 50)

    def test_missing_proc_gives_an_error(self):
        table_result, error = RECORD.linux_process_table(proc=self.proc / "missing", clock_ticks=100)
        self.assertIsNone(table_result)
        self.assertIsNotNone(error)


class SessionIdTests(unittest.TestCase):
    def test_safe_names_pass(self):
        for value in ("probe-42", "9f1c2a3e-5b6d-4e7f-8a9b-0c1d2e3f4a5b", "a_B-9"):
            with self.subTest(value=value):
                self.assertTrue(RECORD.session_id_valid(value))

    def test_unsafe_names_fail(self):
        for value in ("", "..", "../x", "a/b", "a\\b", "a b", "x.y", ".hidden", "a" * 129, None, 123):
            with self.subTest(value=value):
                self.assertFalse(RECORD.session_id_valid(value))


class SessionRecordTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.sessions = self.home / ".agent-rig" / "sessions"
        self.loads = 0

    def loader(self, claude_pid=CLAUDE_INNER):
        def load():
            self.loads += 1
            return session_table(claude_pid), None
        return load

    def run_hook(self, event, data, load=None, now=NOW, env=None):
        text = data if isinstance(data, str) else json.dumps(data)
        RECORD.run_event(event, text, self.home, {"CLAUDE_CONFIG_DIR": "C:/cfg/2"} if env is None else env, HOOK_PARENT, load or self.loader(), now)

    def start_data(self, **extra):
        return {"session_id": SESSION, "cwd": "C:/work/project", "transcript_path": "C:/t/probe.jsonl", "source": "startup", "hook_event_name": "SessionStart", **extra}

    def read(self):
        return json.loads((self.sessions / f"{SESSION}.json").read_text(encoding="utf-8"))

    def test_start_writes_every_field(self):
        self.run_hook("start", self.start_data())
        record = self.read()
        self.assertEqual(set(record), {"session_id", "cwd", "transcript_path", "config_dir", "pid", "pid_created", "pid_error", "source", "started_at", "ended_at"})
        self.assertEqual(record["session_id"], SESSION)
        self.assertEqual(record["cwd"], "C:/work/project")
        self.assertEqual(record["transcript_path"], "C:/t/probe.jsonl")
        self.assertEqual(record["config_dir"], "C:/cfg/2")
        self.assertEqual(record["pid"], CLAUDE_INNER)
        self.assertEqual(record["pid_created"], "2023-11-14T22:18:20.000000Z")
        self.assertIsNone(record["pid_error"])
        self.assertEqual(record["source"], "startup")
        self.assertEqual(record["started_at"], "2026-11-15T10:00:00Z")
        self.assertIsNone(record["ended_at"])

    def test_config_dir_is_empty_for_the_main_login(self):
        self.run_hook("start", self.start_data(), env={})
        self.assertEqual(self.read()["config_dir"], "")

    def test_resume_and_compact_update_pid_and_keep_started_at(self):
        self.run_hook("start", self.start_data())
        for source in ("resume", "compact"):
            with self.subTest(source=source):
                self.run_hook("start", self.start_data(source=source), load=self.loader(claude_pid=555), now=LATER)
                record = self.read()
                self.assertEqual(record["pid"], 555)
                self.assertEqual(record["source"], source)
                self.assertEqual(record["started_at"], "2026-11-15T10:00:00Z")
                self.assertIsNone(record["ended_at"])

    def test_end_sets_ended_at_and_keeps_the_rest(self):
        self.run_hook("start", self.start_data())
        before = self.read()
        self.run_hook("end", {"session_id": SESSION, "hook_event_name": "SessionEnd"}, now=LATER)
        after = self.read()
        self.assertEqual(after["ended_at"], "2026-11-15T11:30:00Z")
        self.assertEqual({**after, "ended_at": None}, before)

    def test_start_after_end_clears_ended_at(self):
        self.run_hook("start", self.start_data())
        self.run_hook("end", {"session_id": SESSION}, now=LATER)
        self.run_hook("start", self.start_data(source="resume"))
        self.assertIsNone(self.read()["ended_at"])

    def test_end_without_a_record_writes_nothing(self):
        self.run_hook("end", {"session_id": SESSION}, now=LATER)
        self.assertFalse(self.sessions.exists())

    def test_missing_pid_is_recorded_with_an_error_and_the_record_still_written(self):
        def no_table():
            self.loads += 1
            return None, "process table: powershell timed out"
        self.run_hook("start", self.start_data(), load=no_table)
        record = self.read()
        self.assertIsNone(record["pid"])
        self.assertIsNone(record["pid_created"])
        self.assertEqual(record["pid_error"], "process table: powershell timed out")

    def test_no_claude_ancestor_is_recorded_with_an_error(self):
        def only_bash():
            self.loads += 1
            return table((1, 0, "wininit.exe"), (HOOK_PARENT, 1, "bash.exe")), None
        self.run_hook("start", self.start_data(), load=only_bash)
        record = self.read()
        self.assertIsNone(record["pid"])
        self.assertIn("claude", record["pid_error"])

    def test_bad_session_id_is_ignored_before_any_lookup(self):
        bad = ["", "..", "../escape", "a/b", "a b", "x.y", None, 7]
        for value in bad:
            with self.subTest(value=value):
                data = {"session_id": value, "source": "startup"}
                self.run_hook("start", data)
                self.run_hook("end", data)
        self.assertEqual(self.loads, 0)
        self.assertFalse(self.sessions.exists())
        self.assertFalse((self.home / "escape.json").exists())

    def test_bad_stdin_is_ignored(self):
        for text in ("not json", "[1, 2]", ""):
            with self.subTest(text=text):
                self.run_hook("start", text)
                self.run_hook("end", text)
        self.assertFalse(self.sessions.exists())

    def test_unknown_event_is_ignored(self):
        self.run_hook("bogus", self.start_data())
        self.assertFalse(self.sessions.exists())

    def test_write_leaves_only_the_record_and_removes_its_temp_file_on_failure(self):
        self.run_hook("start", self.start_data())
        self.assertEqual(sorted(path.name for path in self.sessions.iterdir()), [f"{SESSION}.json"])
        with mock.patch.object(RECORD.os, "replace", side_effect=OSError("locked")):
            with self.assertRaises(OSError):
                self.run_hook("end", {"session_id": SESSION}, now=LATER)
        self.assertEqual(sorted(path.name for path in self.sessions.iterdir()), [f"{SESSION}.json"])
        self.assertIsNone(self.read()["ended_at"])


class CommandLineTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.sessions = self.home / ".agent-rig" / "sessions"

    def run_script(self, event, text):
        env = {key: value for key, value in os.environ.items() if not key.startswith("CLAUDE_")}
        env.update({"HOME": str(self.home), "USERPROFILE": str(self.home)})
        return subprocess.run([sys.executable, "-I", str(SCRIPT), event], input=text.encode("utf-8"), capture_output=True, env=env, check=False)

    def test_end_from_the_command_line_exits_zero_with_empty_stdout(self):
        self.sessions.mkdir(parents=True)
        (self.sessions / f"{SESSION}.json").write_text(json.dumps({"session_id": SESSION, "ended_at": None}), encoding="utf-8")
        result = self.run_script("end", json.dumps({"session_id": SESSION, "hook_event_name": "SessionEnd"}))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b"")
        self.assertIsNotNone(json.loads((self.sessions / f"{SESSION}.json").read_text(encoding="utf-8"))["ended_at"])

    def test_bad_start_input_from_the_command_line_exits_zero_and_writes_nothing(self):
        result = self.run_script("start", "{broken")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b"")
        self.assertFalse(self.sessions.exists())


if __name__ == "__main__":
    unittest.main()
