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
Query from outside (the telegram hub's /info):
  python -I account-allowlist.py check <codex|volunteers> --config-dir <dir>
prints {"allowed": bool, "reason": str} as one JSON line; an empty or omitted --config-dir is the main login.
"""
import argparse
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


def build_parser():
    parser = argparse.ArgumentParser(description="Query the cswap account allowlist.")
    commands = parser.add_subparsers(dest="command", required=True)
    query = commands.add_parser("check", help="print whether a category is allowed for a Claude config dir")
    query.add_argument("category", choices=CATEGORIES)
    query.add_argument("--config-dir", default="",
                       help="the CLAUDE_CONFIG_DIR of the session; empty or omitted is the main login")
    account = commands.add_parser("account", help="print the cswap account of a Claude config dir")
    account.add_argument("--config-dir", default="",
                         help="the CLAUDE_CONFIG_DIR of the session; empty or omitted is the main login")
    return parser


def main(argv=None):
    """`check <category> --config-dir <dir>`: one line of JSON {"allowed", "reason"}, exit 0 in both cases.
    `account --config-dir <dir>`: one line of JSON {"present", "account"} (account is null when unknown).

    The process's own CLAUDE_CONFIG_DIR is ignored: --config-dir alone names the session's config dir.
    """
    args = build_parser().parse_args(argv)
    env = {"CLAUDE_CONFIG_DIR": args.config_dir} if args.config_dir else {}
    if args.command == "account":
        present, number = current_account(env)
        print(json.dumps({"present": present, "account": number}, ensure_ascii=True))
        return 0
    allowed, reason = check(args.category, env)
    print(json.dumps({"allowed": allowed, "reason": reason}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
