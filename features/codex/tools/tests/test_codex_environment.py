"""A Codex job does not inherit the session state of the Codex app its launcher runs under: the environment the job's
codex process receives keeps the user's own configuration and drops the host's CODEX_* session variables."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parent.parent / "codex-run.py"
spec = importlib.util.spec_from_file_location("codex_run", SCRIPT)
cr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cr)

FAKE_CODEX = Path(__file__).resolve().parent / "fake_codex.py"

# Invented values; the names are the ones a Codex desktop app session sets (seen in a real inherited environment).
HOST_STATE = {
    "CODEX_SHELL": "1", "CODEX_THREAD_ID": "thread-x", "CODEX_SESSION_ID": "session-x",
    "CODEX_PERMISSION_PROFILE": ":danger-full-access", "CODEX_WINDOWS_SANDBOX_PACKAGE_FAMILY": "family-x",
    "CODEX_WINDOWS_REGISTERED_CORE": "1", "CODEX_APP_RUNTIME_CLI_PATH": "C:/x/codex.exe",
    "CODEX_APP_TOOLS_PIPE_PATH": "pipe-x", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE": "app", "CODEX_CI": "1",
}
USER_CONFIG = {
    "CODEX_HOME": "C:/home/.codex", "CODEX_API_KEY": "key-x", "CODEX_ACCESS_TOKEN": "token-x", "CODEX_CA_CERTIFICATE": "C:/ca.pem",
    "CODEX_SQLITE_HOME": "C:/sqlite", "CODEX_RUN_IDLE_SECONDS": "5", "PATH": "p", "HOME": "h",
}


class CodexEnvironmentTest(unittest.TestCase):
    def test_host_session_state_is_dropped_and_user_configuration_kept(self):
        result = cr.codex_environment({**HOST_STATE, **USER_CONFIG})
        self.assertEqual(result, USER_CONFIG)

    def test_names_match_without_regard_to_case(self):
        result = cr.codex_environment({"Codex_Thread_Id": "t", "codex_home": "h", "Codex_Run_X": "1"})
        self.assertEqual(result, {"codex_home": "h", "Codex_Run_X": "1"})

    def test_the_codex_process_of_a_job_receives_the_cleaned_environment(self):
        with tempfile.TemporaryDirectory(prefix="codex-run-env-test-") as tmp:
            job = Path(tmp)
            seen = job / "env.json"
            cr.write_json(job / "state.json", {"cwd": tmp, "created": cr.now(), "notes": []})
            sup = cr.Supervisor(job)
            sup.command = lambda resume_text=None: ([sys.executable, "-I", str(FAKE_CODEX), "-o", str(job / "last.md")], "prompt")
            env = {**HOST_STATE, **USER_CONFIG, "FAKE_CODEX_ENV_FILE": str(seen)}
            with mock.patch.dict(os.environ, env), mock.patch.object(cr, "POLL_SECONDS", 0.01):
                sup.run()
            received = json.loads(seen.read_text(encoding="utf-8"))
        self.assertEqual([name for name in HOST_STATE if name in received], [])
        for name in ("CODEX_HOME", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "CODEX_CA_CERTIFICATE", "CODEX_RUN_IDLE_SECONDS"):
            self.assertEqual(received.get(name), USER_CONFIG[name], name)


if __name__ == "__main__":
    unittest.main()
