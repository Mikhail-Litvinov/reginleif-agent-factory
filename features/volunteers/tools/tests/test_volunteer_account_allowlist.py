"""volunteer-run.py honours the cswap account allowlist (base/tools/account-allowlist.py).

The launcher runs as a real subprocess with an injected home directory and environment, so nothing touches the
real ~ or cswap files. RIG_LAUNCHER_UNDER_TEST points the tests at another copy of the launcher (used to prove
that the refusal tests fail on the old code).
Run from the clone root: python -I -m unittest discover -s features/volunteers/tools/tests -v
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

DEFAULT_SCRIPT = Path(__file__).resolve().parents[1] / "volunteer-run.py"
SCRIPT = Path(os.environ.get("RIG_LAUNCHER_UNDER_TEST") or DEFAULT_SCRIPT)
RUN_TIMEOUT_SECONDS = 60
REFUSAL_MARK = "REFUSED: volunteers is not allowed on cswap account 2"
ALLOWED = [1, 4]


class VolunteerAccountAllowlistTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.home = Path(tmp.name)
        sequence = self.home / ".claude-swap-backup" / "sequence.json"
        sequence.parent.mkdir(parents=True)
        sequence.write_text(json.dumps({"activeAccountNumber": 4, "accounts": {"1": {}, "2": {}, "4": {}}}), encoding="utf-8")
        config = self.home / ".agent-rig" / "account-allowlist.json"
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({"codex": ALLOWED, "volunteers": ALLOWED}), encoding="utf-8")
        self.prompt = self.home / "prompt.md"
        self.prompt.write_text("do nothing", encoding="utf-8")

    def run_launcher(self, profile, *args):
        env = {k: v for k, v in os.environ.items() if k != "CLAUDE_CONFIG_DIR"}
        env["USERPROFILE"] = env["HOME"] = str(self.home)
        env["VOLUNTEER_JOBS_DIR"] = str(self.home / "jobs")
        if profile:
            env["CLAUDE_CONFIG_DIR"] = str(self.home / ".claude-swap-backup" / "sessions" / profile)
        return subprocess.run([sys.executable, "-I", str(SCRIPT), *args], env=env, capture_output=True, text=True,
                              timeout=RUN_TIMEOUT_SECONDS, cwd=str(self.home), encoding="utf-8", errors="replace")

    def test_start_is_refused_on_an_unlisted_account(self):
        result = self.run_launcher("2-someone", "start", "--prompt-file", str(self.prompt))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(REFUSAL_MARK, result.stderr)
        self.assertIn("account-allowlist.json", result.stderr)

    def test_reply_is_refused_on_an_unlisted_account(self):
        result = self.run_launcher("2-someone", "reply", "no-such-job", "--prompt-file", str(self.prompt))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(REFUSAL_MARK, result.stderr)

    def test_list_cancel_wait_attach_are_not_refused(self):
        for args in (("list",), ("cancel", "no-such-job"), ("wait", "no-such-job"), ("attach", "no-such-job")):
            result = self.run_launcher("2-someone", *args)
            self.assertNotIn("REFUSED", result.stderr + result.stdout, args)

    def test_listed_accounts_are_not_refused_by_the_allowlist(self):
        for profile in (None, "1-someone"):
            result = self.run_launcher(profile, "reply", "no-such-job", "--prompt-file", str(self.prompt))
            self.assertNotIn("not allowed on cswap", result.stderr)

    def test_session_hint_is_emitted_only_on_an_unlisted_account(self):
        blocked = self.run_launcher("2-someone", "session-hint")
        self.assertEqual(blocked.returncode, 0)
        payload = json.loads(blocked.stdout)["hookSpecificOutput"]
        self.assertEqual(payload["hookEventName"], "SessionStart")
        self.assertIn("Volunteers are disabled", payload["additionalContext"])
        for profile in (None, "1-someone"):
            self.assertEqual(self.run_launcher(profile, "session-hint").stdout, "")


if __name__ == "__main__":
    unittest.main()
