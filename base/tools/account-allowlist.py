"""Per-category allowlist of claude-swap (cswap) account numbers; loaded by path by the agent run launchers.

Config: ~/.agent-rig/account-allowlist.json, `{"codex": [1, 4], "volunteers": [1, 4]}`.
  - no file, or a category key missing: that category is unrestricted
  - a category list present: the session's cswap account number must be in it
Account of the session:
  - ~/.claude-swap-backup/sequence.json missing: no cswap, the account is unknown and nothing is restricted
  - CLAUDE_CONFIG_DIR unset or the main ~/.claude: the main login, `activeAccountNumber` of sequence.json
  - CLAUDE_CONFIG_DIR = .../sessions/<N>-<name>: account N
  - anything else (unreadable sequence.json, a profile dir without a number): unknown, so a restricted category fails closed
Malformed config: every category is refused, naming the file.
"""
import json
import os
import re
from pathlib import Path

# cswap names a side profile dir "<account number>-<name>"
PROFILE_NAME = re.compile(r"^([0-9]+)-")

SEQUENCE_PARTS = (".claude-swap-backup", "sequence.json")
MAIN_PROFILE = ".claude"
CATEGORIES = ("codex", "volunteers")
CONFIG_DISPLAY = "~/.agent-rig/account-allowlist.json"


def config_path(home):
    return Path(home) / ".agent-rig" / "account-allowlist.json"


def _read_sequence(home):
    """(cswap_present, sequence dict or None)."""
    path = Path(home) / SEQUENCE_PARTS[0] / SEQUENCE_PARTS[1]
    if not path.is_file():
        return False, None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return True, None
    return True, data if isinstance(data, dict) else None


def _is_number(value):
    return isinstance(value, int) and not isinstance(value, bool)


def current_account(env=None, home=None):
    """(cswap_present, account number or None when it cannot be determined)."""
    env = os.environ if env is None else env
    home = Path.home() if home is None else Path(home)
    present, sequence = _read_sequence(home)
    if not present:
        return False, None
    profile = env.get("CLAUDE_CONFIG_DIR")
    main = True
    if profile:
        try:
            main = Path(profile).resolve() == (home / MAIN_PROFILE).resolve()
        except OSError:
            main = False
    if main:
        number = (sequence or {}).get("activeAccountNumber")
        return True, number if _is_number(number) else None
    match = PROFILE_NAME.match(Path(profile).name)
    return True, int(match.group(1)) if match else None


def load_config(home):
    """(config dict, error text or None). A missing file is an empty config."""
    path = config_path(home)
    if not path.is_file():
        return {}, None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return {}, f"{CONFIG_DISPLAY} is malformed ({e.__class__.__name__}); fix or delete it"
    if not isinstance(data, dict):
        return {}, f"{CONFIG_DISPLAY} is malformed (the top level must be an object); fix or delete it"
    for category in CATEGORIES:
        if category in data and not (isinstance(data[category], list) and all(_is_number(n) for n in data[category])):
            return {}, f'{CONFIG_DISPLAY} is malformed ("{category}" must be a list of account numbers); fix or delete it'
    return data, None


def check(category, env=None, home=None):
    """(allowed, reason). The reason is empty when allowed."""
    home = Path.home() if home is None else Path(home)
    config, error = load_config(home)
    if error:
        return False, f"REFUSED: {category} is blocked: {error}"
    allowed = config.get(category)
    if allowed is None:
        return True, ""
    present, number = current_account(env, home)
    if not present:
        return True, ""
    listed = ", ".join(str(n) for n in allowed) or "none"
    if number is None:
        return False, (f"REFUSED: {category} is limited to cswap accounts [{listed}] by {CONFIG_DISPLAY}, "
                       "but the account of this session cannot be determined")
    if number not in allowed:
        return False, (f"REFUSED: {category} is not allowed on cswap account {number} "
                       f"(allowed: {listed}; set in {CONFIG_DISPLAY})")
    return True, ""


def refuse_if_blocked(category, env=None, home=None):
    """Exit with the refusal text when the category is blocked on this account."""
    allowed, reason = check(category, env, home)
    if not allowed:
        raise SystemExit(reason)


def session_hint(category, hint, env=None, home=None, out=None):
    """Print the SessionStart hook output carrying `hint` when the category is blocked on this account."""
    allowed, reason = check(category, env, home)
    if allowed:
        return
    text = json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart",
                                              "additionalContext": f"{hint} ({reason})"}}, ensure_ascii=True)
    print(text, file=out)
