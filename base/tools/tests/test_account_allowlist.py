"""Guard the cswap account allowlist shared by the codex and volunteers launchers (account-allowlist.py).

Run from the clone root: python -I -m unittest discover -s base/tools/tests -v
Every test injects the home directory and the environment; nothing reads the real ~ or cswap files.
"""
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / "account-allowlist.py"
SPEC = importlib.util.spec_from_file_location("account_allowlist", MODULE)
al = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(al)

ACTIVE_ACCOUNT = 4
HINT = "do not use the feature"


class Home:
    """A throwaway home directory with optional cswap files and allowlist config."""

    def __init__(self, test):
        tmp = tempfile.TemporaryDirectory()
        test.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def sequence(self, text=None, active=ACTIVE_ACCOUNT):
        path = self.root / ".claude-swap-backup" / "sequence.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text if text is not None else json.dumps({"activeAccountNumber": active, "accounts": {"1": {}, "4": {}}}),
                        encoding="utf-8")

    def config(self, data):
        path = self.root / ".agent-rig" / "account-allowlist.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")

    def side_env(self, name):
        return {"CLAUDE_CONFIG_DIR": str(self.root / ".claude-swap-backup" / "sessions" / name)}

    def main_env(self):
        return {"CLAUDE_CONFIG_DIR": str(self.root / ".claude")}


class CurrentAccountTest(unittest.TestCase):
    def test_no_cswap_means_unknown_account(self):
        home = Home(self)
        self.assertEqual(al.current_account({}, home.root), (False, None))

    def test_main_login_without_config_dir_is_the_active_account(self):
        home = Home(self)
        home.sequence()
        self.assertEqual(al.current_account({}, home.root), (True, ACTIVE_ACCOUNT))

    def test_main_login_with_config_dir_resolving_to_dot_claude(self):
        home = Home(self)
        home.sequence()
        self.assertEqual(al.current_account(home.main_env(), home.root), (True, ACTIVE_ACCOUNT))

    def test_side_profile_takes_the_number_from_the_dir_prefix(self):
        home = Home(self)
        home.sequence()
        self.assertEqual(al.current_account(home.side_env("1-someone_example.com"), home.root), (True, 1))
        self.assertEqual(al.current_account(home.side_env("12-x"), home.root), (True, 12))

    def test_side_profile_without_a_number_is_undeterminable(self):
        home = Home(self)
        home.sequence()
        self.assertEqual(al.current_account(home.side_env("work-profile"), home.root), (True, None))
        self.assertEqual(al.current_account(home.side_env("1"), home.root), (True, None))

    def test_unreadable_sequence_leaves_the_main_account_undeterminable(self):
        home = Home(self)
        home.sequence("{not json")
        self.assertEqual(al.current_account({}, home.root), (True, None))
        home.sequence(json.dumps({"activeAccountNumber": "4"}))
        self.assertEqual(al.current_account({}, home.root), (True, None))

    def test_unreadable_sequence_does_not_hide_a_side_profile_number(self):
        home = Home(self)
        home.sequence("[]")
        self.assertEqual(al.current_account(home.side_env("2-x"), home.root), (True, 2))


class CheckTest(unittest.TestCase):
    def check(self, home, category="codex", env=None):
        return al.check(category, {} if env is None else env, home.root)

    def test_no_config_file_allows_everything(self):
        home = Home(self)
        home.sequence()
        self.assertEqual(self.check(home, env=home.side_env("2-x")), (True, ""))

    def test_missing_category_key_is_unrestricted(self):
        home = Home(self)
        home.sequence()
        home.config({"volunteers": [1]})
        self.assertEqual(self.check(home, "codex", home.side_env("2-x")), (True, ""))
        self.assertFalse(self.check(home, "volunteers", home.side_env("2-x"))[0])

    def test_listed_main_and_side_accounts_are_allowed(self):
        home = Home(self)
        home.sequence()
        home.config({"codex": [1, 4]})
        self.assertTrue(self.check(home)[0])
        self.assertTrue(self.check(home, env=home.side_env("1-x"))[0])

    def test_unlisted_account_is_refused_with_category_number_and_file(self):
        home = Home(self)
        home.sequence()
        home.config({"codex": [1, 4], "volunteers": [1, 4]})
        for category in ("codex", "volunteers"):
            allowed, reason = self.check(home, category, home.side_env("2-x"))
            self.assertFalse(allowed)
            self.assertIn(category, reason)
            self.assertIn("account 2", reason)
            self.assertIn("account-allowlist.json", reason)
            self.assertTrue(reason.startswith("REFUSED"))

    def test_unlisted_main_account_is_refused(self):
        home = Home(self)
        home.sequence(active=2)
        home.config({"codex": [1, 4]})
        self.assertFalse(self.check(home)[0])

    def test_no_cswap_means_no_restriction(self):
        home = Home(self)
        home.config({"codex": [1]})
        self.assertEqual(self.check(home), (True, ""))

    def test_undeterminable_account_fails_closed_when_the_category_is_listed(self):
        home = Home(self)
        home.sequence()
        home.config({"codex": [1, 4]})
        allowed, reason = self.check(home, env=home.side_env("odd"))
        self.assertFalse(allowed)
        self.assertIn("cannot be determined", reason)
        self.assertIn("account-allowlist.json", reason)

    def test_undeterminable_account_is_fine_for_an_unlisted_category(self):
        home = Home(self)
        home.sequence()
        home.config({"volunteers": [1]})
        self.assertTrue(self.check(home, "codex", home.side_env("odd"))[0])

    def test_empty_list_blocks_every_account(self):
        home = Home(self)
        home.sequence()
        home.config({"codex": []})
        self.assertFalse(self.check(home)[0])

    def test_malformed_config_refuses_every_category_naming_the_file(self):
        bad_configs = ["{oops", "[1, 4]", json.dumps({"codex": "1"}), json.dumps({"codex": [1, "4"]}),
                       json.dumps({"volunteers": [True]})]
        for bad in bad_configs:
            home = Home(self)
            home.config(bad)
            for category in ("codex", "volunteers"):
                allowed, reason = self.check(home, category)
                self.assertFalse(allowed, bad)
                self.assertIn("account-allowlist.json", reason)
                self.assertIn("malformed", reason)

    def test_malformed_config_refuses_even_without_cswap(self):
        home = Home(self)
        home.config("{oops")
        self.assertFalse(self.check(home)[0])


class EntryPointsTest(unittest.TestCase):
    def test_refuse_if_blocked_exits_with_the_reason_only_when_blocked(self):
        home = Home(self)
        home.sequence()
        home.config({"codex": [1, 4]})
        al.refuse_if_blocked("codex", {}, home.root)
        with self.assertRaises(SystemExit) as raised:
            al.refuse_if_blocked("codex", home.side_env("2-x"), home.root)
        self.assertIn("account 2", str(raised.exception))

    def test_session_hint_is_silent_when_allowed_and_json_when_blocked(self):
        home = Home(self)
        home.sequence()
        home.config({"codex": [1, 4]})
        out = io.StringIO()
        al.session_hint("codex", HINT, {}, home.root, out)
        self.assertEqual(out.getvalue(), "")
        al.session_hint("codex", HINT, home.side_env("2-x"), home.root, out)
        payload = json.loads(out.getvalue())["hookSpecificOutput"]
        self.assertEqual(payload["hookEventName"], "SessionStart")
        self.assertIn(HINT, payload["additionalContext"])
        self.assertIn("account 2", payload["additionalContext"])


if __name__ == "__main__":
    unittest.main()
