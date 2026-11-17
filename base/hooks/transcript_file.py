"""Find a session's transcript by its id.

Claude Code names `transcript_path` after the session's current cwd, but a session started in one cwd and resumed in
another (a subdirectory, a worktree) keeps writing to the transcript where it began, so the named file may not exist.
The transcript is the existing file `<config dir>/projects/*/<session_id>.jsonl`. Stdlib only.
Hooks run from the clone, so a hook imports this module by putting this folder on sys.path.
"""
import os
from pathlib import Path

PROJECTS_FOLDER = "projects"
DEFAULT_CONFIG_FOLDER = ".claude"


def config_dir() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / DEFAULT_CONFIG_FOLDER)


def resolve(named, session_id) -> Path:
    """The named path when it is a file; else the existing projects/*/<session_id>.jsonl (the most recently
    modified when there are several); else the named path."""
    named_path = Path(named or "")
    if named_path.is_file() or not isinstance(session_id, str) or not session_id or "/" in session_id or "\\" in session_id:
        return named_path
    found = [path for path in (config_dir() / PROJECTS_FOLDER).glob(f"*/{session_id}.jsonl") if path.is_file()]
    if not found:
        return named_path
    return max(found, key=lambda path: path.stat().st_mtime)
