"""Regression tests for settled reflections and reviewer input."""
import json
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from test_reflect import ProjectCase, REFLECT, text_entry, tool_entries


class SettledTests(ProjectCase):
    def test_imports_expand_and_report_cycles_missing_and_depth(self):
        (self.project / "CLAUDE.md").write_text("@one.md\n@missing.md\n", encoding="utf-8")
        (self.project / "one.md").write_text("imported rule\n@CLAUDE.md\n", encoding="utf-8")
        text = REFLECT.rules({"cwd": str(self.project)}, self.dir / "session.jsonl")
        self.assertIn("imported rule", text)
        self.assertIn("cycle", text.lower())
        self.assertIn("missing", text.lower())

    def test_turn_boundary_and_prior_reflections_outside_window(self):
        payload = self.payload("initial", "finished")
        entries = [text_entry("user", 0, "old request"),
                   text_entry("user", 1, REFLECT.WAKE_MARKER + " Reflection on your previous answer:\n1. Old concern"),
                   text_entry("assistant", 2, "Reflection: I checked the concern."),
                   text_entry("user", 3, "That answer settles it.")]
        for i in range(4):
            entries.extend([text_entry("user", 4, f"later request {i}"), text_entry("assistant", 5, f"earlier answer {i}")])
        entries.extend([text_entry("user", 6, "current request"), *tool_entries(7), text_entry("assistant", 9, "current answer")])
        Path(payload["transcript_path"]).write_text("".join(json.dumps(e) + "\n" for e in entries), encoding="utf-8")
        text = self.review_input(payload)
        prior = text.split("PRIOR REFLECTIONS\n", 1)[1].split("\n\nSTATE", 1)[0]
        self.assertIn("Old concern", prior)
        self.assertIn("I checked the concern", prior)
        self.assertIn("That answer settles it", prior)
        earlier = text.split("EARLIER (context only)\n", 1)[1].split("\n\nTHIS TURN", 1)[0]
        turn = text.split("THIS TURN (review only this)\n", 1)[1].split("\n\nFINAL MESSAGE", 1)[0]
        self.assertIn("current request", earlier)
        self.assertNotIn("earlier answer", turn)
        self.assertIn("current answer", turn)

    def test_state_branch_and_non_repository(self):
        subprocess.run(["git", "init", "-q", "-b", "example-branch", str(self.project)], check=True, capture_output=True)
        text = self.review_input(self.payload("check", "done"))
        self.assertIn("example-branch", text.split("STATE\n", 1)[1].split("\n\n", 1)[0])
        payload = self.payload("check", "done")
        payload["cwd"] = str(self.dir)
        text = self.review_input(payload)
        self.assertNotIn("example-branch", text.split("STATE\n", 1)[1].split("\n\n", 1)[0])

    def test_escalation_and_logging(self):
        item1 = {"kind": 1, "what": "first", "evidence": "e", "fix": "f"}
        item2 = {"kind": 2, "what": "second", "evidence": "e", "fix": "f"}
        for first, second, expected in (("problem", "ok", None), ("problem", "problem", item2), ("ok", None, None), ("unsure", "ok", None)):
            with self.subTest(first=first, second=second):
                answers = [{"verdict": first, "problems": [item1] if first != "ok" else []}]
                if second:
                    answers.append({"verdict": second, "problems": [item2] if second == "problem" else []})
                calls = []
                def ask(model, verdicts, text, cwd, dirs, started):
                    calls.append((model, text))
                    return answers.pop(0), 0, ""
                with mock.patch.object(REFLECT, "ask", side_effect=ask), mock.patch.object(REFLECT, "log") as log:
                    what, result = REFLECT.review(self.payload("check", "done"))
                self.assertEqual(result["problems"][0] if result else None, expected)
                self.assertEqual(len(calls), 2 if second else 1)
                if second:
                    self.assertIn("first", calls[1][1])
                    self.assertIn(first, json.dumps(log.call_args.args[0]))
                    self.assertIn(second, json.dumps(log.call_args.args[0]))
                    if first == "problem" and second == "ok":
                        self.assertEqual(log.call_args.args[0]["first"], {
                            "model": "haiku", "verdict": "problem", "problems": [item1],
                        })
                        self.assertIn(json.dumps(item1, ensure_ascii=False), what)
