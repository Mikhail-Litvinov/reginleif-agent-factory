"""Tests for the chief assistant hook. No test makes a model call: the reviewer (reflect.ask) is faked.

    python -I -m unittest discover -v -s features/chief-assistant/hooks/tests -p test_assist.py
"""
import contextlib
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "assist.py"
SPEC = importlib.util.spec_from_file_location("assist", SCRIPT)
ASSIST = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASSIST)
REFLECT = ASSIST.reflect

NOW = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
ENV_KEYS = ("CLAUDE_PROJECT_DIR", "REFLECT_CHILD", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED")
PLAN = "# Plan\n- [x] one: the reader\n- [ ] two: wire the hook\n- [ ] three: the docs\n"
# The tests are not allowed to hold Cyrillic: a Russian message is written with escapes ("keep going, please").
RUSSIAN_MESSAGE = "\u041f\u0440\u043e\u0434\u043e\u043b\u0436\u0430\u0439, \u043f\u043e\u0436\u0430\u043b\u0443\u0439\u0441\u0442\u0430"
IDLE = {"verdict": "idle", "next": "Wire the hook (plan step two).", "item": "Step two: wire the hook", "evidence": "plan step two is open"}
OK = {"verdict": "ok", "next": "", "item": "", "evidence": "the final message asks the user a question"}


class Transcript:
    """A transcript under construction: every entry gets the next second."""

    def __init__(self, parent=None, prefix="u"):
        self.entries = []
        self.count = 0
        self.ids = 0
        self.parent = parent  # the uuid the next main-chain record chains to
        self.prefix = prefix
        self.serial = 0

    def stamp(self):
        self.count += 1
        return f"2026-01-01T10:{self.count // 60:02d}:{self.count % 60:02d}.000Z"

    def link(self, entry):
        """A main-chain record gets its uuid and the previous record as parentUuid, as in the real transcript."""
        self.serial += 1
        entry["uuid"] = f"{self.prefix}{self.serial}"
        entry["parentUuid"] = self.parent
        self.parent = entry["uuid"]
        return entry

    def add(self, kind, content, **extra):
        entry = {"type": kind, "timestamp": self.stamp(), "message": {"role": kind, "content": content}, **extra}
        self.entries.append(self.link(entry))
        return entry

    def system(self, subtype):
        """A system record (the stop-hook summary, the turn duration): it chains to the record before it."""
        entry = {"type": "system", "subtype": subtype, "timestamp": self.stamp()}
        self.entries.append(self.link(entry))
        return entry

    def user(self, text):
        return self.add("user", text)

    def human(self, text):
        """A message the user typed, as Claude Code 2.1.330 records it: origin kind human."""
        return self.add("user", text, origin={"kind": "human"})

    def channel(self, text):
        """A message the user sent from Telegram: origin kind channel."""
        return self.add("user", text, origin={"kind": "channel", "server": "plugin:telegram-hub:telegram-hub"})

    def assistant(self, text):
        return self.add("assistant", [{"type": "text", "text": text}])

    def call(self, name, args, stamp=None):
        self.ids += 1
        ident = f"toolu_{self.ids}"
        entry = self.add("assistant", [{"type": "tool_use", "id": ident, "name": name, "input": args}])
        if stamp:
            entry["timestamp"] = stamp
        return ident

    def result(self, ident, text, error=False, **extra):
        """A tool result; `extra` holds the record's own fields, such as toolUseResult."""
        block = {"type": "tool_result", "tool_use_id": ident, "content": text}
        if error:
            block["is_error"] = True
        self.add("user", [block], **extra)

    def read_plan(self, path, name="Read"):
        self.result(self.call(name, {"file_path": str(path)}), "ok")

    def background(self, task_id, kind="Bash", stamp=None):
        """A background launch and its immediate answer, as the real transcript holds them: the task id sits in the
        record's toolUseResult (Bash/PowerShell: backgroundTaskId; Monitor: taskId; async Agent: isAsync + agentId)."""
        if kind == "Agent":
            ident = self.call(kind, {"run_in_background": True, "description": "reviewer", "prompt": "review"}, stamp)
            self.result(ident, f"Async agent launched successfully.\nagentId: {task_id} (internal ID)\nThe agent is working in the background.",
                        toolUseResult={"isAsync": True, "status": "async_launched", "agentId": task_id})
        elif kind == "Monitor":
            ident = self.call(kind, {"description": "watch the log", "command": "tail -f log", "persistent": True}, stamp)
            self.result(ident, f"Monitor started (task {task_id}, persistent). You will be notified on each event.",
                        toolUseResult={"taskId": task_id, "timeoutMs": 300000, "persistent": True})
        else:
            ident = self.call(kind, {"run_in_background": True, "command": "bun test"}, stamp)
            self.result(ident, f"Command running in background with ID: {task_id}. Output is being written to: x.output. You will be notified when it completes.",
                        toolUseResult={"stdout": "", "stderr": "", "backgroundTaskId": task_id})
        return ident

    def moved(self, task_id):
        """A foreground command that outlived its timeout and was moved to the background: no run_in_background in
        the call, the task id only in toolUseResult."""
        ident = self.call("Bash", {"command": "bun test", "timeout": 1000})
        self.result(ident, "Command timed out after 1s and was moved to the background.", toolUseResult={"stdout": "", "stderr": "", "backgroundTaskId": task_id})
        return ident

    def stop(self, task_id):
        """The session stopped a task itself: a TaskStop call; the task never sends a terminal notification."""
        self.result(self.call("TaskStop", {"task_id": task_id}), f"Successfully stopped task: {task_id}")

    def failed_stop(self, task_id, text="<tool_use_error>Could not stop the task</tool_use_error>"):
        """A TaskStop call that failed: its tool_result is an error, so the task may still run."""
        self.result(self.call("TaskStop", {"task_id": task_id}), text, error=True)

    def fast_launch(self):
        """A background launch whose command ended before the answer: the result names no task."""
        ident = self.call("Bash", {"run_in_background": True, "command": "true"})
        self.result(ident, "Done.", toolUseResult={"stdout": "", "stderr": ""})
        return ident

    def notify(self, task_id, tool_use_id="toolu_other"):
        text = f"<task-notification>\n<task-id>{task_id}</task-id>\n<tool-use-id>{tool_use_id}</tool-use-id>\n<status>completed</status>\n</task-notification>"
        self.add("user", text, origin={"kind": "task-notification"})
        # the queue entry that announces the same notification
        self.entries.append({"type": "queue-operation", "operation": "enqueue", "timestamp": self.stamp(), "content": text})

    def attach_notification(self, task_id, status="completed"):
        """The same notification as an attachment record (commandMode task-notification, XML in prompt). An empty
        status is a Monitor event notification, which is not terminal."""
        text = f"<task-notification>\n<task-id>{task_id}</task-id>\n" + (f"<status>{status}</status>\n" if status else "") + "</task-notification>"
        self.entries.append(self.link({"type": "attachment", "timestamp": self.stamp(),
                                       "attachment": {"type": "queued_command", "commandMode": "task-notification", "prompt": text}}))

    def attach_wake(self, marker):
        """A Stop-hook wake as Claude Code 2.1.330 records it: a queued_command attachment whose prompt wraps the hook's
        stderr in a task-notification (the marker sits inside the wrapper, not at the start)."""
        text = ("<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\n"
                f"Stop hook blocking error from command \"Stop\": {marker} You stopped with work left\n</system-reminder>")
        self.entries.append(self.link({"type": "attachment", "timestamp": self.stamp(),
                                       "attachment": {"type": "queued_command", "commandMode": "task-notification", "prompt": text,
                                                      "origin": {"kind": "task-notification", "producer": "session-task"}}}))

    def write(self, path):
        path.write_text("".join(json.dumps(e) + "\n" for e in self.entries), encoding="utf-8")


class AssistCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.dir = Path(directory.name).resolve()  # plans are reported by their resolved path
        self.project = self.dir / "project"
        self.plan = self.project / "docs" / "superpowers" / "plans" / "feature.md"
        self.plan.parent.mkdir(parents=True)
        self.plan.write_text(PLAN, encoding="utf-8")
        self.home = self.dir / "home"
        self.home.mkdir()
        (self.home / "CLAUDE.md").write_text("RULE-MARK: keep working until the plan is done\n", encoding="utf-8")
        self.state = self.dir / "state"
        for target, name, value in (
            (ASSIST, "STATE_DIR", self.state), (ASSIST, "LOG_FILE", self.state / "log.jsonl"),
            (REFLECT, "HOME_CLAUDE", self.home), (ASSIST, "now", lambda: NOW),
        ):
            patcher = mock.patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        for key in ENV_KEYS:
            os.environ.pop(key, None)
        self.calls = []
        self.answer = dict(IDLE)
        self.during_ask = None  # a callable run while the model "thinks": it appends to the transcript
        patcher = mock.patch.object(REFLECT, "ask", side_effect=self.fake_ask)
        patcher.start()
        self.addCleanup(patcher.stop)

    def fake_ask(self, model, verdicts, text, cwd, dirs, started, **kwargs):
        self.calls.append({"model": model, "verdicts": verdicts, "text": text, "cwd": cwd, "dirs": dirs, "kwargs": kwargs})
        if self.during_ask:
            self.during_ask()
        return (dict(self.answer) if self.answer else None), 0.01, ("" if self.answer else "network down")

    def session(self, prefix="u"):
        """A session that read its plan, worked, and stopped; the caller adds to it before the final message."""
        log = Transcript(prefix=prefix)
        log.human("Implement the plan")
        log.read_plan(self.plan)
        log.result(log.call("Edit", {"file_path": "src/a.py"}), "ok")
        return log

    def assess(self, log, final="Step one is done.", background_tasks=None):
        """Runs the check on the transcript. `background_tasks` is the Stop payload's own list; None leaves it out."""
        log.assistant(final)
        transcript = self.dir / "session.jsonl"
        log.write(transcript)
        payload = {"transcript_path": str(transcript), "session_id": "s1", "cwd": str(self.project), "last_assistant_message": final}
        if background_tasks is not None:
            payload["background_tasks"] = background_tasks
        return ASSIST.assess(payload)

    def append(self, *entries):
        """Appends raw records to the session file, as the session does while the hook runs."""
        with open(self.dir / "session.jsonl", "a", encoding="utf-8") as handle:
            for entry in entries:
                handle.write(json.dumps(entry) + "\n")

    def after_stop(self, build):
        """The records `build(log)` adds, as plain entries to append: they chain to the last record the file holds now."""
        parent = None
        for line in (self.dir / "session.jsonl").read_text(encoding="utf-8").splitlines():
            record = json.loads(line)
            if record.get("uuid"):
                parent = record["uuid"]
        log = Transcript(parent=parent, prefix="late")
        log.count = 500
        build(log)
        return log.entries

    def payload_for(self, log, final, name="session.jsonl", **extra):
        """Writes the transcript as it is (the final message is not added to it) and returns the Stop payload."""
        transcript = self.dir / name
        log.write(transcript)
        return {"transcript_path": str(transcript), "session_id": "s1", "cwd": str(self.project), "last_assistant_message": final, **extra}

    def seed(self, count, point=10 ** 9):
        """The wake counter of session s1 as a past wake left it; `point` is the transcript size at that wake."""
        self.state.mkdir(parents=True, exist_ok=True)
        ASSIST.save_count("s1", count, point)

    def logged(self):
        return [json.loads(line) for line in (self.state / "log.jsonl").read_text(encoding="utf-8").splitlines()]


class LegitStopTests(AssistCase):
    def test_background_bash_still_running_is_a_legit_stop_without_a_model_call(self):
        log = self.session()
        log.background("bz9k")
        self.assertIsNone(self.assess(log))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.logged()[-1]["decision"], "background")

    def test_background_agent_still_running_is_a_legit_stop(self):
        log = self.session()
        log.background("a1b2c3", kind="Agent")
        self.assertIsNone(self.assess(log))
        self.assertEqual(self.calls, [])

    def test_finished_background_task_no_longer_excuses_the_stop(self):
        log = self.session()
        log.background("bz9k")
        log.notify("bz9k")
        self.assertIsNotNone(self.assess(log))
        self.assertEqual(len(self.calls), 1)

    def test_one_finished_and_one_running_task_is_still_a_legit_stop(self):
        log = self.session()
        log.background("first")
        log.background("second", kind="Agent")
        log.notify("first")
        self.assertIsNone(self.assess(log))

    def test_notification_of_another_task_does_not_finish_this_one(self):
        log = self.session()
        log.background("bz9k")
        log.notify("unrelated")
        self.assertIsNone(self.assess(log))

    def test_assistant_quoting_a_notification_does_not_finish_the_task(self):
        log = self.session()
        log.background("bz9k")
        log.assistant("The system said <task-notification><task-id>bz9k</task-id></task-notification> earlier.")
        self.assertIsNone(self.assess(log))

    def test_a_launch_that_failed_is_not_running(self):
        log = self.session()
        ident = log.call("Bash", {"run_in_background": True, "command": "nope"})
        log.result(ident, "permission denied", error=True)
        self.assertIsNotNone(self.assess(log))

    def test_a_foreground_call_is_not_a_background_task(self):
        log = self.session()
        log.result(log.call("Bash", {"run_in_background": False, "command": "ls"}), "a b c")
        self.assertIsNotNone(self.assess(log))

    def test_no_plan_touched_is_a_legit_stop(self):
        log = Transcript()
        log.human("What is in the repository?")
        log.result(log.call("Bash", {"command": "ls"}), "a b c")
        self.assertIsNone(self.assess(log))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.logged()[-1]["decision"], "no-plan")

    def test_a_plan_that_was_deleted_is_no_active_plan(self):
        log = self.session()
        self.plan.unlink()
        self.assertIsNone(self.assess(log))
        self.assertEqual(self.calls, [])

    def test_a_spec_is_not_a_plan(self):
        spec = self.project / "docs" / "superpowers" / "specs" / "feature-design.md"
        spec.parent.mkdir(parents=True)
        spec.write_text("design", encoding="utf-8")
        log = Transcript()
        log.human("Read the spec")
        log.read_plan(spec)
        self.assertIsNone(self.assess(log))
        self.assertEqual(self.calls, [])

    def test_a_pending_poll_is_a_legit_stop(self):
        log = self.session()
        log.call("AskUserQuestion", {"questions": []})
        self.assertIsNone(self.assess(log, final="Which one?"))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.logged()[-1]["decision"], "poll")

    def test_an_answered_poll_goes_to_the_model(self):
        log = self.session()
        log.result(log.call("AskUserQuestion", {"questions": []}), "User answered: option A")
        self.assess(log)
        self.assertEqual(len(self.calls), 1)

    def test_the_model_saying_ok_means_no_wake(self):
        self.answer = dict(OK)
        self.assertIsNone(self.assess(self.session(), final="Which option do you want?"))
        self.assertEqual(self.logged()[-1]["decision"], "ok")

    def test_a_failed_model_call_means_no_wake_and_is_logged(self):
        self.answer = None
        self.assertIsNone(self.assess(self.session()))
        self.assertEqual(self.logged()[-1]["decision"], "failed")
        self.assertIn("network down", self.logged()[-1]["error"])

    def test_child_process_and_unattended_runs_are_skipped(self):
        for key, value in (("REFLECT_CHILD", "1"), ("CLAUDE_CODE_ENTRYPOINT", "sdk-cli"), ("CLAUDE_CODE_SESSION_ATTENDED", "0")):
            with self.subTest(key=key), mock.patch.dict(os.environ, {key: value}):
                self.assertTrue(ASSIST.skipped({}))
        self.assertFalse(ASSIST.skipped({}))

    def test_a_stop_hook_active_turn_is_still_checked(self):
        # Our own loop guard bounds the wakes, so the harness flag must not hide a wake-started turn.
        self.assertFalse(ASSIST.skipped({"stop_hook_active": True}))


class BackgroundLivenessTests(AssistCase):
    """Whether a background task still runs is answered by the shared subagent-tasks module, never by a heuristic of
    this hook: no age cut-off, no run_in_background flag test. The record shapes are the real ones."""

    def test_a_running_monitor_is_a_legit_stop(self):
        log = self.session()
        log.background("mon1", kind="Monitor")
        self.assertIsNone(self.assess(log))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.logged()[-1]["decision"], "background")

    def test_a_monitor_event_notification_is_not_terminal_but_a_terminal_one_is(self):
        log = self.session()
        log.background("mon1", kind="Monitor")
        log.attach_notification("mon1", status="")
        self.assertIsNone(self.assess(log))
        log = self.session()
        log.background("mon1", kind="Monitor")
        log.attach_notification("mon1", status="killed")
        self.assertIsNotNone(self.assess(log))

    def test_a_foreground_command_moved_to_the_background_is_a_running_task(self):
        log = self.session()
        log.moved("mv1")
        self.assertIsNone(self.assess(log))
        self.assertEqual(self.calls, [])

    def test_a_moved_command_that_finished_is_not_running(self):
        log = self.session()
        log.moved("mv1")
        log.notify("mv1")
        self.assertIsNotNone(self.assess(log))

    def test_an_async_agent_is_known_by_its_tool_use_result_alone(self):
        log = self.session()
        ident = log.call("Agent", {"run_in_background": True, "description": "reviewer", "prompt": "review"})
        log.result(ident, "launched", toolUseResult={"isAsync": True, "status": "async_launched", "agentId": "ag1"})
        self.assertIsNone(self.assess(log))
        self.assertEqual(self.calls, [])

    def test_a_task_the_session_stopped_itself_is_not_running(self):
        log = self.session()
        log.background("bz9k")
        log.stop("bz9k")
        self.assertIsNotNone(self.assess(log))

    def test_a_stop_that_failed_leaves_the_task_running(self):
        log = self.session()
        log.background("bz9k")
        log.failed_stop("bz9k")
        self.assertIsNone(self.assess(log))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.logged()[-1]["decision"], "background")

    def test_a_stop_that_says_the_task_is_not_running_counts_as_stopped(self):
        # The real wording Claude Code returns for a task that already finished.
        log = self.session()
        log.background("bz9k")
        log.failed_stop("bz9k", "<tool_use_error>Task bz9k is not running (status: completed)</tool_use_error>")
        self.assertIsNotNone(self.assess(log))

    def test_an_error_that_only_mentions_not_running_leaves_the_task_running(self):
        for text in ("Error: Task is not running",
                     "<tool_use_error>Task other is not running (status: completed)</tool_use_error>",
                     "<tool_use_error>Could not stop it: the worker is not running a handler</tool_use_error>"):
            with self.subTest(text=text):
                log = self.session()
                log.background("bz9k")
                log.failed_stop("bz9k", text)
                self.assertIsNone(self.assess(log))
                self.assertEqual(self.logged()[-1]["decision"], "background")

    def test_a_stop_call_without_a_result_yet_leaves_the_task_running(self):
        log = self.session()
        log.background("bz9k")
        log.call("TaskStop", {"task_id": "bz9k"})
        self.assertIsNone(self.assess(log))
        self.assertEqual(self.calls, [])

    def test_a_launch_that_named_no_task_is_not_running(self):
        log = self.session()
        log.fast_launch()
        self.assertIsNotNone(self.assess(log))

    def test_a_terminal_notification_as_an_attachment_finishes_the_task(self):
        log = self.session()
        log.background("bz9k")
        log.attach_notification("bz9k")
        self.assertIsNotNone(self.assess(log))

    def test_a_task_older_than_a_day_that_still_runs_is_a_legit_stop(self):
        # There is no age cut-off: a long build or a persistent monitor may run for days.
        log = self.session()
        log.background("old", stamp="2025-12-30T09:00:00.000Z")
        self.assertIsNone(self.assess(log))
        self.assertEqual(self.calls, [])

    def test_a_launch_in_a_subagent_is_not_a_task_of_the_session(self):
        log = self.session()
        log.background("sub1")
        for entry in log.entries[-2:]:
            entry["isSidechain"] = True
        self.assertIsNotNone(self.assess(log))

    def test_the_stop_payload_list_is_the_truth_when_it_names_a_running_task(self):
        log = self.session()
        log.background("bz9k")
        log.notify("bz9k")  # the transcript says finished, the registry says running
        listed = [{"id": "bz9k", "type": "shell", "status": "running", "description": "tests"}]
        self.assertIsNone(self.assess(log, background_tasks=listed))
        self.assertEqual(self.calls, [])

    def test_an_empty_stop_payload_list_means_nothing_runs_even_if_the_transcript_disagrees(self):
        log = self.session()
        log.background("bz9k")  # no notification in the transcript
        self.assertIsNotNone(self.assess(log, background_tasks=[]))

    def test_a_listed_task_that_is_not_running_does_not_count(self):
        log = self.session()
        log.background("bz9k")
        listed = [{"id": "bz9k", "type": "shell", "status": "completed", "description": "tests"}]
        self.assertIsNotNone(self.assess(log, background_tasks=listed))

    def test_a_listed_running_task_the_session_never_launched_counts(self):
        # The payload list is authoritative: a task started by a hook, a command or another session still keeps the
        # session busy, so the stop is legitimate and no model call is made.
        log = self.session()
        listed = [{"id": "from-elsewhere", "type": "shell", "status": "running", "description": "tests"}]
        self.assertIsNone(self.assess(log, background_tasks=listed))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.logged()[-1]["decision"], "background")

    def test_every_running_entry_of_the_payload_list_counts_among_several(self):
        log = self.session()
        listed = [
            {"id": "a", "type": "shell", "status": "completed"},
            {"id": "b", "type": "shell", "status": "failed"},
            {"id": "c", "type": "agent", "status": "running"},
            {"id": "d", "type": "shell", "status": "running"},
        ]
        self.assertIsNone(self.assess(log, background_tasks=listed))
        self.assertEqual(self.calls, [])
        reason = self.logged()[-1]["reason"]
        self.assertIn("2 background task(s)", reason)
        self.assertTrue("c" in reason and "d" in reason and "a," not in reason and "b," not in reason)

    def test_without_the_payload_list_the_transcript_decides(self):
        log = self.session()
        log.background("bz9k")
        self.assertIsNone(self.assess(log))

    def test_the_log_names_the_running_tasks(self):
        log = self.session()
        log.background("bz9k")
        log.background("mon1", kind="Monitor")
        self.assess(log)
        entry = self.logged()[-1]
        self.assertIn("2", entry["reason"])
        self.assertIn("bz9k", entry["reason"])
        self.assertIn("mon1", entry["reason"])


class PlanDetectionTests(AssistCase):
    def plans_of(self, log):
        transcript = self.dir / "plans.jsonl"
        log.write(transcript)
        return ASSIST.scan(transcript, str(self.project))["plans"]

    def test_read_edit_and_write_of_a_plan_all_count(self):
        for name in ("Read", "Edit", "Write", "MultiEdit"):
            with self.subTest(tool=name):
                log = Transcript()
                log.read_plan(self.plan, name)
                self.assertEqual(self.plans_of(log), [self.plan])

    def test_a_relative_plan_path_is_resolved_against_the_project(self):
        log = Transcript()
        log.result(log.call("Read", {"file_path": "docs/superpowers/plans/feature.md"}), "ok")
        self.assertEqual(self.plans_of(log), [self.plan])

    def test_backslash_windows_paths_count(self):
        log = Transcript()
        log.result(log.call("Read", {"file_path": str(self.plan).replace("/", "\\")}), "ok")
        self.assertEqual(self.plans_of(log), [self.plan])

    def others(self, count):
        paths = []
        for i in range(count):
            path = self.plan.with_name(f"other{i}.md")
            path.write_text(f"# Other {i}\n- [ ] item {i}\n", encoding="utf-8")
            paths.append(path)
        return paths

    def test_every_plan_the_session_read_or_edited_is_kept_edited_ones_first_then_the_latest_read(self):
        first, second, third, fourth = self.others(4)
        log = Transcript()
        log.read_plan(first)
        log.read_plan(second, "Edit")
        log.read_plan(third)
        log.read_plan(fourth, "Write")
        log.read_plan(first)
        # edits: fourth (latest), second; then reads: first (latest), third
        self.assertEqual(self.plans_of(log), [fourth, second, first, third])

    def test_the_active_plan_edited_early_survives_three_plans_read_later(self):
        log = Transcript()
        log.read_plan(self.plan, "Edit")
        for path in self.others(3):
            log.read_plan(path)
        self.assertEqual(self.plans_of(log)[0], self.plan)
        self.assess(log)
        self.assertIn("two: wire the hook", self.calls[0]["text"])

    def fillers(self, count):
        """Plans that each fill the per-plan limit, so a few of them spend the whole budget."""
        paths = []
        for i in range(count):
            path = self.plan.with_name(f"filler{i}.md")
            path.write_text(f"# Filler {i}\n- [ ] FILLER-{i}\n" + "x" * ASSIST.PLAN_LIMIT, encoding="utf-8")
            paths.append(path)
        return paths

    def test_the_active_edited_plan_stays_in_the_model_input_after_later_plans_that_fill_the_budget(self):
        fillers = self.fillers(6)
        log = Transcript()
        log.human("Implement the plan")
        log.read_plan(self.plan, "Edit")
        for path in fillers:
            log.read_plan(path)
        self.assess(log)
        text = self.calls[0]["text"]
        self.assertIn("two: wire the hook", text)
        line = [row for row in text.splitlines() if row.startswith("PLANS NOT SHOWN")]
        self.assertEqual(len(line), 1)
        self.assertNotIn(str(self.plan), line[0])
        # the budget holds the active plan and the three latest fillers; the three earliest are named by their full path
        for path in fillers[3:]:
            self.assertIn(f"FILLER-{path.stem[-1]}", text)
            self.assertNotIn(str(path), line[0])
        for path in fillers[:3]:
            self.assertIn(str(path), line[0])

    def test_a_plan_named_in_a_shell_command_counts_as_read(self):
        commands = (("Bash", f"cat {self.plan}"), ("PowerShell", f"Get-Content '{self.plan}'"),
                    ("Bash", "sed -n 1,40p docs/superpowers/plans/feature.md"), ("Bash", f"head -5 {self.plan.as_posix()} | wc -l"))
        for name, command in commands:
            with self.subTest(command=command):
                log = Transcript()
                log.result(log.call(name, {"command": command}), "ok")
                self.assertEqual(self.plans_of(log), [self.plan])

    def test_every_spelling_of_a_plan_path_is_the_same_plan(self):
        spellings = (str(self.plan), self.plan.as_posix(), str(self.plan).replace("/", "\\"), "docs/superpowers/plans/feature.md",
                     "./docs/superpowers/plans/feature.md", "docs\\superpowers\\plans\\feature.md")
        for text in spellings:
            with self.subTest(spelling=text):
                log = Transcript()
                log.result(log.call("Bash", {"command": f"cat {text}"}), "ok")
                self.assertEqual(self.plans_of(log), [self.plan])
        log = Transcript()
        log.result(log.call("Bash", {"command": "cat docs/superpowers/plans/feature.md"}), "ok")
        log.read_plan(self.plan)
        log.result(log.call("Bash", {"command": f"cat {self.plan.as_posix()}"}), "ok")
        self.assertEqual(self.plans_of(log), [self.plan])

    def test_a_plan_changed_by_a_shell_command_counts_as_edited(self):
        first, second, third = self.others(3)
        log = Transcript()
        log.read_plan(first)
        log.result(log.call("Bash", {"command": f"python patch_plan.py && sed -i 's/[ ]/[x]/' {second}"}), "ok")
        log.result(log.call("PowerShell", {"command": f"Set-Content -Path {third} -Value done"}), "ok")
        log.read_plan(first)
        self.assertEqual(self.plans_of(log), [third, second, first])

    def shell_verdict(self, name, command_of):
        """'edited' when a shell command naming the plan ranks it before a plain read of another plan that came later."""
        other = self.others(1)[0]
        log = Transcript()
        log.result(log.call(name, {"command": command_of(str(self.plan))}), "ok")
        log.read_plan(other)
        order = self.plans_of(log)
        self.assertCountEqual(order, [self.plan, other])
        return "edited" if order[0] == self.plan else "read"

    def test_a_shell_command_naming_a_plan_is_an_edit_unless_it_is_a_recognised_pure_read(self):
        edits = (("Bash", lambda p: f"cp draft.md {p}"), ("Bash", lambda p: f"mv draft.md {p}"),
                 ("Bash", lambda p: f"echo done > {p}"), ("Bash", lambda p: f"echo done >> {p}"),
                 ("Bash", lambda p: f"python fix_plan.py {p}"), ("Bash", lambda p: f"python -I tools/mark.py --plan {p} --item 2"),
                 ("Bash", lambda p: f"node tick.js {p}"), ("Bash", lambda p: f"git checkout HEAD -- {p}"),
                 ("Bash", lambda p: f"sed -i 's/a/b/' {p}"), ("Bash", lambda p: f"sed -n 1,3p x.txt | tee {p}"),
                 ("PowerShell", lambda p: f"Copy-Item draft.md '{p}'"), ("PowerShell", lambda p: f"Move-Item draft.md '{p}'"),
                 ("PowerShell", lambda p: f"Set-Content '{p}' -Value done"), ("Bash", lambda p: f"cat {p} && python tick.py {p}"))
        for name, command_of in edits:
            with self.subTest(command=command_of("<plan>")):
                self.assertEqual(self.shell_verdict(name, command_of), "edited")

    def test_a_recognised_pure_read_of_a_plan_stays_a_read(self):
        reads = (("Bash", lambda p: f"cat {p}"), ("PowerShell", lambda p: f"type '{p}'"), ("PowerShell", lambda p: f"Get-Content '{p}' | Select-Object -First 5"),
                 ("Bash", lambda p: f"head -5 {p}"), ("Bash", lambda p: f"tail -n 5 {p}"), ("Bash", lambda p: f"less {p}"),
                 ("Bash", lambda p: f"more {p}"), ("PowerShell", lambda p: f"Select-String -Path '{p}' -Pattern todo"),
                 ("Bash", lambda p: f"grep -n 'a;b' {p}"), ("Bash", lambda p: f"rg 'step' {p}"), ("Bash", lambda p: f"wc -l {p}"),
                 ("Bash", lambda p: f"git show HEAD -- {p}"), ("Bash", lambda p: f"git diff -- {p}"), ("Bash", lambda p: f"git log -p {p}"),
                 ("Bash", lambda p: f"sed -n 1,5p {p}"), ("Bash", lambda p: f"cat {p} > out.txt"), ("Bash", lambda p: f"cat {p} | python summarize.py"))
        for name, command_of in reads:
            with self.subTest(command=command_of("<plan>")):
                self.assertEqual(self.shell_verdict(name, command_of), "read")

    def test_a_plan_called_like_a_write_word_is_not_a_write(self):
        path = self.plan.with_name("write-up.md")
        path.write_text("# Write up\n- [ ] one\n", encoding="utf-8")
        other = self.others(1)[0]
        log = Transcript()
        log.result(log.call("Bash", {"command": f"cat {path}"}), "ok")
        log.read_plan(other)
        self.assertEqual(self.plans_of(log), [other, path])

    def test_a_plan_named_deep_in_another_tools_input_counts(self):
        log = Transcript()
        log.result(log.call("Agent", {"description": "review", "prompt": f"Review the plan {self.plan} and report", "extra": {"list": [f"see {self.plan}"]}}), "ok")
        self.assertEqual(self.plans_of(log), [self.plan])

    def test_a_plan_path_with_spaces_in_file_path_counts(self):
        spaced = self.dir / "my project" / "docs" / "superpowers" / "plans" / "the plan.md"
        spaced.parent.mkdir(parents=True)
        spaced.write_text("# Plan\n- [ ] one\n", encoding="utf-8")
        log = Transcript()
        log.read_plan(spaced, "Edit")
        self.assertEqual(self.plans_of(log), [spaced])

    def nested(self, relative):
        path = self.plan.parent / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("# Nested\n- [ ] step\n", encoding="utf-8")
        return path

    def test_a_plan_in_a_subfolder_named_in_a_shell_command_counts(self):
        nested = self.nested("sub/work.md")
        commands = ("cat docs/superpowers/plans/sub/work.md", f"cat {nested}", f"head -3 {nested.as_posix()}",
                    "cat docs\\superpowers\\plans\\sub\\work.md")
        for command in commands:
            with self.subTest(command=command):
                log = Transcript()
                log.result(log.call("Bash", {"command": command}), "ok")
                self.assertEqual(self.plans_of(log), [nested])

    def test_a_quoted_plan_name_with_spaces_in_a_shell_command_counts(self):
        spaced = self.nested("my plan.md")
        commands = ('cat "docs/superpowers/plans/my plan.md"', "cat 'docs/superpowers/plans/my plan.md'",
                    f'Get-Content "{spaced}"', f'cat "{spaced.as_posix()}" | head')
        for command in commands:
            with self.subTest(command=command):
                log = Transcript()
                log.result(log.call("Bash", {"command": command}), "ok")
                self.assertEqual(self.plans_of(log), [spaced])

    def test_a_nested_or_spaced_plan_written_by_a_shell_command_counts_as_edited(self):
        nested = self.nested("sub/work.md")
        spaced = self.nested("my plan.md")
        log = Transcript()
        log.read_plan(self.plan)
        log.result(log.call("Bash", {"command": "sed -i 's/[ ]/[x]/' docs/superpowers/plans/sub/work.md"}), "ok")
        log.result(log.call("Bash", {"command": 'echo done >> "docs/superpowers/plans/my plan.md"'}), "ok")
        self.assertEqual(self.plans_of(log), [spaced, nested, self.plan])

    def test_files_that_only_look_like_plans_do_not_count(self):
        for text in ("cat docs/superpowers/plans/feature.md.bak", "cat docs/superpowers/plans/", "cat docs/superpowers/specs/feature.md",
                     "cat docs/superpowers/plans/feature.mdx"):
            with self.subTest(command=text):
                log = Transcript()
                log.result(log.call("Bash", {"command": text}), "ok")
                self.assertEqual(self.plans_of(log), [])

    def test_the_total_plan_size_is_bounded_and_the_omitted_plans_are_named(self):
        big = []
        for i in range(6):
            path = self.plan.with_name(f"big{i}.md")
            path.write_text(f"# Big {i}\n- [ ] BIG-STEP-{i}\n" + "x" * (ASSIST.PLAN_LIMIT * 2), encoding="utf-8")
            big.append(path)
        log = Transcript()
        for path in big:
            log.read_plan(path, "Edit")
        self.assess(log)
        text = self.calls[0]["text"]
        shown = ASSIST.PLAN_BUDGET // ASSIST.PLAN_LIMIT
        self.assertLessEqual(text.count("x"), ASSIST.PLAN_BUDGET)
        # the last edited plans come first and fill the budget; the rest are named, not dropped silently
        for i in range(6 - shown, 6):
            self.assertIn(f"BIG-STEP-{i}", text)
        omitted = [str(big[i]) for i in range(6 - shown)]
        line = [row for row in text.splitlines() if row.startswith("PLANS NOT SHOWN")]
        self.assertEqual(len(line), 1)
        for name in omitted:
            self.assertIn(name, line[0])
        self.assertNotIn(str(big[5]), line[0])

    def test_the_budget_is_derived_from_the_per_plan_limit(self):
        self.assertEqual(ASSIST.PLAN_BUDGET, 4 * ASSIST.PLAN_LIMIT)

    def test_only_a_plan_the_session_touched_is_active(self):
        self.plan.with_name("other.md").write_text("another session's plan", encoding="utf-8")
        log = Transcript()
        log.read_plan(self.plan)
        self.assertEqual(self.plans_of(log), [self.plan])

    def test_the_plan_text_reaches_the_model_bounded(self):
        self.plan.write_text("# Plan\n- [ ] two: wire the hook\n" + "x" * (ASSIST.PLAN_LIMIT * 3), encoding="utf-8")
        self.assess(self.session())
        text = self.calls[0]["text"]
        self.assertIn("two: wire the hook", text)
        self.assertLess(text.count("x"), ASSIST.PLAN_LIMIT * 2)
        self.assertIn(str(self.plan.parent), [str(d) for d in self.calls[0]["dirs"]])

    def test_a_plan_is_read_only_as_far_as_the_limit_and_an_omitted_plan_is_not_opened(self):
        big = []
        for i in range(6):
            path = self.plan.with_name(f"huge{i}.md")
            path.write_text(f"# Huge {i}\n- [ ] HUGE-STEP-{i}\n" + "x" * (ASSIST.PLAN_LIMIT * 50), encoding="utf-8")
            big.append(path)
        log = Transcript()
        for path in big:
            log.read_plan(path, "Edit")
        opened, asked = [], []
        real_open = open

        class Recorder:
            def __init__(self, handle):
                self.handle = handle

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                self.handle.close()

            def read(self, count=-1):
                asked.append(count)
                return self.handle.read(count)

        def recording_open(path, *args, **kwargs):
            opened.append(Path(path))
            return Recorder(real_open(path, *args, **kwargs))

        def guarded(real):
            def read(path, *args, **kwargs):
                if path.parent == self.plan.parent:
                    raise AssertionError("a plan must not be loaded whole")
                return real(path, *args, **kwargs)
            return read

        with mock.patch.object(ASSIST, "open", recording_open, create=True), \
                mock.patch.object(Path, "read_text", guarded(Path.read_text)), \
                mock.patch.object(Path, "read_bytes", guarded(Path.read_bytes)):
            self.assess(log)
        shown = ASSIST.PLAN_BUDGET // ASSIST.PLAN_LIMIT
        self.assertEqual(opened, big[-1:-shown - 1:-1])
        self.assertTrue(asked)
        self.assertTrue(all(0 < count <= ASSIST.PLAN_LIMIT + 1 for count in asked), asked)
        text = self.calls[0]["text"]
        self.assertIn("plan cut at", text)
        self.assertIn(str(big[0]), [row for row in text.splitlines() if row.startswith("PLANS NOT SHOWN")][0])


class ShellDirectoryTests(AssistCase):
    """A relative plan path in a shell command is resolved where the command stands when it reads it: after `cd`,
    `Set-Location`, `pushd` in the same command, or inside `git -C`. The payload cwd is tried as well."""

    def plans_of(self, command, tool="Bash"):
        log = Transcript()
        log.result(log.call(tool, {"command": command}), "ok")
        transcript = self.dir / "plans.jsonl"
        log.write(transcript)
        return ASSIST.scan(transcript, str(self.project))["plans"]

    def plan_in(self, folder, name="sub.md"):
        path = self.project / folder / "docs" / "superpowers" / "plans" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("# Sub\n- [ ] item\n", encoding="utf-8")
        return path

    REL = "docs/superpowers/plans/sub.md"

    def test_a_directory_change_in_the_same_command_decides_where_the_relative_plan_is(self):
        sub = self.plan_in("sub")
        commands = (("Bash", f"cd sub && cat {self.REL}"), ("Bash", f"cd sub; cat {self.REL}"), ("Bash", f"cd 'sub' && cat {self.REL}"),
                    ("Bash", f"pushd sub && cat {self.REL}"), ("Bash", f"cd ./sub && ls && cat {self.REL}"),
                    ("Bash", f"cd -P sub && cat {self.REL}"), ("Bash", f"cd sub\ncat {self.REL}"),
                    ("PowerShell", f"Set-Location sub; Get-Content {self.REL}"), ("PowerShell", f"Set-Location -Path sub; Get-Content {self.REL}"),
                    ("PowerShell", f"sl sub; gc {self.REL}"), ("PowerShell", f"Push-Location sub; Get-Content '{self.REL}'"),
                    ("Bash", f"git -C sub diff -- {self.REL}"), ("Bash", f"git -C 'sub' show {self.REL}"))
        for tool, command in commands:
            with self.subTest(command=command):
                self.assertEqual(self.plans_of(command, tool), [sub])

    def test_the_directory_change_follows_backslashes_parent_steps_and_quoted_spaces(self):
        sub = self.plan_in("my dir")
        deeper = self.plan_in("a/b")
        for command, expected in ((f'cd "my dir" && cat {self.REL}', sub), (f"cd 'my dir'; cat {self.REL}", sub),
                                  (f"cd a\\b && cat {self.REL}", deeper), (f"cd a/b/.. && cd b && cat {self.REL}", deeper),
                                  (f"cd a && cd b && cat {self.REL}", deeper)):
            with self.subTest(command=command):
                self.assertEqual(self.plans_of(command), [expected])

    def test_an_absolute_directory_change_is_followed(self):
        sub = self.plan_in("sub")
        self.assertEqual(self.plans_of(f"cd {(self.project / 'sub').as_posix()} && cat {self.REL}"), [sub])

    def test_the_payload_cwd_is_tried_too(self):
        self.plan_in("sub")
        # sub holds no feature.md: the plan only the project has is found from the payload cwd
        self.assertEqual(self.plans_of("cd sub && cat docs/superpowers/plans/feature.md"), [self.plan])
        # a directory that cannot be known (home, the previous one, a variable) leaves the payload cwd
        for target in ("~", "-", "$HOME", "$OLDPWD", ""):
            with self.subTest(target=target):
                self.assertEqual(self.plans_of(f"cd {target} && cat docs/superpowers/plans/feature.md"), [self.plan])

    def test_a_plan_found_in_both_places_is_two_plans_and_one_found_twice_is_one(self):
        twin = self.plan_in("sub", "feature.md")
        found = self.plans_of("cd sub && cat docs/superpowers/plans/feature.md")
        self.assertCountEqual(found, [twin, self.plan])
        self.assertEqual(self.plans_of("cd . && cat docs/superpowers/plans/feature.md"), [self.plan])
        self.assertEqual(self.plans_of(f"cd sub && cat {self.plan.as_posix()}"), [self.plan])

    def test_git_dash_c_covers_only_its_own_command(self):
        self.plan_in("sub")
        self.assertEqual(self.plans_of(f"git -C sub status && cat {self.REL}"), [])

    def test_a_cd_inside_quotes_is_no_directory_change(self):
        self.plan_in("sub")
        self.assertEqual(self.plans_of(f'echo "cd sub && x" && cat {self.REL}'), [])

    def test_an_edit_after_a_directory_change_is_still_an_edit(self):
        sub = self.plan_in("sub")
        other = self.plan_in("sub", "other.md")
        log = Transcript()
        log.result(log.call("Bash", {"command": "cd sub && sed -i 's/a/b/' docs/superpowers/plans/sub.md"}), "ok")
        log.read_plan(other)
        transcript = self.dir / "plans.jsonl"
        log.write(transcript)
        self.assertEqual(ASSIST.scan(transcript, str(self.project))["plans"], [sub, other])

    def test_git_dash_c_before_a_reader_is_still_a_pure_read(self):
        self.assertTrue(ASSIST.is_pure_read("git -C sub diff -- docs/superpowers/plans/sub.md"))
        self.assertFalse(ASSIST.is_pure_read("git -C sub checkout -- docs/superpowers/plans/sub.md"))


class ModelInputTests(AssistCase):
    def test_input_holds_rules_plan_latest_user_messages_turn_and_final_message(self):
        log = Transcript()
        for i in range(5):
            log.human(f"message number {i}")
            log.assistant(f"answer {i}")
        log.read_plan(self.plan)
        log.result(log.call("Edit", {"file_path": "src/unique_file.py"}), "ok")
        self.assess(log, final="FINAL-TEXT: step one is done.")
        text = self.calls[0]["text"]
        self.assertIn("RULE-MARK", text)
        self.assertIn("three: the docs", text)
        users = text.split("USER'S LATEST MESSAGES\n", 1)[1].split("\n\n", 1)[0]
        self.assertIn("message number 4", users)
        self.assertIn("message number 2", users)
        self.assertNotIn("message number 1", users)
        self.assertIn("unique_file.py", text.split("THIS TURN\n", 1)[1])
        self.assertIn("FINAL-TEXT", text.split("FINAL MESSAGE\n", 1)[1])

    def test_the_reviewer_is_haiku_with_the_idle_schema_and_its_own_prompt(self):
        self.assess(self.session())
        call = self.calls[0]
        self.assertEqual(call["model"], "haiku")
        self.assertEqual(call["verdicts"], ["ok", "idle"])
        self.assertEqual(call["kwargs"]["prompt_file"], ASSIST.PROMPT_FILE)
        schema = json.loads(call["kwargs"]["schema_text"])
        self.assertEqual(schema["properties"]["verdict"]["enum"], ["ok", "idle"])
        for field in ("next", "item", "evidence"):
            self.assertIn(field, schema["required"])

    def test_the_prompt_names_every_legit_stop(self):
        prompt = ASSIST.PROMPT_FILE.read_text(encoding="utf-8").lower()
        for phrase in ("question", "blocker", "stop", "pause", "plan"):
            self.assertIn(phrase, prompt)

    def test_a_russian_user_message_reaches_the_model_intact(self):
        log = Transcript()
        log.human(RUSSIAN_MESSAGE)
        log.read_plan(self.plan)
        self.assess(log)
        self.assertIn(RUSSIAN_MESSAGE, self.calls[0]["text"])

    def test_the_wake_turn_itself_is_the_turn_under_review(self):
        log = self.session()
        log.assistant("Step one done.")
        log.user(f"{ASSIST.OWN_MARKER} You stopped with work left")
        log.result(log.call("Edit", {"file_path": "src/after_wake.py"}), "ok")
        self.assess(log)
        self.assertIn("after_wake.py", self.calls[0]["text"].split("THIS TURN\n", 1)[1])

    def test_the_own_wake_is_not_shown_to_the_model_as_a_message_of_the_user(self):
        log = Transcript()
        log.human("the real request of the user")
        log.read_plan(self.plan)
        log.assistant("Step one done.")
        log.user(f"{ASSIST.OWN_MARKER} You stopped with work left")
        self.assess(log)
        users = self.calls[0]["text"].split("USER'S LATEST MESSAGES\n", 1)[1].split("\n\n", 1)[0]
        self.assertIn("the real request of the user", users)
        self.assertNotIn(ASSIST.OWN_MARKER, users)


class WakeTests(AssistCase):
    def test_idle_verdict_wakes_with_the_marker_the_next_item_and_the_evidence(self):
        text = self.assess(self.session())
        self.assertTrue(text.startswith(ASSIST.OWN_MARKER))
        self.assertIn("Wire the hook (plan step two).", text)
        self.assertIn("plan step two is open", text)
        self.assertIn("check whether the user has written since or work is running", text)
        self.assertIn("one short line", text)
        self.assertNotIn("Write the user plainly", text)

    def test_every_decision_is_logged_with_verdict_cost_seconds_and_reason(self):
        self.assess(self.session())
        entry = self.logged()[-1]
        self.assertEqual(entry["decision"], "idle")
        self.assertEqual(entry["verdict"], "idle")
        self.assertEqual(entry["cost"], 0.01)
        self.assertIn("seconds", entry)
        self.assertIn("reason", entry)
        self.assertEqual(entry["session"], "s1")
        self.assertEqual(entry["idle_point"], "step two: wire the hook")

    def test_idle_point_ignores_case_and_spacing_so_repeats_can_be_counted(self):
        self.answer["item"] = "  STEP   two: Wire the hook "
        self.assess(self.session())
        self.assertEqual(self.logged()[-1]["idle_point"], "step two: wire the hook")

    def test_main_wakes_with_exit_code_two_and_the_text_on_stderr(self):
        log = self.session()
        log.assistant("Step one is done.")
        transcript = self.dir / "session.jsonl"
        log.write(transcript)
        payload = {"transcript_path": str(transcript), "session_id": "s1", "cwd": str(self.project), "last_assistant_message": "Step one is done."}
        stderr = io.TextIOWrapper(io.BytesIO(), encoding="utf-8")
        with mock.patch.object(ASSIST.sys, "stdin", io.StringIO(json.dumps(payload))), \
                mock.patch.object(ASSIST.sys, "stderr", stderr), \
                mock.patch.object(ASSIST.sys, "stdout", io.TextIOWrapper(io.BytesIO(), encoding="utf-8")):
            with self.assertRaises(SystemExit) as caught:
                ASSIST.main()
            stderr.flush()
            written = stderr.buffer.getvalue().decode("utf-8")
        self.assertEqual(caught.exception.code, ASSIST.WAKE_EXIT)
        self.assertEqual(ASSIST.WAKE_EXIT, 2)
        self.assertIn(ASSIST.OWN_MARKER, written)

    def test_a_crash_is_logged_and_never_holds_the_turn(self):
        log = self.session()
        log.assistant("done")
        transcript = self.dir / "session.jsonl"
        log.write(transcript)
        payload = {"transcript_path": str(transcript), "session_id": "s1", "cwd": str(self.project)}
        with mock.patch.object(REFLECT, "ask", side_effect=RuntimeError("boom")), \
                mock.patch.object(ASSIST.sys, "stdin", io.StringIO(json.dumps(payload))), \
                mock.patch.object(ASSIST.sys, "stdout", io.TextIOWrapper(io.BytesIO(), encoding="utf-8")):
            ASSIST.main()
        self.assertEqual(self.logged()[-1]["decision"], "crashed")
        self.assertIn("boom", self.logged()[-1]["error"])


class LoopGuardTests(AssistCase):
    """At most MAX_WAKES wakes in a row without a message of the user in between, counted in one small state file per
    session; the last wake asks the session to tell the user where it stands; after that the hook stays silent until
    the user writes."""

    def wake_n(self, log, count):
        return [self.assess(log, final=f"Stopped at {i}.") for i in range(count)]

    def counter(self):
        return json.loads(ASSIST.counter_file("s1").read_text(encoding="utf-8"))

    def test_the_limit_is_three(self):
        self.assertEqual(ASSIST.MAX_WAKES, 3)

    def test_the_first_two_wakes_are_plain_reminders(self):
        texts = self.wake_n(self.session(), 2)
        self.assertTrue(all(texts))
        for text in texts:
            self.assertNotIn("Write the user plainly", text)
        self.assertEqual([entry["wakes"] for entry in self.logged()], [0, 1])

    def test_the_third_wake_asks_the_session_to_tell_the_user(self):
        log = self.session()
        self.wake_n(log, 2)
        text = self.assess(log, final="Stopped at 2.")
        self.assertIn("Write the user plainly", text)
        self.assertIn("Step two: wire the hook", text)
        self.assertIn("why you keep stopping", text)
        self.assertIn("First check whether the user has written since or work is running", text)
        self.assertEqual(self.logged()[-1]["wakes"], 2)

    def test_the_fourth_idle_stop_is_silent_and_makes_no_model_call(self):
        log = self.session()
        self.wake_n(log, 3)
        asked = len(self.calls)
        self.assertIsNone(self.assess(log, final="Stopped again."))
        self.assertEqual(len(self.calls), asked)
        entry = self.logged()[-1]
        self.assertEqual(entry["decision"], "wake-limit")
        self.assertEqual(entry["wakes"], 3)

    def test_a_wake_saves_its_count_and_the_transcript_size_of_the_stop(self):
        log = self.session()
        self.assess(log)
        self.assertEqual(self.counter(), {"count": 1, "point": (self.dir / "session.jsonl").stat().st_size})
        self.assess(log, final="Again.")
        self.assertEqual(self.counter()["count"], 2)

    def test_other_sessions_have_their_own_counter_file(self):
        log = self.session()
        self.wake_n(log, 3)
        other = self.session("o")
        text = ASSIST.assess(self.payload_for(other, "Stopped.", name="other.jsonl", session_id="s2"))
        self.assertIsNotNone(text)
        self.assertEqual(self.logged()[-1]["wakes"], 0)
        self.assertEqual(sorted(p.name for p in self.state.iterdir() if p.name.startswith("wakes")), ["wakes-s1.json", "wakes-s2.json"])

    def test_a_message_of_the_user_resets_the_count(self):
        log = self.session()
        self.wake_n(log, 3)
        log.human("Why did you stop?")
        text = self.assess(log, final="Sorry.")
        self.assertIsNotNone(text)
        self.assertNotIn("Write the user plainly", text)
        self.assertEqual(self.logged()[-1]["wakes"], 0)
        self.assertIsNotNone(self.assess(log, final="Again after the message."))
        self.assertEqual(self.logged()[-1]["wakes"], 1)

    def test_a_poll_answer_never_resets_the_count(self):
        """A poll's result record carries no origin: nothing in it proves a human answered (a hook can answer too)."""
        log = self.session()
        self.wake_n(log, 3)
        ident = log.call("AskUserQuestion", {"questions": []})
        log.result(ident, "Option A")
        self.assertIsNone(self.assess(log, final="Going with option A."))
        self.assertEqual(self.logged()[-1]["decision"], "wake-limit")

    def test_own_wakes_reflection_wakes_and_notifications_neither_count_nor_reset(self):
        log = self.session()
        self.wake_n(log, 2)
        log.user(f"{ASSIST.OWN_MARKER} You stopped with work left: Wire the hook")
        log.user(f"{REFLECT.WAKE_MARKER} Reflection on your previous answer")
        log.notify("whatever", "toolu_x")
        text = self.assess(log, final="Stopped after the wakes.")
        self.assertEqual(self.logged()[-1]["wakes"], 2)
        self.assertIn("Write the user plainly", text)

    def test_the_assistant_quoting_the_marker_is_not_a_message_of_the_user(self):
        log = self.session()
        self.wake_n(log, 2)
        log.assistant(f"The hook said {ASSIST.OWN_MARKER} earlier.")
        self.assess(log, final="Stopped.")
        self.assertEqual(self.logged()[-1]["wakes"], 2)

    def test_the_marker_inside_a_tool_result_is_not_a_message_of_the_user(self):
        log = self.session()
        self.wake_n(log, 2)
        log.result(log.call("Bash", {"command": "grep marker log"}), f"{ASSIST.OWN_MARKER} You stopped")
        self.assess(log, final="Stopped.")
        self.assertEqual(self.logged()[-1]["wakes"], 2)

    def test_a_broken_counter_file_reads_as_zero(self):
        self.state.mkdir(parents=True, exist_ok=True)
        ASSIST.counter_file("s1").write_text("{broken", encoding="utf-8")
        self.assertIsNotNone(self.assess(self.session()))
        self.assertEqual(self.logged()[-1]["wakes"], 0)
        self.assertEqual(self.counter()["count"], 1)

    def test_the_counter_round_trips_and_leaves_no_temporary_file(self):
        self.seed(2, 100)
        self.assertEqual(ASSIST.read_count("s1", {"reset_at": -1}), 2)
        ASSIST.save_count("s1", 3, 200)
        self.assertEqual(ASSIST.read_count("s1", {"reset_at": 199}), 3)
        self.assertEqual([p.name for p in self.state.iterdir() if p.name.startswith("wakes")], ["wakes-s1.json"])

    def test_the_count_is_zero_when_the_user_wrote_at_or_after_the_saved_point(self):
        self.seed(2, 100)
        self.assertEqual(ASSIST.read_count("s1", {"reset_at": 99}), 2)
        self.assertEqual(ASSIST.read_count("s1", {"reset_at": 100}), 0)
        self.assertEqual(ASSIST.read_count("s1", {"reset_at": 500}), 0)

    def test_a_missing_counter_reads_as_zero(self):
        self.assertEqual(ASSIST.read_count("nobody", {"reset_at": -1}), 0)

    def test_two_checks_for_two_different_stops_at_count_two_issue_one_third_wake(self):
        payloads = []
        for name, prefix, pad in (("one.jsonl", "a", "p"), ("two.jsonl", "b", "padding " * 30)):
            log = self.session(prefix)
            log.assistant(pad)
            payloads.append(self.payload_for(log, "Stopped.", name=name))
        self.seed(2)
        barrier = threading.Barrier(2)
        self.during_ask = lambda: barrier.wait(timeout=30)
        results = []
        threads = [threading.Thread(target=lambda p=p: results.append(ASSIST.assess(dict(p)))) for p in payloads]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=60)
        self.assertEqual(len(results), 2)
        self.assertEqual(sum(1 for r in results if r), 1)
        self.assertEqual(sorted(entry["decision"] for entry in self.logged()), ["idle", "wake-limit"])

    def test_a_legit_stop_after_a_wake_ends_the_chain_quietly_and_counts_nothing(self):
        log = self.session()
        self.assess(log)
        self.answer = dict(OK)
        self.assertIsNone(self.assess(log, final="I am blocked: which database do I use?"))
        self.assertEqual(self.counter()["count"], 1)


class MixedRecordTests(AssistCase):
    """One user record can hold a tool_result block and a text block together (the user typed while a tool ran).
    Every block is judged on its own; a record is never dropped for one block's type."""

    def mixed(self, log, text, tool_use_id="toolu_unknown", **extra):
        block = {"type": "tool_result", "tool_use_id": tool_use_id, "content": "output"}
        log.add("user", [block, {"type": "text", "text": text}], **extra)

    def test_the_user_text_next_to_a_tool_result_resets_the_wake_counter(self):
        log = self.session()
        self.seed(3, 1)  # the first user message sits at offset 0, before the saved point
        self.mixed(log, "Why did you stop?", origin={"kind": "human"})
        self.assertIsNotNone(self.assess(log))
        self.assertEqual(self.logged()[-1]["wakes"], 0)

    def test_a_wake_text_next_to_a_tool_result_does_not_reset_the_counter(self):
        log = self.session()
        self.seed(3, 1)
        self.mixed(log, f"{ASSIST.OWN_MARKER} You stopped with work left")
        self.assertIsNone(self.assess(log))
        self.assertEqual(self.logged()[-1]["decision"], "wake-limit")
        self.assertEqual(self.calls, [])

    def test_a_user_message_that_quotes_a_marker_resets_the_wake_counter(self):
        for marker in (ASSIST.OWN_MARKER, REFLECT.WAKE_MARKER):
            with self.subTest(marker):
                log = self.session()
                self.seed(3, 1)
                log.human(f"What does {marker} in your last message mean?")
                self.assertIsNotNone(self.assess(log))
                self.assertEqual(self.logged()[-1]["wakes"], 0)

    def test_a_user_message_that_quotes_a_marker_reaches_the_model(self):
        for marker in (ASSIST.OWN_MARKER, REFLECT.WAKE_MARKER):
            with self.subTest(marker):
                log = Transcript()
                log.human(f"What does {marker} in your last message mean?")
                log.read_plan(self.plan)
                self.calls.clear()
                self.assess(log)
                users = self.calls[0]["text"].split("USER'S LATEST MESSAGES\n", 1)[1].split("\n\n", 1)[0]
                self.assertIn(marker, users)

    def test_a_hook_wake_as_claude_code_records_it_neither_resets_the_counter_nor_reaches_the_model(self):
        for marker in (ASSIST.OWN_MARKER, REFLECT.WAKE_MARKER):
            with self.subTest(marker):
                log = self.session()
                self.seed(3, 1)
                log.attach_wake(marker)
                self.calls.clear()
                self.assertIsNone(self.assess(log))
                self.assertEqual(self.logged()[-1]["decision"], "wake-limit")
                self.assertEqual(self.calls, [])
        log = Transcript()
        log.human("the real request of the user")
        log.read_plan(self.plan)
        log.assistant("Step one done.")
        log.attach_wake(ASSIST.OWN_MARKER)
        self.calls.clear()
        ASSIST.counter_file("s1").unlink(missing_ok=True)
        self.assess(log)
        users = self.calls[0]["text"].split("USER'S LATEST MESSAGES\n", 1)[1].split("\n\n", 1)[0]
        self.assertNotIn(ASSIST.OWN_MARKER, users)

    def test_three_wakes_in_the_recorded_shape_in_a_row_then_the_fourth_idle_stop_is_silent(self):
        log = self.session()
        for i in range(3):
            self.assertIsNotNone(self.assess(log, final=f"Stopped at {i}."))
            log.attach_wake(ASSIST.OWN_MARKER)
        self.calls.clear()
        self.assertIsNone(self.assess(log, final="Stopped again."))
        self.assertEqual(self.logged()[-1]["decision"], "wake-limit")
        self.assertEqual(self.logged()[-1]["wakes"], 3)
        self.assertEqual(self.calls, [])

    def test_a_wake_record_with_an_origin_is_never_the_users_whatever_its_text(self):
        """The origin decides, not the text: a task-notification record that carries the marker anywhere, or none."""
        for text in (f'Stop hook blocking error from command "Stop": {ASSIST.OWN_MARKER} You stopped with work left',
                     f"<system-reminder>{ASSIST.OWN_MARKER} You stopped</system-reminder>", "Something the session did not expect"):
            with self.subTest(text):
                log = self.session()
                self.seed(3, 1)
                log.add("user", text, origin={"kind": "task-notification", "producer": "session-task"})
                self.calls.clear()
                self.assertIsNone(self.assess(log))
                self.assertEqual(self.logged()[-1]["decision"], "wake-limit")
                self.assertEqual(self.calls, [])

    def test_a_record_with_an_origin_that_is_not_the_users_does_not_reach_the_model_as_a_user_message(self):
        for origin, text in (({"kind": "task-notification", "producer": "session-task"},
                              f'Stop hook blocking error from command "Stop": {ASSIST.OWN_MARKER} You stopped with work left'),
                             ({"kind": "plugin", "name": "agent-rig-window"}, "A message of a plugin")):
            with self.subTest(origin):
                log = Transcript()
                log.human("the real request of the user")
                log.read_plan(self.plan)
                log.add("user", text, origin=origin)
                self.calls.clear()
                ASSIST.counter_file("s1").unlink(missing_ok=True)
                self.assess(log)
                users = self.calls[0]["text"].split("USER'S LATEST MESSAGES\n", 1)[1].split("\n\n", 1)[0]
                self.assertIn("the real request of the user", users)
                self.assertNotIn(text, users)

    def test_a_plugin_or_hand_back_origin_is_not_the_user(self):
        for origin in ({"kind": "plugin", "name": "agent-rig-window"}, {"body": "[Subagent hand-back] done"}):
            with self.subTest(origin):
                log = self.session()
                self.seed(3, 1)
                log.add("user", "Please continue with the work", origin=origin)
                self.assertIsNone(self.assess(log))
                self.assertEqual(self.logged()[-1]["decision"], "wake-limit")

    def test_a_human_message_that_quotes_a_marker_resets_the_counter_and_reaches_the_model(self):
        for marker in (ASSIST.OWN_MARKER, REFLECT.WAKE_MARKER):
            with self.subTest(marker):
                log = self.session()
                self.seed(3, 1)
                log.human(f"{marker} what is this?")
                self.calls.clear()
                self.assertIsNotNone(self.assess(log))
                self.assertEqual(self.logged()[-1]["wakes"], 0)
                users = self.calls[0]["text"].split("USER'S LATEST MESSAGES\n", 1)[1].split("\n\n", 1)[0]
                self.assertIn(marker, users)

    def test_a_telegram_message_resets_the_counter_but_a_message_of_the_hub_itself_does_not(self):
        log = self.session()
        self.seed(3, 1)
        log.channel("Why did you stop?")
        self.assertIsNotNone(self.assess(log))
        self.assertEqual(self.logged()[-1]["wakes"], 0)
        log = self.session()
        self.seed(3, 1)
        log.channel("[SYSTEM NOTIFICATION] a hub notice")
        self.assertIsNone(self.assess(log))
        self.assertEqual(self.logged()[-1]["decision"], "wake-limit")

    def test_a_record_without_origin_is_never_the_users(self):
        wrapped = (f"<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\n"
                   f'Stop hook blocking error from command "Stop": {ASSIST.OWN_MARKER} You stopped with work left\n</system-reminder>')
        quoted = f"Why does it say Stop hook blocking error from command \"Stop\": {ASSIST.OWN_MARKER} here?"
        for text in (wrapped, quoted, "Plain words that look like the user", "Why did you stop?"):
            with self.subTest(text[:40]):
                log = self.session()
                self.seed(3, 1)
                log.user(text)
                self.assertIsNone(self.assess(log))
                self.assertEqual(self.logged()[-1]["decision"], "wake-limit")

    def test_a_record_without_origin_does_not_reach_the_model_as_a_user_message(self):
        log = Transcript()
        log.human("the real request of the user")
        log.read_plan(self.plan)
        log.user("Plain words that look like the user")
        self.calls.clear()
        self.assess(log)
        users = self.calls[0]["text"].split("USER'S LATEST MESSAGES\n", 1)[1].split("\n\n", 1)[0]
        self.assertIn("the real request of the user", users)
        self.assertNotIn("Plain words that look like the user", users)

    def test_a_human_message_that_looks_like_a_notification_resets_and_reaches_both_places_the_model_reads(self):
        """reflect's text classification calls this text an event; the record's human origin decides instead."""
        text = "<task-notification>\n<summary>pasted by the user</summary>\n</task-notification> why did this fire?"
        log = self.session()
        self.seed(3, 1)
        log.human(text)
        self.calls.clear()
        self.assertIsNotNone(self.assess(log))
        self.assertEqual(self.logged()[-1]["wakes"], 0)
        model_input = self.calls[0]["text"]
        users = model_input.split("USER'S LATEST MESSAGES\n", 1)[1].split("\n\n", 1)[0]
        turn = model_input.split("THIS TURN\n", 1)[1]
        self.assertIn("pasted by the user", users)
        # the turn starts right after the user's message: it is not a notification and does not end up in the turn
        self.assertNotIn("NOTIFICATION", model_input)
        self.assertNotIn("pasted by the user", turn)
        self.assertIn("Step one is done.", turn)

    def test_a_poll_answer_reaches_the_model_as_a_tool_result_not_as_the_users_words(self):
        log = Transcript()
        log.human("the real request of the user")
        log.read_plan(self.plan)
        ident = log.call("AskUserQuestion", {"questions": []})
        log.result(ident, "Option Zeta")
        self.calls.clear()
        self.assess(log)
        model_input = self.calls[0]["text"]
        users = model_input.split("USER'S LATEST MESSAGES\n", 1)[1].split("\n\n", 1)[0]
        self.assertNotIn("Option Zeta", users)
        self.assertNotIn("poll answer", model_input)
        self.assertIn("Option Zeta", model_input)

    def test_a_notification_text_next_to_a_tool_result_finishes_its_task(self):
        log = self.session()
        log.background("bz9k")
        self.mixed(log, "<task-notification>\n<task-id>bz9k</task-id>\n<status>completed</status>\n</task-notification>")
        self.assertIsNotNone(self.assess(log))

    def test_a_poll_answer_and_a_user_text_in_one_record_clear_the_pending_poll(self):
        log = self.session()
        ident = log.call("AskUserQuestion", {"questions": []})
        self.mixed(log, "Option A, and keep going", tool_use_id=ident, origin={"kind": "human"})
        self.assess(log)
        self.assertEqual(len(self.calls), 1)

    def test_a_record_of_untracked_tool_results_only_keeps_the_count(self):
        log = self.session()
        self.seed(2)
        log.result(log.call("Bash", {"command": "ls"}), "a b c")
        self.assess(log)
        self.assertEqual(self.logged()[-1]["wakes"], 2)


class SupersededVerdictTests(AssistCase):
    """The model takes up to a minute. The transcript size is taken at the start. When, at the end, the file holds
    anything after it but the stop's own bookkeeping, or a line that is not complete JSON, the verdict may be stale
    and a doubt counts as stale: the hook stays silent and counts nothing. The check, the count and the emit happen
    under one lock."""

    def stopped(self, name="session.jsonl", **extra):
        log = self.session()
        log.assistant("Step one is done.")
        return self.payload_for(log, "Step one is done.", name=name, **extra)

    def stale_by(self, grow, **extra):
        self.calls.clear()
        self.during_ask = grow
        payload = self.stopped(**extra)
        emitted = []
        self.assertIsNone(ASSIST.assess(payload, emitted.append))
        self.assertEqual(emitted, [])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.logged()[-1]["decision"], "superseded")
        self.assertFalse(ASSIST.counter_file("s1").exists())

    def fresh_by(self, grow, **extra):
        self.calls.clear()
        ASSIST.counter_file("s1").unlink(missing_ok=True)
        self.during_ask = grow
        emitted = []
        text = ASSIST.assess(self.stopped(**extra), emitted.append)
        self.assertIsNotNone(text)
        self.assertEqual(emitted, [text])
        self.assertEqual(self.logged()[-1]["decision"], "idle")

    def append_raw(self, text):
        with open(self.dir / "session.jsonl", "ab") as handle:
            handle.write(text.encode("utf-8"))

    def late(self, build):
        return lambda: self.append(*self.after_stop(build))

    def test_a_user_message_during_the_model_call_discards_the_verdict(self):
        self.stale_by(self.late(lambda log: log.human("Wait, change of plans")))

    def test_a_tool_call_during_the_model_call_discards_the_verdict(self):
        self.stale_by(self.late(lambda log: log.call("Edit", {"file_path": "src/b.py"})))

    def test_a_second_assistant_text_during_the_model_call_discards_the_verdict(self):
        self.stale_by(self.late(lambda log: (log.assistant("Continuing"), log.assistant("with step two"))))

    def test_a_notification_during_the_model_call_discards_the_verdict(self):
        self.stale_by(self.late(lambda log: log.notify("bz9k", "toolu_x")))

    def test_queued_input_during_the_model_call_discards_the_verdict(self):
        self.stale_by(self.late(lambda log: log.attach_notification("bz9k")))

    def test_a_tool_result_during_the_model_call_discards_the_verdict(self):
        self.stale_by(self.late(lambda log: log.result("toolu_1", "ok")))

    def test_a_queue_operation_during_the_model_call_discards_the_verdict(self):
        record = {"type": "queue-operation", "operation": "enqueue", "timestamp": "2026-01-01T11:00:00.000Z", "content": "typed"}
        self.stale_by(lambda: self.append(record))

    def test_a_half_written_line_during_the_model_call_discards_the_verdict(self):
        self.stale_by(lambda: self.append_raw('{"type": "assistant", "mess'))

    def test_a_complete_line_that_is_not_json_during_the_model_call_discards_the_verdict(self):
        self.stale_by(lambda: self.append_raw("not json at all\n"))

    def test_system_records_during_the_model_call_do_not_discard_the_verdict(self):
        self.fresh_by(self.late(lambda log: (log.system("stop_hook_summary"), log.system("turn_duration"))))

    def test_an_attachment_that_is_not_queued_input_does_not_discard_the_verdict(self):
        self.fresh_by(lambda: self.append({"type": "attachment", "timestamp": "2026-01-01T11:00:00.000Z", "attachment": {"type": "hook_success"}}))

    def test_the_final_message_that_lands_in_the_file_late_does_not_discard_the_verdict(self):
        self.fresh_by(self.late(lambda log: log.assistant("Step one is done.")))

    def attachment(self, kind, **extra):
        return {"type": "attachment", "timestamp": "2026-01-01T11:00:00.000Z", "attachment": {"type": kind, **extra}}

    def late_system(self, subtype, **extra):
        return {"type": "system", "subtype": subtype, "timestamp": "2026-01-01T11:00:00.000Z", **extra}

    def late_assistant(self, content, **extra):
        return {"type": "assistant", "timestamp": "2026-01-01T11:00:00.000Z", "message": {"role": "assistant", "content": content}, **extra}

    def test_a_late_text_that_is_not_the_final_message_discards_the_verdict(self):
        self.stale_by(self.late(lambda log: log.assistant("Now continuing with step two")))

    def test_a_late_text_discards_the_verdict_when_the_payload_names_no_final_message(self):
        self.stale_by(self.late(lambda log: log.assistant("Step one is done.")), last_assistant_message=None)

    def test_a_late_final_message_of_another_prompt_discards_the_verdict(self):
        late = self.late_assistant([{"type": "text", "text": "Step one is done."}], promptId="p-old")
        self.stale_by(lambda: self.append(late), prompt_id="p-now")

    def test_a_late_final_message_of_the_same_prompt_does_not_discard_the_verdict(self):
        late = self.late_assistant([{"type": "text", "text": "Step one is done."}], promptId="p-now")
        self.fresh_by(lambda: self.append(late), prompt_id="p-now")

    def test_a_late_final_message_that_carries_no_prompt_id_does_not_discard_the_verdict(self):
        # Real assistant records carry no promptId (only user records do), so its absence is no mismatch.
        self.fresh_by(self.late(lambda log: log.assistant("Step one is done.")), prompt_id="p-now")

    def test_a_late_assistant_record_without_text_discards_the_verdict(self):
        late = self.late_assistant([{"type": "thinking", "thinking": "hm"}])
        self.stale_by(lambda: self.append(late))

    def test_attachments_that_may_start_a_new_turn_discard_the_verdict(self):
        wake = ("<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\n"
                "Stop hook blocking error from command \"Stop\": [reflect-catchup] You ended your turn.\n</system-reminder>")
        cases = {
            "hook wake": self.attachment("queued_command", prompt=wake, commandMode="task-notification", origin={"kind": "task-notification", "producer": "session-task"}),
            "hook context": self.attachment("hook_additional_context", content=["more"]),
            "hook message": self.attachment("hook_system_message", content="msg"),
            "reminder": self.attachment("silent_turn_reminder"),
            "file": self.attachment("file", filename="a.txt"),
            "edited file": self.attachment("edited_text_file", filename="a.txt"),
            "task status": self.attachment("task_status", taskId="bz9k"),
            "unknown": self.attachment("something_new_in_a_later_version"),
            "no type": {"type": "attachment", "timestamp": "2026-01-01T11:00:00.000Z", "attachment": {}},
            "no body": {"type": "attachment", "timestamp": "2026-01-01T11:00:00.000Z"},
        }
        for label, record in cases.items():
            with self.subTest(label):
                self.stale_by(lambda record=record: self.append(record))

    def test_attachments_that_are_only_hook_bookkeeping_do_not_discard_the_verdict(self):
        for kind in ("hook_success", "hook_cancelled", "prompt_snapshot", "deferred_tools_record"):
            with self.subTest(kind):
                self.fresh_by(lambda kind=kind: self.append(self.attachment(kind)))

    def test_system_records_that_may_start_a_new_turn_discard_the_verdict(self):
        cases = {
            "prevented": self.late_system("stop_hook_summary", hookCount=1, hookErrors=[], preventedContinuation=True),
            "hook error": self.late_system("stop_hook_summary", hookCount=1, hookErrors=["exit 2"], preventedContinuation=False),
            "compact": self.late_system("compact_boundary"),
            "unknown": self.late_system("something_new_in_a_later_version"),
            "no subtype": {"type": "system", "timestamp": "2026-01-01T11:00:00.000Z"},
        }
        for label, record in cases.items():
            with self.subTest(label):
                self.stale_by(lambda record=record: self.append(record))

    def test_a_plain_stop_hook_summary_and_turn_duration_do_not_discard_the_verdict(self):
        summary = self.late_system("stop_hook_summary", hookCount=2, hookInfos=[], hookErrors=[], preventedContinuation=False, hasOutput=False)
        self.fresh_by(lambda: self.append(summary, self.late_system("turn_duration", durationMs=5)))

    def test_a_transcript_that_ends_inside_a_line_is_not_identified_and_makes_no_model_call(self):
        payload = self.stopped()
        self.append_raw('{"type": "assis')
        self.assertIsNone(ASSIST.assess(payload))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.logged()[-1]["decision"], "unidentified")

    def test_an_empty_transcript_is_not_identified(self):
        (self.dir / "session.jsonl").write_text("", encoding="utf-8")
        payload = {"transcript_path": str(self.dir / "session.jsonl"), "session_id": "s1", "cwd": str(self.project)}
        self.assertIsNone(ASSIST.assess(payload))
        self.assertEqual(self.logged()[-1]["decision"], "unidentified")

    def test_a_superseded_stop_leaves_the_next_stop_free_to_wake(self):
        self.during_ask = self.late(lambda log: log.human("Wait"))
        log = self.session()
        self.assertIsNone(self.assess(log))
        self.during_ask = None
        self.assertIsNotNone(self.assess(log, final="Stopped again."))
        self.assertEqual(self.logged()[-1]["wakes"], 0)

    def test_the_check_the_save_and_the_emit_all_happen_inside_the_lock_in_that_order(self):
        order = []
        real = {name: getattr(ASSIST, name) for name in ("state_lock", "grew_beyond", "save_count")}

        @contextlib.contextmanager
        def lock():
            order.append("enter")
            with real["state_lock"]():
                yield
            order.append("exit")

        def wrap(name, label):
            def inner(*args, **kwargs):
                order.append(label)
                return real[name](*args, **kwargs)
            return inner

        payload = self.stopped()
        with mock.patch.object(ASSIST, "state_lock", lock), mock.patch.object(ASSIST, "grew_beyond", wrap("grew_beyond", "check")), \
                mock.patch.object(ASSIST, "save_count", wrap("save_count", "save")):
            text = ASSIST.assess(payload, lambda wake: order.append("emit"))
        self.assertIsNotNone(text)
        self.assertEqual(order, ["enter", "check", "save", "emit", "exit"])

    def test_nothing_is_emitted_at_the_wake_limit(self):
        self.seed(3)
        emitted = []
        self.assertIsNone(ASSIST.assess(self.payload_for(self.session(), "Stopped."), emitted.append))
        self.assertEqual(emitted, [])
        self.assertEqual(self.logged()[-1]["decision"], "wake-limit")

    def test_the_wake_limit_found_inside_the_lock_emits_nothing(self):
        """Another check took the third wake while this one was thinking."""
        self.seed(2)
        self.during_ask = lambda: self.seed(3)
        emitted = []
        self.assertIsNone(ASSIST.assess(self.payload_for(self.session(), "Stopped."), emitted.append))
        self.assertEqual(emitted, [])
        self.assertEqual(self.logged()[-1]["decision"], "wake-limit")

    def test_the_lock_can_be_taken_again_after_it_is_released(self):
        with ASSIST.state_lock():
            pass
        with ASSIST.state_lock():
            pass
        self.assertTrue((self.state / "state.lock").exists())


class SharedAskTests(AssistCase):
    """reflect.ask serves both hooks: the reviewer's prompt and schema are optional parameters."""

    def captured(self, **kwargs):
        envelope = json.dumps({"structured_output": {"verdict": "ok"}, "total_cost_usd": 0})
        completed = subprocess.CompletedProcess(args=[], returncode=0, stdout=envelope, stderr="")
        with mock.patch.object(REFLECT, "ask", ORIGINAL_ASK), \
                mock.patch.object(REFLECT.shutil, "which", return_value="claude"), \
                mock.patch.object(REFLECT.subprocess, "run", return_value=completed) as run:
            answer, _, _ = REFLECT.ask("haiku", ["ok", "idle"], "text", str(self.project), [], time.monotonic(), **kwargs)
        self.assertEqual(answer, {"verdict": "ok"})
        return run.call_args

    def test_custom_prompt_and_schema_reach_the_command_and_the_child_env_is_marked(self):
        prompt = self.dir / "own_prompt.md"
        call = self.captured(prompt_file=prompt, schema_text='{"own": true}')
        command = call.args[0]
        self.assertEqual(command[command.index("--system-prompt-file") + 1], str(prompt))
        self.assertEqual(command[command.index("--json-schema") + 1], '{"own": true}')
        self.assertEqual(call.kwargs["env"][REFLECT.CHILD_ENV], "1")

    def test_defaults_stay_the_reflection_prompt_and_schema(self):
        command = self.captured().args[0]
        self.assertEqual(command[command.index("--system-prompt-file") + 1], str(REFLECT.PROMPT_FILE))
        self.assertEqual(command[command.index("--json-schema") + 1], REFLECT.schema(["ok", "idle"]))


ORIGINAL_ASK = REFLECT.ask


if __name__ == "__main__":
    unittest.main()
