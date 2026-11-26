"""Tests for the chief assistant hook. No test makes a model call: the reviewer (reflect.ask) is faked.

    python -I -m unittest discover -v -s features/chief-assistant/hooks/tests -p test_assist.py
"""
import importlib.util
import io
import json
import os
import subprocess
import tempfile
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

    def result(self, ident, text, error=False):
        block = {"type": "tool_result", "tool_use_id": ident, "content": text}
        if error:
            block["is_error"] = True
        self.add("user", [block])

    def read_plan(self, path, name="Read"):
        self.result(self.call(name, {"file_path": str(path)}), "ok")

    def background(self, task_id, kind="Bash", stamp=None):
        """A background launch and its immediate answer, as the real transcript holds them."""
        ident = self.call(kind, {"run_in_background": True, "command": "bun test"}, stamp)
        if kind == "Agent":
            self.result(ident, f"Async agent launched successfully.\nagentId: {task_id} (internal ID)\nThe agent is working in the background.")
        else:
            self.result(ident, f"Command running in background with ID: {task_id}. Output is being written to: x.output. You will be notified when it completes.")
        return ident

    def notify(self, task_id, tool_use_id="toolu_other"):
        text = f"<task-notification>\n<task-id>{task_id}</task-id>\n<tool-use-id>{tool_use_id}</tool-use-id>\n<status>completed</status>\n</task-notification>"
        self.add("user", text, origin={"kind": "task-notification"})
        # the queue entry that announces the same notification
        self.entries.append({"type": "queue-operation", "operation": "enqueue", "timestamp": self.stamp(), "content": text})

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
        patcher = mock.patch.object(REFLECT, "ask", side_effect=self.fake_ask)
        patcher.start()
        self.addCleanup(patcher.stop)

    def fake_ask(self, model, verdicts, text, cwd, dirs, started, **kwargs):
        self.calls.append({"model": model, "verdicts": verdicts, "text": text, "cwd": cwd, "dirs": dirs, "kwargs": kwargs})
        return (dict(self.answer) if self.answer else None), 0.01, ("" if self.answer else "network down")

    def session(self):
        """A session that read its plan, worked, and stopped; the caller adds to it before the final message."""
        log = Transcript()
        log.user("Implement the plan")
        log.read_plan(self.plan)
        log.result(log.call("Edit", {"file_path": "src/a.py"}), "ok")
        return log

    def assess(self, log, final="Step one is done."):
        log.assistant(final)
        transcript = self.dir / "session.jsonl"
        log.write(transcript)
        payload = {"transcript_path": str(transcript), "session_id": "s1", "cwd": str(self.project), "last_assistant_message": final}
        return ASSIST.assess(payload)

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

    def test_a_notification_matched_by_tool_use_id_finishes_the_task(self):
        log = self.session()
        ident = log.background("bz9k")
        log.notify("some-other-id", ident)
        self.assertIsNotNone(self.assess(log))

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
        log.result(log.call("Bash", {"run_in_background": False, "command": "ls"}), "Command running in background with ID: nothing")
        self.assertIsNotNone(self.assess(log))

    def test_a_launch_older_than_the_stale_limit_is_ignored(self):
        log = self.session()
        log.background("old", stamp="2025-12-30T09:00:00.000Z")
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

    def test_the_most_recently_touched_plan_comes_first_and_the_list_is_bounded(self):
        paths = []
        for i in range(ASSIST.MAX_PLANS + 2):
            path = self.plan.with_name(f"plan{i}.md")
            path.write_text(f"plan {i}", encoding="utf-8")
            paths.append(path)
        log = Transcript()
        for path in paths:
            log.read_plan(path)
        log.read_plan(paths[0])
        found = self.plans_of(log)
        self.assertEqual(len(found), ASSIST.MAX_PLANS)
        self.assertEqual(found[0], paths[0])
        self.assertEqual(found[1], paths[-1])

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
        self.assertEqual(found["background"], 1)

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
