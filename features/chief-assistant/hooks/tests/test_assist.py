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

    def __init__(self):
        self.entries = []
        self.count = 0
        self.ids = 0

    def stamp(self):
        self.count += 1
        return f"2026-01-01T10:{self.count // 60:02d}:{self.count % 60:02d}.000Z"

    def add(self, kind, content, **extra):
        entry = {"type": kind, "timestamp": self.stamp(), "message": {"role": kind, "content": content}, **extra}
        self.entries.append(entry)
        return entry

    def user(self, text):
        return self.add("user", text)

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
        self.entries.append({"type": "attachment", "timestamp": self.stamp(),
                             "attachment": {"type": "queued_command", "commandMode": "task-notification", "prompt": text}})

    def write(self, path):
        path.write_text("".join(json.dumps(e) + "\n" for e in self.entries), encoding="utf-8")


class AssistCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.dir = Path(directory.name)
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

    def session(self):
        """A session that read its plan, worked, and stopped; the caller adds to it before the final message."""
        log = Transcript()
        log.user("Implement the plan")
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
        """The records `build(log)` adds to a fresh Transcript, as plain entries to append."""
        log = Transcript()
        log.count = 500
        build(log)
        return log.entries

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
        log.user("What is in the repository?")
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
        log.user("Read the spec")
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

    def test_a_listed_task_the_session_never_launched_does_not_count(self):
        # The registry can list the async hook itself, which is running while it decides; counting it would silence
        # the idle check for good. Only tasks the transcript shows the session launched count.
        log = self.session()
        listed = [{"id": "hook-itself", "type": "shell", "status": "running", "description": "Stop hook"}]
        self.assertIsNotNone(self.assess(log, background_tasks=listed))

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

    def test_the_active_plan_read_early_is_still_in_the_model_input_after_many_other_plans(self):
        log = Transcript()
        log.user("Implement the plan")
        log.read_plan(self.plan)
        for path in self.others(6):
            log.read_plan(path)
        self.assess(log)
        text = self.calls[0]["text"]
        self.assertIn("two: wire the hook", text)
        self.assertNotIn("PLANS NOT SHOWN", text)

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
        omitted = [f"big{i}.md" for i in range(6 - shown)]
        line = [row for row in text.splitlines() if row.startswith("PLANS NOT SHOWN")]
        self.assertEqual(len(line), 1)
        for name in omitted:
            self.assertIn(name, line[0])
        self.assertNotIn("big5.md", line[0])

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


class ModelInputTests(AssistCase):
    def test_input_holds_rules_plan_latest_user_messages_turn_and_final_message(self):
        log = Transcript()
        for i in range(5):
            log.user(f"message number {i}")
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
        log.user(RUSSIAN_MESSAGE)
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
        log.user("the real request of the user")
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
        self.assertNotIn("write the user plainly", text)

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
    """At most MAX_WAKES wakes in a row without a message of the user in between; the last one asks the session to
    tell the user where it stands; after that the hook stays silent until the user writes."""

    def woken(self, log, count, same_point=True):
        for i in range(count):
            log.assistant(f"Stopped again {i}.")
            log.user(f"{ASSIST.OWN_MARKER} You stopped with work left: Wire the hook")
            log.result(log.call("Edit", {"file_path": f"src/w{i}.py"}), "ok")

    def test_the_limit_is_three(self):
        self.assertEqual(ASSIST.MAX_WAKES, 3)

    def test_a_second_wake_at_the_same_idle_point_is_allowed(self):
        log = self.session()
        self.woken(log, 1)
        text = self.assess(log)
        self.assertIsNotNone(text)
        self.assertNotIn("write the user plainly", text)
        self.assertEqual(self.logged()[-1]["wakes"], 1)

    def test_a_wake_without_any_tool_call_is_still_followed_by_another_wake(self):
        log = self.session()
        log.assistant("Ok.")
        log.user(f"{ASSIST.OWN_MARKER} You stopped with work left")
        self.assertIsNotNone(self.assess(log, final="Understood."))

    def test_the_third_wake_asks_the_session_to_tell_the_user(self):
        log = self.session()
        self.woken(log, 2)
        text = self.assess(log)
        self.assertIn("write the user plainly", text)
        self.assertIn("Step two: wire the hook", text)
        self.assertIn("why you keep stopping", text)
        self.assertEqual(self.logged()[-1]["wakes"], 2)

    def test_the_fourth_idle_stop_is_silent_and_makes_no_model_call(self):
        log = self.session()
        self.woken(log, 3)
        self.assertIsNone(self.assess(log))
        self.assertEqual(self.calls, [])
        entry = self.logged()[-1]
        self.assertEqual(entry["decision"], "wake-limit")
        self.assertEqual(entry["wakes"], 3)

    def test_a_message_of_the_user_resets_the_count(self):
        log = self.session()
        self.woken(log, 3)
        log.user("Why did you stop?")
        log.assistant("Sorry.")
        text = self.assess(log)
        self.assertIsNotNone(text)
        self.assertNotIn("write the user plainly", text)
        self.assertEqual(self.logged()[-1]["wakes"], 0)

    def test_a_user_message_between_wakes_restarts_the_count(self):
        log = self.session()
        self.woken(log, 2)
        log.user("Keep going")
        self.woken(log, 1)
        self.assess(log)
        self.assertEqual(self.logged()[-1]["wakes"], 1)

    def test_reflection_wakes_and_notifications_neither_count_nor_reset(self):
        log = self.session()
        self.woken(log, 2)
        log.user(f"{REFLECT.WAKE_MARKER} Reflection on your previous answer")
        log.notify("whatever")
        text = self.assess(log)
        self.assertEqual(self.logged()[-1]["wakes"], 2)
        self.assertIn("write the user plainly", text)

    def test_a_wake_in_its_real_task_notification_wrapper_counts_and_finishes_no_task(self):
        log = self.session()
        log.background("bg_1")
        wrapped = ("<task-notification>\n<summary>Stop hook feedback\n</task-notification>\n<system-reminder>\n"
                   f'Stop hook blocking error from command "Stop": {ASSIST.OWN_MARKER} You stopped with work left\n</system-reminder>')
        for _ in range(2):
            log.add("user", wrapped, origin={"kind": "task-notification", "producer": "session-task"})
        transcript = self.dir / "session.jsonl"
        log.write(transcript)
        found = ASSIST.scan(transcript, str(self.project))
        self.assertEqual(found["wakes"], 2)
        self.assertEqual([task_id for task_id, _ in found["background"]], ["bg_1"])

    def test_the_assistant_quoting_the_marker_is_not_a_wake(self):
        log = self.session()
        log.assistant(f"The hook said {ASSIST.OWN_MARKER} earlier.")
        self.assess(log)
        self.assertEqual(self.logged()[-1]["wakes"], 0)

    def test_the_marker_inside_a_tool_result_is_not_a_wake(self):
        log = self.session()
        log.result(log.call("Bash", {"command": "grep marker log"}), f"{ASSIST.OWN_MARKER} You stopped")
        self.assess(log)
        self.assertEqual(self.logged()[-1]["wakes"], 0)

    def test_a_legit_stop_after_a_wake_ends_the_chain_quietly(self):
        self.answer = dict(OK)
        log = self.session()
        self.woken(log, 1)
        self.assertIsNone(self.assess(log, final="I am blocked: which database do I use?"))


class MixedRecordTests(AssistCase):
    """One user record can hold a tool_result block and a text block together (the user typed while a tool ran).
    Every block is judged on its own; a record is never dropped for one block's type."""

    def mixed(self, log, text, tool_use_id="toolu_unknown", **extra):
        block = {"type": "tool_result", "tool_use_id": tool_use_id, "content": "output"}
        log.add("user", [block, {"type": "text", "text": text}], **extra)

    def woken(self, log, count):
        for i in range(count):
            log.assistant(f"Stopped again {i}.")
            log.user(f"{ASSIST.OWN_MARKER} You stopped with work left: Wire the hook")

    def test_the_user_text_next_to_a_tool_result_resets_the_wake_counter(self):
        log = self.session()
        self.woken(log, 3)
        self.mixed(log, "Why did you stop?")
        self.assess(log)
        self.assertEqual(self.logged()[-1]["wakes"], 0)
        self.assertEqual(len(self.calls), 1)

    def test_a_wake_text_next_to_a_tool_result_still_counts_as_a_wake(self):
        log = self.session()
        self.mixed(log, f"{ASSIST.OWN_MARKER} You stopped with work left")
        self.assess(log)
        self.assertEqual(self.logged()[-1]["wakes"], 1)

    def test_a_notification_text_next_to_a_tool_result_finishes_its_task(self):
        log = self.session()
        log.background("bz9k")
        self.mixed(log, "<task-notification>\n<task-id>bz9k</task-id>\n<status>completed</status>\n</task-notification>")
        self.assertIsNotNone(self.assess(log))

    def test_a_poll_answer_and_a_user_text_in_one_record_clear_the_pending_poll(self):
        log = self.session()
        ident = log.call("AskUserQuestion", {"questions": []})
        self.mixed(log, "Option A, and keep going", tool_use_id=ident)
        self.assess(log)
        self.assertEqual(len(self.calls), 1)

    def test_a_launch_result_and_a_user_text_in_one_record_keep_the_task_and_reset_the_counter(self):
        log = self.session()
        self.woken(log, 3)
        ident = log.call("Bash", {"run_in_background": True, "command": "bun test"})
        block = {"type": "tool_result", "tool_use_id": ident, "content": "started"}
        log.add("user", [block, {"type": "text", "text": "Keep going"}], toolUseResult={"backgroundTaskId": "bz9k"})
        self.assertIsNone(self.assess(log))
        self.assertEqual(self.logged()[-1]["decision"], "background")
        self.assertEqual(self.logged()[-1]["wakes"], 0)

    def test_a_record_of_untracked_tool_results_only_is_still_skipped_without_effect(self):
        log = self.session()
        self.woken(log, 2)
        log.result(log.call("Bash", {"command": "ls"}), "a b c")
        self.assess(log)
        self.assertEqual(self.logged()[-1]["wakes"], 2)


class SupersededVerdictTests(AssistCase):
    """The model takes up to a minute. When anything was appended to the transcript after the stop point, the verdict
    is stale: the user wrote, or a new turn began. It is discarded, and the check and the wake counter update happen
    under one lock."""

    def stale_by(self, build):
        self.during_ask = lambda: self.append(*self.after_stop(build))
        self.assertIsNone(self.assess(self.session()))
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.logged()[-1]["decision"], "superseded")
        self.assertEqual(ASSIST.load_state(), {})

    def test_a_user_message_during_the_model_call_discards_the_verdict(self):
        self.stale_by(lambda log: log.user("Wait, change of plans"))

    def test_a_new_assistant_turn_during_the_model_call_discards_the_verdict(self):
        self.stale_by(lambda log: log.assistant("Continuing with step two"))

    def test_a_new_tool_call_during_the_model_call_discards_the_verdict(self):
        self.stale_by(lambda log: log.call("Edit", {"file_path": "src/b.py"}))

    def test_a_tool_result_during_the_model_call_discards_the_verdict(self):
        self.stale_by(lambda log: log.result("toolu_1", "ok"))

    def test_a_notification_during_the_model_call_discards_the_verdict(self):
        self.stale_by(lambda log: log.notify("bz9k"))

    def test_records_that_are_no_activity_do_not_discard_the_verdict(self):
        records = [{"type": "queue-operation", "operation": "enqueue", "timestamp": "2026-01-01T11:00:00.000Z", "content": ""},
                   {"type": "system", "subtype": "stop_hook_summary", "timestamp": "2026-01-01T11:00:01.000Z"}]
        self.during_ask = lambda: self.append(*records)
        self.assertIsNotNone(self.assess(self.session()))
        self.assertEqual(self.logged()[-1]["decision"], "idle")

    def test_the_final_message_that_lands_in_the_file_late_is_not_a_new_turn(self):
        log = self.session()
        log.write(self.dir / "session.jsonl")
        final = "Step one is done."
        payload = {"transcript_path": str(self.dir / "session.jsonl"), "session_id": "s1", "cwd": str(self.project), "last_assistant_message": final}
        self.during_ask = lambda: self.append(*self.after_stop(lambda extra: extra.assistant(final)))
        self.assertIsNotNone(ASSIST.assess(payload))

    def test_a_superseded_stop_leaves_the_next_stop_free_to_wake(self):
        self.during_ask = lambda: self.append(*self.after_stop(lambda log: log.user("Wait")))
        log = self.session()
        self.assertIsNone(self.assess(log))
        self.during_ask = None
        self.assertIsNotNone(self.assess(log))

    def test_the_same_stop_never_wakes_twice(self):
        log = self.session()
        log.assistant("Step one is done.")
        log.write(self.dir / "session.jsonl")
        payload = {"transcript_path": str(self.dir / "session.jsonl"), "session_id": "s1", "cwd": str(self.project), "last_assistant_message": "Step one is done."}
        self.assertIsNotNone(ASSIST.assess(payload))
        self.assertIsNone(ASSIST.assess(payload))
        self.assertEqual(self.logged()[-1]["decision"], "duplicate")

    def test_two_checks_at_once_wake_exactly_once(self):
        log = self.session()
        log.assistant("Step one is done.")
        log.write(self.dir / "session.jsonl")
        payload = {"transcript_path": str(self.dir / "session.jsonl"), "session_id": "s1", "cwd": str(self.project), "last_assistant_message": "Step one is done."}
        barrier = threading.Barrier(2)
        self.during_ask = lambda: barrier.wait(timeout=30)
        results = []
        threads = [threading.Thread(target=lambda: results.append(ASSIST.assess(dict(payload)))) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=60)
        self.assertEqual(len(results), 2)
        self.assertEqual(sum(1 for r in results if r), 1)

    def test_the_check_the_state_read_and_the_state_write_all_happen_inside_the_lock(self):
        order = []
        real = {name: getattr(ASSIST, name) for name in ("state_lock", "appended_after", "load_state", "save_state")}

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

        with mock.patch.object(ASSIST, "state_lock", lock), mock.patch.object(ASSIST, "appended_after", wrap("appended_after", "check")), \
                mock.patch.object(ASSIST, "load_state", wrap("load_state", "load")), \
                mock.patch.object(ASSIST, "save_state", wrap("save_state", "save")):
            self.assertIsNotNone(self.assess(self.session()))
        self.assertEqual(order, ["enter", "check", "load", "save", "exit"])

    def test_the_lock_can_be_taken_again_after_it_is_released(self):
        with ASSIST.state_lock():
            pass
        with ASSIST.state_lock():
            pass
        self.assertTrue((self.state / "state.lock").exists())

    def test_the_state_is_replaced_atomically_and_survives_a_reload(self):
        ASSIST.save_state({"s1": {"point": 10}})
        self.assertEqual(ASSIST.load_state(), {"s1": {"point": 10}})
        self.assertEqual([p.name for p in self.state.iterdir() if p.name.startswith("wakes")], ["wakes.json"])

    def test_a_missing_or_broken_state_file_reads_as_empty(self):
        self.assertEqual(ASSIST.load_state(), {})
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / "wakes.json").write_text("{broken", encoding="utf-8")
        self.assertEqual(ASSIST.load_state(), {})


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
