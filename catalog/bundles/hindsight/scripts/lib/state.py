"""File-based state persistence.

Codex hooks are ephemeral processes — state must be persisted to files.
Uses ~/.hindsight/codex/state/ as the storage directory.
"""

import json
import os
import re
import sys

# fcntl is Unix-only; import conditionally so the module loads on Windows
if sys.platform != "win32":
    import fcntl
else:
    fcntl = None


def _state_dir() -> str:
    """Get the state directory, creating it if needed."""
    state_dir = os.path.join(os.path.expanduser("~"), ".hindsight", "codex", "state")
    os.makedirs(state_dir, exist_ok=True)
    return state_dir


def _safe_filename(name: str) -> str:
    """Sanitize a filename to prevent path traversal."""
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", name)
    name = name.replace("..", "_")
    name = name[:200]
    return name or "state"


def _state_file(name: str) -> str:
    """Get path for a state file. Name is sanitized to prevent traversal."""
    safe = _safe_filename(name)
    path = os.path.join(_state_dir(), safe)
    # Final guard: resolved path must be inside state_dir
    resolved = os.path.realpath(path)
    expected_dir = os.path.realpath(_state_dir())
    if not resolved.startswith(expected_dir + os.sep) and resolved != expected_dir:
        raise ValueError(f"State file path escapes state directory: {name!r}")
    return path


def read_state(name: str, default=None):
    """Read a JSON state file. Returns default if not found."""
    path = _state_file(name)
    if not os.path.exists(path):
        return default
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return default


def write_state(name: str, data):
    """Write data to a JSON state file atomically."""
    path = _state_file(name)
    tmp_path = path + ".tmp"
    try:
        with open(tmp_path, "w") as f:
            json.dump(data, f)
        os.replace(tmp_path, path)
    except OSError:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


def get_turn_count(session_id: str) -> int:
    """Get the current turn count for a session."""
    turns = read_state("turns.json", {})
    return turns.get(session_id, 0)


def increment_turn_count(session_id: str) -> int:
    """Increment and return the turn count for a session.

    Uses flock on Unix to prevent race conditions. On Windows, proceeds
    without a lock — minor races here are harmless.
    """
    lock_path = _state_file("turns.lock")
    if fcntl is not None:
        try:
            lock_fd = open(lock_path, "w")
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            try:
                turns = read_state("turns.json", {})
                turns[session_id] = turns.get(session_id, 0) + 1
                if len(turns) > 10000:
                    sorted_keys = sorted(turns.keys())
                    for k in sorted_keys[: len(sorted_keys) // 2]:
                        del turns[k]
                write_state("turns.json", turns)
                return turns[session_id]
            finally:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
                lock_fd.close()
        except OSError:
            pass

    # Fallback: proceed without lock
    turns = read_state("turns.json", {})
    turns[session_id] = turns.get(session_id, 0) + 1
    if len(turns) > 10000:
        sorted_keys = sorted(turns.keys())
        for k in sorted_keys[: len(sorted_keys) // 2]:
            del turns[k]
    write_state("turns.json", turns)
    return turns[session_id]


def _locked_read_modify_write(state_name: str, lock_name: str, modify_fn):
    """Read-modify-write a shared state file while holding an exclusive lock."""
    lock_path = _state_file(lock_name)
    if fcntl is not None:
        try:
            lock_fd = open(lock_path, "w")
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            try:
                data = read_state(state_name, {})
                data, result = modify_fn(data)
                write_state(state_name, data)
                return result
            finally:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
                lock_fd.close()
        except OSError:
            pass

    data = read_state(state_name, {})
    data, result = modify_fn(data)
    write_state(state_name, data)
    return result


def get_retention_checkpoint(session_id: str) -> dict:
    """Return the latest submitted transcript checkpoint and async state."""
    checkpoints = read_state("retention_checkpoints.json", {})
    checkpoint = checkpoints.get(session_id, {})
    return dict(checkpoint) if isinstance(checkpoint, dict) else {}


def commit_retention_checkpoint(session_id: str, checkpoint: dict) -> None:
    """Persist the latest submitted transcript checkpoint."""

    def _update(checkpoints):
        checkpoints[session_id] = dict(checkpoint)
        if len(checkpoints) > 10000:
            sorted_keys = sorted(checkpoints.keys())
            for key in sorted_keys[: len(sorted_keys) // 2]:
                del checkpoints[key]
        return checkpoints, None

    _locked_read_modify_write(
        "retention_checkpoints.json",
        "retention_checkpoints.lock",
        _update,
    )


def stage_retention_operation(
    session_id: str,
    checkpoint: dict,
    operation: dict,
) -> None:
    """Advance the submitted checkpoint while retaining async operation state."""

    def _update(checkpoints):
        current = checkpoints.get(session_id, {})
        inflight = (
            list(current.get("inflight_operations", []))
            if isinstance(current, dict)
            else []
        )
        inflight.append(dict(operation))
        next_checkpoint = dict(checkpoint)
        next_checkpoint["inflight_operations"] = inflight[-20:]
        checkpoints[session_id] = next_checkpoint
        return checkpoints, None

    _locked_read_modify_write(
        "retention_checkpoints.json",
        "retention_checkpoints.lock",
        _update,
    )
