"""Tests for codex-run.py, including process cleanup and an optional live probe."""
import csv
import ctypes
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parent.parent / "codex-run.py"
spec = importlib.util.spec_from_file_location("codex_run", SCRIPT)
cr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cr)

GIT_BASH_MARK = "bash.exe"
SANDBOX_MARK = "Sandbox limits"
# The job starts a child that outlives it unless the cancel kills the whole job's process group.
JOB_SCRIPT = """
import os, subprocess, sys, time
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
with open(sys.argv[1], "w") as f:
    f.write(f"{os.getpid()} {child.pid}")
time.sleep(600)
"""
# Readiness wait only: the fake clock below returns at once once the job has written its pids.
STARTUP_POLL_SECONDS = 0.01
# Bounds the wait for a job that does not stop; a job that stops returns at once.
JOB_STOP_TIMEOUT_SECONDS = 10
KILL_SIGNAL = 9
PROC_STAT = "/proc/{pid}/stat"
ZOMBIE_STATE = "Z"


def process_alive(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    stat = Path(PROC_STAT.format(pid=pid))
    if stat.exists() and stat.read_text(encoding="utf-8").rsplit(")", 1)[1].split()[0] == ZOMBIE_STATE:
        return False
    return True


class ProcessProbeTest(unittest.TestCase):
    def test_unknown_process_errors_are_not_absence(self):
        kernel = mock.Mock()
        kernel.OpenProcess.return_value = 0
        with mock.patch.object(cr.os, "name", "nt"), mock.patch.object(cr.ctypes, "WinDLL", create=True, return_value=kernel) as win_dll, \
                mock.patch.object(cr.ctypes, "get_last_error", create=True) as last_error:
            last_error.return_value = 5
            self.assertTrue(cr.pid_alive(123))
            win_dll.assert_called_with("kernel32", use_last_error=True)
            last_error.return_value = 87
            self.assertFalse(cr.pid_alive(123))
            kernel.OpenProcess.return_value = 1
            kernel.GetExitCodeProcess.return_value = 0
            self.assertTrue(cr.pid_alive(123))
        with mock.patch.object(cr.os, "name", "posix"), mock.patch.object(cr.os, "kill", side_effect=PermissionError()):
            self.assertTrue(cr.pid_alive(123))
        with mock.patch.object(cr.os, "name", "posix"), mock.patch.object(cr.os, "kill", side_effect=ProcessLookupError()):
            self.assertFalse(cr.pid_alive(123))


class RunRulesTest(unittest.TestCase):
    def test_report_contract_in_prompt(self):
        self.assertIn("More work than expected is never a reason to stop", cr.run_rules(False))
        self.assertIn("Blocked by: for blocked", cr.run_rules(False))

    def test_report_validation(self):
        for report, expected in [("STATUS: done", ("done", None)),
                                 ("STATUS: question\nQuestions: choose A or B", ("question", None)),
                                 ("STATUS: blocked\nBlocked by: access: a credential is missing", ("blocked", None)),
                                 ("STATUS: blocked\nBlocked by: ENVIRONMENT: the tool crashed twice", ("blocked", None)),
                                 ("STATUS: blocked\nBlocked by:\n- access: the token is rejected", ("blocked", None)),
                                 ("STATUS: blocked\nBlocked by: **environment:** the build tool is missing", ("blocked", None))]:
            self.assertEqual(cr.validate_report(report), expected)
        for report, missing in [("text", "STATUS"), ("STATUS: partial", "status"),
                                ("STATUS: done extra", "status"),
                                ("STATUS: question\nQuestions: none", "Questions"),
                                ("STATUS: question\nQuestions:\nRisks: none", "Questions"),
                                ("STATUS: blocked\nBlocked by: none", "access or environment"),
                                ("STATUS: blocked", "access or environment")]:
            with self.subTest(report=report):
                self.assertIn(missing.lower(), cr.validate_report(report)[1].lower())

    def test_blocked_requires_a_specific_cause(self):
        for cause in ("Implementation remains incomplete; no missing access or environment failure was identified.",
                      "I could not complete the implementation in this turn. This is not a missing-access or environment failure, so it does not meet the brief's definition of a blocker.",
                      "access:", "environment:   ", "other: a problem", "access: none"):
            with self.subTest(cause=cause):
                status, error = cr.validate_report("STATUS: blocked\nBlocked by: " + cause)
                self.assertIsNone(status)
                self.assertIn("access or environment", error.lower())
                self.assertIn("unfinished work", error.lower())

    def test_malformed_recovery_and_restart(self):
        for reports, prior, expected, calls in [(["bad", "STATUS: blocked\nBlocked by: access: a credential is missing"], 0, "blocked", 2),
                                                 (["STATUS: blocked\nBlocked by: unfinished", "STATUS: blocked\nBlocked by: access:"], 0, "malformed", 2),
                                                 (["bad", "bad again"], 0, "malformed", 2),
                                                 (["bad again"], 1, "malformed", 1)]:
            with self.subTest(expected=expected, prior=prior), tempfile.TemporaryDirectory() as tmp:
                job = Path(tmp)
                cr.write_json(job / "state.json", {"cwd": tmp, "created": cr.now(), "notes": [],
                              "session_id": "session", "malformed_follow_ups": prior})
                sup = cr.Supervisor(job)
                prompts = []
                def run_once(text):
                    prompts.append(text)
                    (job / "last.md").write_text(reports[len(prompts) - 1], encoding="utf-8")
                    sup.saw_turn_completed = True
                    return None, 0
                with mock.patch.object(sup, "run_once", side_effect=run_once):
                    sup.run()
                state = cr.read_json(job / "state.json")
                self.assertEqual(state["status"], expected)
                self.assertEqual(len(prompts), calls)
                if calls == 2:
                    self.assertIn("STATUS", prompts[1])
                if expected == "malformed":
                    self.assertTrue(state["report_error"])

    def test_windows_rules_name_git_bash(self):
        self.assertIn(GIT_BASH_MARK, cr.run_rules(windows=True))

    def test_posix_rules_do_not_name_git_bash(self):
        rules = cr.run_rules(windows=False)
        self.assertNotIn(GIT_BASH_MARK, rules)
        self.assertNotIn("bash.exe", rules)

    def test_common_rules_stay_on_both_platforms(self):
        for windows in (True, False):
            self.assertIn(SANDBOX_MARK, cr.run_rules(windows=windows))


NESTED_SHELL_PLACEHOLDER_RE = r"""(?:-l?c\s+'<|-Command\s+"<|/c\s+"<)"""
# Invented equivalent of a real job's command: the tool's PowerShell wrapper around a Git Bash command string.
NESTED_BASH_COMMAND = ('powershell.exe -Command "& \\"C:\\Program Files\\Git\\bin\\bash.exe\\" -lc '
                       "'IFS= read -r line < notes.txt; printf \\\"%s\\n\\\" \\\"$line\\\"'\"")
SCRIPT_BY_PATH_COMMAND = ('powershell.exe -Command "& \\"C:\\Program Files\\Git\\bin\\bash.exe\\" '
                          '.tmp/read-first-line.sh notes.txt"')


def command_event(command):
    return {"type": "item.completed", "item": {"type": "command_execution", "command": command}}


class NestedShellTest(unittest.TestCase):
    def test_run_rules_do_not_tell_a_nested_shell(self):
        for windows in (True, False):
            self.assertIsNone(re.search(NESTED_SHELL_PLACEHOLDER_RE, cr.run_rules(windows)))

    def test_detector_flags_bash_inside_powershell(self):
        self.assertEqual(cr.nested_shell_commands([command_event(NESTED_BASH_COMMAND)]), [NESTED_BASH_COMMAND])

    def test_detector_flags_other_nested_shells(self):
        for inner in ('powershell -NoProfile -Command "Get-Date"', 'cmd /c "dir"', "sh -c 'ls'", "pwsh -Command ls"):
            cmd = f'powershell.exe -Command "{inner}"'
            self.assertEqual(cr.nested_shell_commands([command_event(cmd)]), [cmd], inner)

    def test_detector_flags_nested_shell_under_posix_wrapper(self):
        cmd = "/bin/bash -lc \"bash -c 'ls'\""
        self.assertEqual(cr.nested_shell_commands([command_event(cmd)]), [cmd])

    def test_detector_ignores_plain_commands_and_scripts(self):
        plain = ['powershell.exe -Command "Get-Content notes.txt -TotalCount 1"',
                 'powershell.exe -Command "git status"', "/bin/bash -lc \"git status\"", SCRIPT_BY_PATH_COMMAND,
                 'powershell.exe -Command "rg -n \\"bash -c\\" docs"']
        for cmd in plain:
            self.assertEqual(cr.nested_shell_commands([command_event(cmd)]), [], cmd)

    def test_detector_ignores_other_event_types(self):
        self.assertEqual(cr.nested_shell_commands([{"type": "item.started", "item": {
            "type": "command_execution", "command": NESTED_BASH_COMMAND}}]), [])

    def test_final_digest_warns(self):
        with tempfile.TemporaryDirectory(prefix="codex-run-nested-test-") as tmp:
            d = Path(tmp)
            (d / "events.jsonl").write_text(json.dumps(command_event(NESTED_BASH_COMMAND)) + "\n", encoding="utf-8")
            st = {"job": "j", "status": "blocked", "slug": "s", "effort": "high", "created": time.time(),
                  "error": "x"}
            out = cr.digest(d, st, [], True)
            self.assertIn("warning: 1 command(s) passed a command string to a second shell", out)
            self.assertIn("bash.exe", out)


class TerraLineTest(unittest.TestCase):
    def test_terra_resolves_to_newest_model_at_its_floor(self):
        with tempfile.TemporaryDirectory(prefix="codex-run-model-test-") as tmp:
            cache = Path(tmp) / "models_cache.json"
            cache.write_text(json.dumps({"models": [
                {"slug": "gpt-5.6-terra", "visibility": "list",
                 "supported_reasoning_levels": [{"effort": "high"}]},
                {"slug": "gpt-6.1-terra", "visibility": "list",
                 "supported_reasoning_levels": [{"effort": "high"}]},
            ]}), encoding="utf-8")
            with mock.patch.object(cr, "MODELS_CACHE", cache):
                self.assertEqual(cr.resolve_model("terra"), ("gpt-6.1-terra", ["high"]))
                cache.write_text(json.dumps({"models": [{
                    "slug": "gpt-5.6-terra", "visibility": "list",
                    "supported_reasoning_levels": [{"effort": "high"}],
                }]}), encoding="utf-8")
                with self.assertRaisesRegex(SystemExit, "6.1"):
                    cr.resolve_model("terra")

    def test_usage_limit_ends_without_changing_the_model_line(self):
        with tempfile.TemporaryDirectory(prefix="codex-run-limit-test-") as tmp:
            d = Path(tmp)
            cr.write_json(d / "state.json", {"job": "job1", "line": "sol", "slug": "gpt-6.1-sol",
                          "effort": "high", "cwd": tmp, "created": cr.now(), "notes": [],
                          "session_id": "session"})
            sup = cr.Supervisor(d)
            calls = []

            def usage_limit(text):
                calls.append(text)
                sup.error_text = "usage limit reached; try again at 11:39 PM."
                return None, 1

            with mock.patch.object(sup, "run_once", side_effect=usage_limit):
                sup.run()
            state = cr.read_json(d / "state.json")
            self.assertEqual(state["status"], "limit")
            self.assertEqual(state["limit_reset"], "11:39 PM")
            self.assertEqual((state["line"], state["slug"], state["effort"]), ("sol", "gpt-6.1-sol", "high"))
            self.assertEqual(len(calls), 1)

    def test_usage_limit_without_reset_time_has_null_reset(self):
        with tempfile.TemporaryDirectory(prefix="codex-run-limit-test-") as tmp:
            d = Path(tmp)
            cr.write_json(d / "state.json", {"job": "job1", "line": "sol", "slug": "gpt-6.1-sol",
                          "effort": "high", "cwd": tmp, "created": cr.now(), "notes": [],
                          "session_id": "session"})
            sup = cr.Supervisor(d)
            def usage_limit(text):
                sup.error_text = "usage limit reached."
                return None, 1
            with mock.patch.object(sup, "run_once", side_effect=usage_limit):
                sup.run()
            state = cr.read_json(d / "state.json")
            self.assertEqual(state["status"], "limit")
            self.assertIsNone(state["limit_reset"])

    def test_usage_limit_parses_calendar_reset_time(self):
        with tempfile.TemporaryDirectory(prefix="codex-run-limit-test-") as tmp:
            d = Path(tmp)
            cr.write_json(d / "state.json", {"job": "job1", "line": "sol", "slug": "gpt-6.1-sol",
                          "effort": "high", "cwd": tmp, "created": cr.now(), "notes": [],
                          "session_id": "session"})
            sup = cr.Supervisor(d)

            def usage_limit(text):
                sup.error_text = "usage limit reached; try again at Nov 6th, 2026 8:00 AM."
                return None, 1

            with mock.patch.object(sup, "run_once", side_effect=usage_limit):
                sup.run()
            self.assertEqual(cr.read_json(d / "state.json")["limit_reset"], "Nov 6th, 2026 8:00 AM")

    def start_terra(self, effort, approved):
        with tempfile.TemporaryDirectory(prefix="codex-run-start-test-") as tmp:
            root = Path(tmp)
            args = mock.Mock(model="terra", effort=effort, approved=approved,
                             prompt_file="unused", cwd=str(root), read_only=False)
            with mock.patch.multiple(
                    cr, JOBS_DIR=root / "jobs", resolve_model=mock.Mock(
                        return_value=("gpt-6.1-terra", list(cr.ALL_EFFORTS))),
                    take_prompt=mock.Mock(return_value="task"), cleanup_old_jobs=mock.Mock()), \
                    mock.patch.object(cr, "spawn_supervisor"), \
                    redirect_stdout(io.StringIO()):
                cr.cmd_start(args)

    def test_terra_effort_above_high_needs_approval(self):
        self.assertEqual(cr.FLOORS["terra"], (6, 1))
        args = mock.Mock(model="terra", effort="xhigh", approved=False)
        with self.assertRaisesRegex(SystemExit, "REFUSED"):
            cr.cmd_start(args)

    def test_terra_effort_above_high_is_allowed_with_approval(self):
        self.start_terra("xhigh", approved=True)

    def test_terra_effort_at_or_below_high_needs_no_approval(self):
        for effort in ("low", "medium", "high"):
            with self.subTest(effort=effort):
                self.start_terra(effort, approved=False)

    def test_default_model_is_terra(self):
        args_seen = []
        with mock.patch.object(sys, "argv", ["codex-run.py", "start", "--prompt-file", "prompt.md"]), \
                mock.patch.object(cr, "cmd_start", side_effect=lambda args: args_seen.append(args)):
            cr.main()
        self.assertEqual(args_seen[0].model, "terra")


FAKE_CODEX = Path(__file__).resolve().parent / "fake_codex.py"


class DetachedChildTest(unittest.TestCase):
    def run_job(self, cancelled):
        with tempfile.TemporaryDirectory(prefix="codex-detached-") as tmp:
            job = Path(tmp)
            pid_file = job / "child.pid"
            cr.write_json(job / "state.json", {"cwd": tmp, "created": cr.now(), "notes": []})
            sup = cr.Supervisor(job)
            sup.command = lambda resume_text=None: ([sys.executable, str(FAKE_CODEX), "-o", str(job / "last.md")], "prompt")
            env = {"FAKE_CODEX_CHILD_PID": str(pid_file), "FAKE_CODEX_WAIT": "1" if cancelled else ""}
            outcome = {}
            def run():
                sup.run()
                outcome.update(cr.read_json(job / "state.json"))
            worker = threading.Thread(target=run, daemon=True)
            try:
                with mock.patch.dict(os.environ, env), mock.patch.object(cr, "POLL_SECONDS", 0.01):
                    worker.start()
                    deadline = time.monotonic() + JOB_STOP_TIMEOUT_SECONDS
                    while not pid_file.exists() and time.monotonic() < deadline:
                        threading.Event().wait(0.01)
                    self.assertTrue(pid_file.exists(), "fake Codex did not start its child")
                    if cancelled:
                        (job / "cancel").touch()
                    worker.join(JOB_STOP_TIMEOUT_SECONDS)
                    self.assertFalse(worker.is_alive(), "supervisor did not stop")
                    self.assertEqual(outcome.get("status"), "cancelled" if cancelled else "done")
                    pid = int(pid_file.read_text(encoding="utf-8"))
                    deadline = time.monotonic() + JOB_STOP_TIMEOUT_SECONDS
                    while cr.pid_alive(pid) and time.monotonic() < deadline:
                        threading.Event().wait(0.01)
                    self.assertFalse(cr.pid_alive(pid), "detached child survived the job")
            finally:
                if pid_file.exists():
                    pid = int(pid_file.read_text(encoding="utf-8"))
                    if cr.pid_alive(pid):
                        os.kill(pid, 9)

    def test_normal_finish_stops_detached_child(self):
        self.run_job(False)

    def test_cancel_stops_detached_child(self):
        self.run_job(True)


JOB_OBJECT_BASIC_PROCESS_ID_LIST = 3  # JOBOBJECTINFOCLASS value for JOBOBJECT_BASIC_PROCESS_ID_LIST
ERROR_MORE_DATA = 234
# A Codex job holds a handful of processes (runner, shell, node); 256 ids fit with a wide margin, and a
# bigger job is handled by the ERROR_MORE_DATA retry that doubles the buffer.
INITIAL_JOB_PID_SLOTS = 256
PROCESS_EXIT_WAIT_SECONDS = 15


def job_process_ids(handle):
    """PIDs currently assigned to a Windows job object."""
    from ctypes import wintypes
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
                                                   ctypes.POINTER(wintypes.DWORD)]
    kernel32.QueryInformationJobObject.restype = wintypes.BOOL
    slots = INITIAL_JOB_PID_SLOTS
    while True:
        class PidList(ctypes.Structure):
            _fields_ = [("NumberOfAssignedProcesses", wintypes.DWORD),
                        ("NumberOfProcessIdsInList", wintypes.DWORD),
                        ("ProcessIdList", ctypes.c_size_t * slots)]
        info = PidList()
        if kernel32.QueryInformationJobObject(handle, JOB_OBJECT_BASIC_PROCESS_ID_LIST, ctypes.byref(info),
                                              ctypes.sizeof(info), None):
            return list(info.ProcessIdList[:info.NumberOfProcessIdsInList])
        if ctypes.get_last_error() != ERROR_MORE_DATA:
            raise ctypes.WinError(ctypes.get_last_error())
        slots = max(slots * 2, info.NumberOfAssignedProcesses)


def image_names():
    """PID to image name for every running process, from one tasklist call."""
    out = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True, check=True).stdout
    names = {}
    for row in csv.reader(out.splitlines()):
        if len(row) > 1 and row[1].isdigit():
            names[int(row[1])] = row[0]
    return names


@unittest.skipUnless(os.environ.get("CODEX_RUN_LIVE_PROBE") == "1", "set CODEX_RUN_LIVE_PROBE=1 to run the real Codex probe")
@unittest.skipUnless(os.name == "nt", "the probe reads the Windows job object")
class LiveCodexProbe(unittest.TestCase):
    """Set CODEX_RUN_LIVE_PROBE=1 to run a real, potentially billable Codex job (a `luna` job, medium effort).

    Run: CODEX_RUN_LIVE_PROBE=1 python -B -m unittest discover -v -s features/codex/tools/tests -p test_codex_run.py -k LiveCodexProbe
    """

    def test_real_job_leaves_no_detached_processes(self):
        with tempfile.TemporaryDirectory(prefix="codex-live-probe-") as tmp:
            root = Path(tmp)
            job = root / "job"
            job.mkdir()
            cwd = root / "work"
            cwd.mkdir()
            (job / "prompt.md").write_text(
                "Start a long-lived detached process using node -e \"setInterval(()=>{},1000)\". "
                "Then finish with STATUS: done.", encoding="utf-8")
            slug, _ = cr.resolve_model("luna")
            cr.write_json(job / "state.json", {"cwd": str(cwd), "created": cr.now(), "notes": [],
                          "slug": slug, "line": "luna", "effort": "medium", "read_only": False})
            sup = cr.Supervisor(job)
            real_close = cr.process_job.close
            recorded = []  # (pid, image name) of the processes in the job when it was first closed

            def recording_close(job_handle):
                if job_handle.handle is not None and not recorded:
                    pids = job_process_ids(job_handle.handle)
                    names = image_names()
                    recorded.extend((pid, names[pid]) for pid in pids if pid in names)  # in the list and in tasklist: alive
                    recorded.append(None)  # marks that the first close was seen, even with an empty job
                return real_close(job_handle)

            errors = []
            def run():
                try:
                    sup.run()
                except Exception as exc:
                    errors.append(exc)
            with mock.patch.object(cr.process_job, "close", side_effect=recording_close):
                worker = threading.Thread(target=run, daemon=True)
                worker.start()
                worker.join()
            self.assertFalse(errors, str(errors))
            self.assertEqual(cr.read_json(job / "state.json")["status"], "done")
            held = [entry for entry in recorded if entry is not None]
            print("job processes at close:", held)
            self.assertTrue(held, "the job held no live process at close, so the leak was not reproduced")

            # cr.pid_alive cannot see processes of the Codex sandbox user (OpenProcess is denied), so liveness
            # is the pid and image name still present in tasklist, which lists every user's processes.
            def survivors():
                names = image_names()
                return [entry for entry in held if names.get(entry[0]) == entry[1]]
            deadline = time.monotonic() + PROCESS_EXIT_WAIT_SECONDS
            while survivors() and time.monotonic() < deadline:
                threading.Event().wait(0.05)
            self.assertEqual(survivors(), [], "processes survived the job close")


class StartPathTest(unittest.TestCase):
    """Drives cmd_start and the supervisor with the module's real constants against a fake codex."""

    def test_started_job_runs_to_done_with_a_fake_codex(self):
        tmp = Path(tempfile.mkdtemp(prefix="codex-run-test-")).resolve()
        self.addCleanup(shutil.rmtree, tmp, True)
        cache = tmp / "models_cache.json"
        cache.write_text(json.dumps({"models": [{
            "slug": "gpt-6-luna", "visibility": "list",
            "supported_reasoning_levels": [{"effort": "high"}]}]}), encoding="utf-8")
        prompt = tmp / "prompt.md"
        prompt.write_text("do the task", encoding="utf-8")
        work = tmp / "work"
        work.mkdir()
        jobs = tmp / "jobs"
        real_command = cr.Supervisor.command

        def fake_command(sup, resume_text=None):
            cmd, stdin_text = real_command(sup, resume_text)
            return [sys.executable, "-I", str(FAKE_CODEX)] + cmd[1:], stdin_text

        args = mock.Mock(model="luna", effort="high", approved=False, prompt_file=str(prompt), cwd=str(work),
                         read_only=False)
        with mock.patch.multiple(cr, JOBS_DIR=jobs, MODELS_CACHE=cache, POLL_SECONDS=0.01), \
                mock.patch.object(cr, "spawn_supervisor") as spawn, \
                mock.patch.object(cr.Supervisor, "command", fake_command), \
                redirect_stdout(io.StringIO()):
            cr.cmd_start(args)
            job_dir = spawn.call_args.args[0]
            cr.Supervisor(job_dir).run()
        state = cr.read_json(job_dir / "state.json")
        self.assertEqual(state["status"], "done", state)
        self.assertIn("STATUS: done", (job_dir / "last.md").read_text(encoding="utf-8"))


STARTING_STALE_SECONDS = 100  # above the 60 s the wait gives a supervisor to start
REPLY_STATUSES = ("done", "question", "blocked", "malformed", "limit")
NOT_REPLYABLE_STATUSES = ("running", "starting", "cancelled", "orphaned")
BLOCKED_REPORT = "Stopped.\nSTATUS: blocked\nBlocked by: access: the access key is missing"
REPORT_TEXT = "Result in short.\nSTATUS: done\nDone: - the secret report body\nChanged files: a.py"


class JobLifecycleTest(unittest.TestCase):
    """cmd_wait, cmd_reply and the malformed counter across turns."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="codex-run-test-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        patcher = mock.patch.multiple(cr, JOBS_DIR=self.tmp, POLL_SECONDS=0.01)
        patcher.start()
        self.addCleanup(patcher.stop)

    def make_job(self, **fields):
        d = self.tmp / "job1"
        d.mkdir()
        state = {"job": "job1", "line": "luna", "slug": "gpt-6-luna", "effort": "high",
                 "read_only": False, "cwd": str(self.tmp),
                 "created": cr.now(), "notes": [], "session_id": "session"}
        state.update(fields)
        cr.write_json(d / "state.json", state)
        return d

    def wait(self, d, interval=0):
        out = io.StringIO()
        with redirect_stdout(out):
            cr.cmd_wait(mock.Mock(job="job1", interval=interval))
        return cr.read_json(d / "state.json"), out.getvalue()

    def test_wait_retries_a_sharing_violation_without_writing(self):
        d = self.make_job(status="running", supervisor_pid=123)
        original = cr.read_json(d / "state.json")
        read_text = Path.read_text
        attempts = []

        def flaky_read(path, *args, **kwargs):
            if path == d / "state.json" and not attempts:
                attempts.append(True)
                raise PermissionError("sharing violation")
            return read_text(path, *args, **kwargs)

        with mock.patch.object(Path, "read_text", flaky_read), mock.patch.object(cr, "pid_alive", return_value=True), \
                mock.patch.object(cr.time, "sleep"), mock.patch.object(cr, "write_json", wraps=cr.write_json) as write:
            state, _ = self.wait(d)
        write.assert_not_called()
        self.assertEqual(state, original)

    def test_wait_recovers_valid_report_after_supervisor_dies(self):
        d = self.make_job(status="running", supervisor_pid=123)
        original = cr.read_json(d / "state.json")
        (d / "last.md").write_text(REPORT_TEXT, encoding="utf-8")
        with mock.patch.object(cr, "pid_alive", return_value=False):
            state, out = self.wait(d)
        self.assertEqual(state["status"], "done")
        self.assertIn("secret report body", out)
        for key, value in original.items():
            if key != "status":
                self.assertEqual(state[key], value)

    def test_wait_preserves_fields_when_supervisor_dies_without_report(self):
        d = self.make_job(status="running", supervisor_pid=123)
        original = cr.read_json(d / "state.json")
        with mock.patch.object(cr, "pid_alive", return_value=False):
            state, _ = self.wait(d)
        self.assertEqual((state["status"], state["error"]), ("blocked", "supervisor process died"))
        for key, value in original.items():
            if key != "status":
                self.assertEqual(state[key], value)

    def test_wait_keeps_terminal_state_written_during_pid_check(self):
        d = self.make_job(status="running", supervisor_pid=123)

        def finish(pid):
            state = cr.read_json(d / "state.json")
            state.update(status="done", ended=cr.now())
            cr.write_json(d / "state.json", state)
            return False

        with mock.patch.object(cr, "pid_alive", side_effect=finish):
            state, _ = self.wait(d)
        self.assertEqual(state["status"], "done")

    def test_cancel_keeps_terminal_state_written_before_kill(self):
        d = self.make_job(status="running", supervisor_pid=123)

        def finish(pid):
            state = cr.read_json(d / "state.json")
            state.update(status="done", ended=cr.now())
            cr.write_json(d / "state.json", state)

        with mock.patch.object(cr, "now", side_effect=[0, 16, 16]), \
                mock.patch.object(cr, "kill_pid", side_effect=finish), redirect_stdout(io.StringIO()):
            cr.cmd_cancel(mock.Mock(job="job1"))
        self.assertEqual(cr.read_json(d / "state.json")["status"], "done")

    def test_write_retries_a_sharing_violation(self):
        d = self.make_job(status="running")
        replace = os.replace
        attempts = []

        def flaky_replace(source, target):
            if not attempts:
                attempts.append(True)
                raise PermissionError("sharing violation")
            replace(source, target)

        with mock.patch.object(cr.os, "replace", side_effect=flaky_replace), mock.patch.object(cr.time, "sleep"):
            cr.write_json(d / "state.json", {"status": "done"})
        self.assertEqual(cr.read_json(d / "state.json")["status"], "done")

    def test_unreadable_state_is_distinct_from_missing(self):
        d = self.make_job(status="running")
        with mock.patch.object(Path, "read_text", side_effect=PermissionError), mock.patch.object(cr.time, "sleep"):
            self.assertIs(cr.read_json(d / "state.json"), cr.UNREADABLE)
        self.assertIsNone(cr.read_json(d / "missing.json"))

    def test_unreadable_state_never_causes_client_write(self):
        d = self.make_job(status="running", supervisor_pid=123)
        original = cr.read_json(d / "state.json")
        with mock.patch.object(cr, "read_json", return_value=cr.UNREADABLE), \
                mock.patch.object(cr, "write_json") as write, redirect_stdout(io.StringIO()) as out:
            cr.cmd_wait(mock.Mock(job="job1", interval=0))
            cr.cmd_cancel(mock.Mock(job="job1"))
            with self.assertRaises(SystemExit):
                cr.cmd_reply(mock.Mock(job="job1"))
            cr.cmd_list(mock.Mock())
            cr.cleanup_old_jobs()
        write.assert_not_called()
        self.assertIn("unknown", out.getvalue())
        self.assertEqual(cr.read_json(d / "state.json"), original)

    def test_wait_does_not_write_when_fresh_read_is_unreadable(self):
        d = self.make_job(status="running", supervisor_pid=123)
        original = cr.read_json(d / "state.json")
        with mock.patch.object(cr, "read_json", side_effect=[original, cr.UNREADABLE]), \
                mock.patch.object(cr, "pid_alive", return_value=False), \
                mock.patch.object(cr, "write_json") as write, redirect_stdout(io.StringIO()):
            cr.cmd_wait(mock.Mock(job="job1", interval=0))
        write.assert_not_called()
        self.assertEqual(cr.read_json(d / "state.json"), original)

    def test_wait_rejects_invalid_report_after_supervisor_dies(self):
        d = self.make_job(status="running", supervisor_pid=123)
        (d / "last.md").write_text("not a report", encoding="utf-8")
        with mock.patch.object(cr, "pid_alive", return_value=False):
            state, _ = self.wait(d)
        self.assertEqual((state["status"], state["error"]), ("blocked", "supervisor process died"))

    def test_wait_keeps_supervisor_started_during_stale_start_check(self):
        d = self.make_job(status="starting", created=cr.now() - STARTING_STALE_SECONDS)

        def start(pid):
            state = cr.read_json(d / "state.json")
            state.update(status="running", supervisor_pid=123)
            cr.write_json(d / "state.json", state)
            return False

        with mock.patch.object(cr, "pid_alive", side_effect=start):
            state, _ = self.wait(d)
        self.assertEqual(state["status"], "running")

    def test_cancel_does_not_write_if_killed_supervisor_is_still_alive(self):
        d = self.make_job(status="running", supervisor_pid=123)
        original = cr.read_json(d / "state.json")
        with mock.patch.object(cr, "now", side_effect=[0, 16]), mock.patch.object(cr, "kill_pid"), \
                mock.patch.object(cr, "pid_alive", return_value=True), redirect_stdout(io.StringIO()):
            cr.cmd_cancel(mock.Mock(job="job1"))
        self.assertEqual(cr.read_json(d / "state.json"), original)

    def test_wait_ends_a_job_whose_supervisor_died_as_blocked(self):
        d = self.make_job(status="running", supervisor_pid=None)
        state, out = self.wait(d)
        self.assertEqual(state["status"], "blocked")
        self.assertEqual(state["error"], "supervisor process died")
        self.assertNotIn("still running", out)

    def test_wait_ends_a_job_whose_supervisor_never_started_as_blocked(self):
        d = self.make_job(status="starting", created=cr.now() - STARTING_STALE_SECONDS)
        state, out = self.wait(d, interval=STARTING_STALE_SECONDS)
        self.assertEqual(state["status"], "blocked")
        self.assertIn("supervisor did not start", state["error"])

    def test_reply_accepts_every_status_a_job_can_end_with_a_session(self):
        for status in REPLY_STATUSES:
            with self.subTest(status=status):
                d = self.make_job(status=status, error="old")
                with mock.patch.object(cr, "spawn_supervisor") as spawn, \
                        mock.patch.object(cr, "cmd_wait"), mock.patch.object(cr, "take_prompt", return_value="go"), \
                        redirect_stdout(io.StringIO()):
                    cr.cmd_reply(mock.Mock(job="job1", prompt_file="unused"))
                spawn.assert_called_once()
                self.assertEqual(cr.read_json(d / "state.json")["status"], "starting")
                self.assertIn("go", (d / "reply.md").read_text(encoding="utf-8"))
                shutil.rmtree(d)

    def test_reply_refuses_a_job_that_has_not_finished(self):
        for status in NOT_REPLYABLE_STATUSES:
            with self.subTest(status=status):
                d = self.make_job(status=status)
                with mock.patch.object(cr, "spawn_supervisor") as spawn, self.assertRaises(SystemExit):
                    cr.cmd_reply(mock.Mock(job="job1", prompt_file="unused"))
                spawn.assert_not_called()
                shutil.rmtree(d)

    def test_progress_digest_never_shows_a_message_with_the_report(self):
        d = self.make_job(status="running", started=cr.now())
        st = cr.read_json(d / "state.json")
        events = [{"type": "item.completed", "item": {"type": "agent_message", "text": text}}
                  for text in ("reading the tests", REPORT_TEXT)]
        progress = cr.digest(d, st, events, False)
        self.assertIn("reading the tests", progress)
        self.assertNotIn("secret report body", progress)
        self.assertNotIn("STATUS", progress)

    def final_digest(self, d):
        return cr.digest(d, cr.read_json(d / "state.json"), [], True)

    def test_final_digest_shows_the_report_of_every_report_outcome(self):
        for status in ("done", "question", "blocked", "malformed"):
            with self.subTest(status=status):
                d = self.make_job(status=status, started=cr.now(), ended=cr.now(), report_error="no STATUS line")
                (d / "last.md").write_text(BLOCKED_REPORT, encoding="utf-8")
                out = self.final_digest(d)
                self.assertIn("Blocked by: access: the access key", out)
                self.assertNotIn("error:", out)
                self.assertEqual("report problem: no STATUS line" in out, status == "malformed")
                shutil.rmtree(d)

    def test_final_digest_keeps_the_error_when_the_launcher_failed(self):
        d = self.make_job(status="blocked", started=cr.now(), ended=cr.now(), error="supervisor process died")
        (d / "last.md").write_text(BLOCKED_REPORT, encoding="utf-8")
        out = self.final_digest(d)
        self.assertIn("error: supervisor process died", out)
        self.assertNotIn("the access key", out)

    def test_final_digest_shows_shared_limit_reset_and_reply(self):
        d = self.make_job(status="limit", started=cr.now(), ended=cr.now(), error="usage limit reached",
                          limit_reset="11:39 PM")
        event = {"type": "item.completed", "item": {"type": "agent_message", "text": "Try again later."}}
        out = cr.digest(d, cr.read_json(d / "state.json"), [event], True)
        self.assertIn("usage limit (shared by all Codex models): resets at 11:39 PM; after the reset continue this job with reply: job1", out)
        self.assertIn("last codex message: Try again later.", out)
        self.assertNotIn("error:", out)

    def test_reply_after_limit_resumes_on_the_original_line_and_slug(self):
        d = self.make_job(status="limit", line="sol", slug="gpt-6.1-sol", effort="high",
                          limit_reset="Nov 6th, 2026 8:00 AM")
        commands = []
        with mock.patch.object(cr, "spawn_supervisor"), mock.patch.object(cr, "cmd_wait"), \
                mock.patch.object(cr, "take_prompt", return_value="continue"), redirect_stdout(io.StringIO()):
            cr.cmd_reply(mock.Mock(job="job1", prompt_file="unused"))
        sup = cr.Supervisor(d)

        def resumed(text):
            command, _ = sup.command(text)
            commands.append((sup.state["line"], sup.state["slug"], command))
            (d / "last.md").write_text("STATUS: done", encoding="utf-8")
            sup.saw_turn_completed = True
            return None, 0

        with mock.patch.object(sup, "run_once", side_effect=resumed):
            sup.run()
        state = cr.read_json(d / "state.json")
        self.assertEqual(state["status"], "done")
        self.assertEqual((commands[0][0], commands[0][1]), ("sol", "gpt-6.1-sol"))
        self.assertIn("gpt-6.1-sol", commands[0][2])

    def test_a_report_outcome_clears_a_stale_error(self):
        for report, status in [("STATUS: blocked\nBlocked by: access: the access key", "blocked"), ("bad", "malformed")]:
            with self.subTest(status=status):
                d = self.make_job(status="starting", error="supervisor process died", malformed_follow_ups=1)
                state, _ = self.run_supervisor(d, [report])
                self.assertEqual(state["status"], status)
                self.assertIsNone(state["error"])
                shutil.rmtree(d)

    def run_supervisor(self, d, reports):
        sup = cr.Supervisor(d)
        prompts = []

        def run_once(text):
            prompts.append(text)
            (d / "last.md").write_text(reports[len(prompts) - 1], encoding="utf-8")
            sup.saw_turn_completed = True
            return None, 0

        with mock.patch.object(sup, "run_once", side_effect=run_once):
            sup.run()
        return cr.read_json(d / "state.json"), prompts

    def test_a_reply_turn_gets_its_own_malformed_follow_up(self):
        d = self.make_job(status="starting", malformed_follow_ups=1)
        (d / "reply.md").write_text("the answer", encoding="utf-8")
        state, prompts = self.run_supervisor(d, ["bad", "STATUS: done"])
        self.assertEqual(len(prompts), 2)
        self.assertEqual(state["status"], "done")

    def test_a_second_malformed_report_in_a_reply_turn_ends_the_job(self):
        d = self.make_job(status="starting", malformed_follow_ups=1)
        (d / "reply.md").write_text("the answer", encoding="utf-8")
        state, prompts = self.run_supervisor(d, ["bad", "bad again"])
        self.assertEqual(len(prompts), 2)
        self.assertEqual(state["status"], "malformed")

    def test_a_restart_without_a_reply_keeps_the_malformed_counter(self):
        d = self.make_job(status="starting", malformed_follow_ups=1)
        state, prompts = self.run_supervisor(d, ["bad"])
        self.assertEqual(len(prompts), 1)
        self.assertEqual(state["status"], "malformed")


@unittest.skipIf(os.name == "nt", "the job's process group is a POSIX mechanism; Windows uses taskkill /T")
class CancelStopsJobChildrenTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="codex-run-test-"))
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)

    def test_cancel_stops_the_children_of_the_job(self):
        job = self.dir / "job"
        job.mkdir()
        pids_file = job / "pids.txt"
        self.addCleanup(self.kill_leftovers, pids_file)
        cr.write_json(job / "state.json", {
            "cwd": str(job), "created": cr.now(), "status": "starting", "restarts": 0, "notes": [],
        })
        sup = cr.Supervisor(job)
        cmd = [sys.executable, "-I", "-c", JOB_SCRIPT, str(pids_file)]
        sup.command = lambda resume_text=None: (cmd, None)
        real_sleep = time.sleep

        def cancel_once_job_is_up(seconds):
            # Stands in for the supervisor's poll wait: it cancels as soon as the job has its pids.
            if pids_file.exists():
                (job / "cancel").touch()
            else:
                real_sleep(STARTUP_POLL_SECONDS)

        outcome = {}
        worker = threading.Thread(target=lambda: outcome.update(reason=sup.run_once()[0]), daemon=True)
        with mock.patch.object(cr.time, "sleep", cancel_once_job_is_up):
            worker.start()
            worker.join(JOB_STOP_TIMEOUT_SECONDS)
        self.assertFalse(worker.is_alive(), "the cancelled job did not stop")
        self.assertEqual(outcome.get("reason"), "cancelled")
        job_pid, child_pid = (int(text) for text in pids_file.read_text(encoding="utf-8").split())
        self.assertFalse(process_alive(job_pid), "the job's own process survived the cancel")
        self.assertFalse(process_alive(child_pid), "a child of the job survived the cancel")

    def kill_leftovers(self, pids_file):
        if not pids_file.exists():
            return
        for text in pids_file.read_text(encoding="utf-8").split():
            if process_alive(int(text)):
                os.kill(int(text), KILL_SIGNAL)


if __name__ == "__main__":
    unittest.main()
