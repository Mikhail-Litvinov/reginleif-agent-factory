"""Tests for transcript_file.resolve and for compact_history finding a transcript that is not at its named path.

compact_history runs as a subprocess the way Claude Code runs a hook; the config dir is a temporary one.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

HOOKS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HOOKS))

import transcript_file  # noqa: E402

COMPACT = HOOKS / "compact_history.py"
SESSION = "11111111-2222-3333-4444-555555555555"
FOLDER_A = "C--work-project-plugin"
FOLDER_B = "C--work-project"
TIMEOUT_SECONDS = 60
OLDER_SECONDS = 1000
ENTRY = {"type": "user", "timestamp": "2026-01-01T10:00:00.000Z", "message": {"role": "user", "content": "needle in the history"}}


class ConfigDirCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.config = Path(directory.name)
        self.env = {**os.environ, "CLAUDE_CONFIG_DIR": str(self.config)}
        patch = unittest.mock.patch.dict(os.environ, {"CLAUDE_CONFIG_DIR": str(self.config)})
        patch.start()
        self.addCleanup(patch.stop)

    def transcript(self, folder, text="x"):
        path = self.config / "projects" / folder / f"{SESSION}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path

    def named(self, folder=FOLDER_A):
        return self.config / "projects" / folder / f"{SESSION}.jsonl"


class ResolveTests(ConfigDirCase):
    def test_an_existing_named_file_is_used(self):
        named = self.transcript(FOLDER_A)
        self.transcript(FOLDER_B)
        self.assertEqual(transcript_file.resolve(str(named), SESSION), named)

    def test_a_missing_named_file_is_replaced_by_the_session_file_in_another_project_folder(self):
        found = self.transcript(FOLDER_B)
        self.assertEqual(transcript_file.resolve(str(self.named()), SESSION), found)

    def test_several_matches_give_the_most_recently_modified(self):
        older = self.transcript(FOLDER_B)
        newer = self.transcript("C--other")
        os.utime(older, (older.stat().st_atime - OLDER_SECONDS, older.stat().st_mtime - OLDER_SECONDS))
        self.assertEqual(transcript_file.resolve(str(self.named()), SESSION), newer)

    def test_nothing_anywhere_gives_the_named_path(self):
        self.assertEqual(transcript_file.resolve(str(self.named()), SESSION), self.named())

    def test_an_empty_named_path_and_a_missing_session_id_do_not_crash(self):
        self.assertEqual(transcript_file.resolve(None, SESSION), Path(""))
        self.assertEqual(transcript_file.resolve(str(self.named()), None), self.named())


class CompactHistoryTests(ConfigDirCase):
    def run_hook(self, payload):
        result = subprocess.run([sys.executable, "-I", str(COMPACT)], input=json.dumps(payload).encode("utf-8"),
                                capture_output=True, timeout=TIMEOUT_SECONDS, env=self.env)
        return result.returncode, result.stdout.decode("utf-8"), result.stderr.decode("utf-8")

    def test_history_is_written_from_the_transcript_found_by_session_id(self):
        found = self.transcript(FOLDER_B, json.dumps(ENTRY) + "\n")
        code, stdout, stderr = self.run_hook({"session_id": SESSION, "transcript_path": str(self.named())})
        self.assertEqual(code, 0, stderr)
        history = found.parent / SESSION / "pre-compact-history.md"
        self.assertIn("needle in the history", history.read_text(encoding="utf-8"))
        self.assertIn(str(history), json.loads(stdout)["hookSpecificOutput"]["additionalContext"])

    def test_the_named_file_is_used_when_it_exists(self):
        named = self.transcript(FOLDER_A, json.dumps(ENTRY) + "\n")
        self.transcript(FOLDER_B, "")
        code, _, stderr = self.run_hook({"session_id": SESSION, "transcript_path": str(named)})
        self.assertEqual(code, 0, stderr)
        self.assertTrue((named.parent / SESSION / "pre-compact-history.md").is_file())
        self.assertFalse((self.config / "projects" / FOLDER_B / SESSION).exists())

    def test_nothing_anywhere_prints_nothing(self):
        self.assertEqual(self.run_hook({"session_id": SESSION, "transcript_path": str(self.named())}), (0, "", ""))


if __name__ == "__main__":
    unittest.main()
