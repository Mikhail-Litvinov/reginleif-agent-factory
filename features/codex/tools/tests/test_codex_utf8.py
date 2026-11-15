"""UTF-8 end to end on Windows: the garbled-output detector, the Python UTF-8 environment, and a probe that runs the
read command the run rules prescribe through the shell launch Codex gets (CODEX_RUN_LIVE_PROBE=1)."""
import importlib.util
import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "codex-run.py"
spec = importlib.util.spec_from_file_location("codex_run", SCRIPT)
cr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cr)

# Invented Cyrillic line (escapes keep the committed file free of Cyrillic).
CYRILLIC_LINE = "# \u0417\u0430\u043c\u0435\u0442\u043a\u0438 \u043f\u0440\u043e \u043b\u0443\u043d\u0443 \u2014 \u0442\u0435\u0441\u0442 \u0451"
# What Windows PowerShell 5.1 printed for such a line in a real job: the replacement character and control noise.
GARBLED_OUTPUT = "# D\x07D\x14D\ufffdD\ufffdD\ufffdD'D\ufffd\r\n"
CREATE_NO_WINDOW = 0x08000000
# The tool's PowerShell wrapper as seen in job events (Windows PowerShell 5.1, no profile).
POWERSHELL = r"C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe"
PRESCRIBED_READER_RE = re.compile(r'& "([^"]*head\.exe)" -n N FILE')
FALLBACK_READ = "Get-Content -LiteralPath {file} -TotalCount 1"


def event(command, output):
    return {"type": "item.completed", "item": {"type": "command_execution", "command": command,
                                                "aggregated_output": output}}


class MojibakeDetectorTest(unittest.TestCase):
    def test_flags_replacement_character_and_control_noise(self):
        for output in (GARBLED_OUTPUT, "a \ufffd b", "x\x07y", "x\x14y", "x\x00y"):
            self.assertEqual(cr.mojibake_commands([event("cmd", output)]), ["cmd"], repr(output))

    def test_ignores_clean_text(self):
        clean = [CYRILLIC_LINE + "\r\n", "\x1b[31mred\x1b[0m done\n", "a\tb\r\nc\n", "plain ascii", ""]
        for output in clean:
            self.assertEqual(cr.mojibake_commands([event("cmd", output)]), [], repr(output))

    def test_ignores_other_event_types_and_lists_a_command_once(self):
        started = {"type": "item.started", "item": {"type": "command_execution", "command": "c",
                                                     "aggregated_output": "\ufffd"}}
        self.assertEqual(cr.mojibake_commands([started]), [])
        self.assertEqual(cr.mojibake_commands([event("c", "\ufffd"), event("c", "\ufffd")]), ["c"])

    def test_final_digest_warns_and_lists_at_most_three(self):
        with tempfile.TemporaryDirectory(prefix="codex-run-utf8-test-") as tmp:
            d = Path(tmp)
            events = [event(f"read-{n}", GARBLED_OUTPUT) for n in range(cr.MOJIBAKE_MAX_LISTED + 2)]
            (d / "events.jsonl").write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")
            st = {"job": "j", "status": "done", "slug": "s", "effort": "medium", "created": cr.now(), "ended": cr.now()}
            text = cr.digest(d, st, events, final=True)
            self.assertIn("garbled text", text)
            self.assertIn("read-0", text)
            self.assertNotIn(f"read-{cr.MOJIBAKE_MAX_LISTED}", text)
            (d / "events.jsonl").write_text(json.dumps(event("ok", CYRILLIC_LINE)) + "\n", encoding="utf-8")
            clean = cr.digest(d, st, [], final=True)
            self.assertNotIn("garbled", clean)


class Utf8EnvironmentTest(unittest.TestCase):
    def make_supervisor(self):
        tmp = tempfile.TemporaryDirectory(prefix="codex-run-utf8-test-")
        self.addCleanup(tmp.cleanup)
        d = Path(tmp.name)
        cr.write_json(d / "state.json", {"cwd": tmp.name, "created": cr.now(), "notes": [], "slug": "s",
                                         "line": "luna", "effort": "medium", "read_only": True, "session_id": "sid"})
        (d / "prompt.md").write_text("x", encoding="utf-8")
        return cr.Supervisor(d)

    @unittest.skipUnless(os.name == "nt", "the override is Windows-only")
    def test_python_runs_in_utf8_mode_on_start_and_resume(self):
        sup = self.make_supervisor()
        for resume in (None, "go on"):
            command, _ = sup.command(resume)
            self.assertIn(cr.UTF8_ENV_OVERRIDE, command)
        self.assertIn("PYTHONUTF8", cr.UTF8_ENV_OVERRIDE)

    def test_windows_rule_prescribes_a_byte_transparent_reader(self):
        rule = cr.run_rules(windows=True)
        self.assertRegex(rule, PRESCRIBED_READER_RE)
        self.assertNotIn("Read files with Get-Content", rule)


@unittest.skipUnless(os.environ.get("CODEX_RUN_LIVE_PROBE") == "1", "set CODEX_RUN_LIVE_PROBE=1 to run the shell probe")
@unittest.skipUnless(os.name == "nt", "Windows PowerShell only")
class ShellRoundTripProbe(unittest.TestCase):
    """The read command the Windows run rule prescribes, run the way Codex runs a command (the PowerShell 5.1 wrapper,
    no console window, stdout captured through a pipe), must return the exact bytes of a BOM-less UTF-8 file.

    Run: CODEX_RUN_LIVE_PROBE=1 python -I -m unittest discover -s features/codex/tools/tests -p "test_codex_utf8.py"
    """

    def prescribed_read(self, file):
        found = PRESCRIBED_READER_RE.search(cr.run_rules(windows=True))
        if not found:
            return FALLBACK_READ.format(file=file)
        return f'& "{found.group(1)}" -n 1 {file}'

    def test_prescribed_read_returns_exact_utf8(self):
        with tempfile.TemporaryDirectory(prefix="codex-run-utf8-probe-") as tmp:
            (Path(tmp) / "notes.txt").write_bytes((CYRILLIC_LINE + "\nsecond\n").encode("utf-8"))
            command = self.prescribed_read("notes.txt")
            done = subprocess.run([POWERSHELL, "-NoProfile", "-Command", command], cwd=tmp, capture_output=True,
                                  creationflags=CREATE_NO_WINDOW, timeout=60)
            self.assertEqual(done.stdout.decode("utf-8", errors="replace").splitlines()[0], CYRILLIC_LINE, command)

    def test_python_prints_utf8_with_the_override_environment(self):
        env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
        code = "print(chr(0x417) + chr(0x430))"
        done = subprocess.run([POWERSHELL, "-NoProfile", "-Command", f'python -c "{code}"'], capture_output=True,
                              creationflags=CREATE_NO_WINDOW, env=env, timeout=60)
        self.assertEqual(done.stdout.decode("utf-8").strip(), "\u0417\u0430")


if __name__ == "__main__":
    unittest.main()
