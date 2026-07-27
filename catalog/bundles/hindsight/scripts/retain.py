#!/usr/bin/env python3
"""Auto-retain hook for Stop event.

Fires after each agent turn. Reads the Codex session transcript and stores
the conversation into Hindsight memory for future recall.

Flow:
  1. Read hook input from stdin (session_id, transcript_path, cwd)
  2. Read conversation transcript from transcript_path
  3. Select only messages not retained by a previous successful hook
  4. Resolve API URL (external, existing local, or auto-start daemon)
  5. Derive bank ID and ensure mission
  6. Format transcript (strip memory tags, filter roles)
  7. POST the first batch with replace, then later batches with append

Exit codes:
  0 — always (graceful degradation on any error)
"""

import hashlib
import json
import os
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from lib.bank import derive_bank_id, ensure_bank_mission
from lib.client import HindsightClient
from lib.config import debug_log, load_config
from lib.content import (
    prepare_retention_transcript,
    read_transcript,
    slice_last_turns_by_user_boundary,
)
from lib.daemon import get_api_url
from lib.state import (
    commit_retention_checkpoint,
    get_retention_checkpoint,
    increment_turn_count,
    stage_retention_operation,
)


def _messages_hash(messages: list) -> str:
    """Return a stable hash for transcript-prefix continuity checks."""
    encoded = json.dumps(
        messages,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def plan_incremental_batch(messages: list, checkpoint: dict) -> dict:
    """Plan the next append batch without mutating retention state.

    The first successful retain replaces the session document to establish a
    clean baseline. Later retains append only the new suffix. If the transcript
    shrinks or its retained prefix changes (for example after compaction), a new
    segment document is started with replace so unrelated histories never mix.
    """
    total_messages = len(messages)
    retained_messages = int(checkpoint.get("message_count", 0) or 0)
    segment = int(checkpoint.get("segment", 0) or 0)
    expected_prefix_hash = checkpoint.get("prefix_hash", "")

    if retained_messages <= 0:
        return {
            "start_index": 0,
            "segment": 0,
            "update_mode": "replace",
            "compacted": False,
        }

    prefix_is_unchanged = (
        retained_messages <= total_messages
        and bool(expected_prefix_hash)
        and _messages_hash(messages[:retained_messages]) == expected_prefix_hash
    )
    if prefix_is_unchanged:
        return {
            "start_index": retained_messages,
            "segment": segment,
            "update_mode": "append",
            "compacted": False,
        }

    return {
        "start_index": 0,
        "segment": segment + 1,
        "update_mode": "replace",
        "compacted": True,
    }


def _checkpoint_for(messages: list, segment: int) -> dict:
    """Build the checkpoint written after a successful retain."""
    return {
        "message_count": len(messages),
        "prefix_hash": _messages_hash(messages),
        "segment": segment,
    }


def _operation_id_for(
    session_id: str,
    document_id: str,
    update_mode: str,
    checkpoint: dict,
) -> str:
    """Return a stable UUID for one logical transcript submission."""
    identity = ":".join(
        [
            "hindsight-retain",
            session_id,
            document_id,
            update_mode,
            str(checkpoint.get("message_count", 0)),
            str(checkpoint.get("prefix_hash", "")),
        ]
    )
    return str(uuid.uuid5(uuid.NAMESPACE_URL, identity))


def _reconcile_inflight_operations(
    client: HindsightClient,
    bank_id: str,
    checkpoint: dict,
    config: dict,
) -> tuple[dict, bool, bool]:
    """Refresh async operation state.

    Returns (checkpoint, needs_recovery_segment, can_continue). Unknown
    operation state is retried with the same operation_id and exact request,
    which is idempotent on supported Hindsight servers.
    """
    inflight = list(checkpoint.get("inflight_operations", []))
    if not inflight:
        return checkpoint, False, True

    remaining = []
    needs_recovery = False
    for operation in inflight:
        operation_id = operation.get("operation_id", "")
        try:
            status_response = client.get_operation_status(
                bank_id,
                operation_id,
                timeout=5,
            )
            status = str(status_response.get("status", "")).lower()
        except Exception:
            request = operation.get("request")
            if not isinstance(request, dict):
                return checkpoint, False, False
            try:
                retry_response = client.retain(**request)
                if not retry_response.get("success", False):
                    raise RuntimeError(
                        f"Retain retry was not accepted: {retry_response}"
                    )
            except Exception as e:
                debug_log(
                    config,
                    f"Unable to verify or resubmit retain operation {operation_id}: {e}",
                )
                return checkpoint, False, False
            remaining.append(operation)
            continue

        if status == "completed":
            continue
        if status in ("failed", "cancelled"):
            needs_recovery = True
            continue
        remaining.append(operation)

    reconciled = {
        key: value
        for key, value in checkpoint.items()
        if key != "inflight_operations"
    }
    if remaining:
        reconciled["inflight_operations"] = remaining
    return reconciled, needs_recovery, True


def main():
    config = load_config()

    if not config.get("autoRetain"):
        debug_log(config, "Auto-retain disabled, exiting")
        return

    # Read hook input from stdin
    try:
        hook_input = json.load(sys.stdin)
    except (json.JSONDecodeError, EOFError):
        print("[Hindsight] Failed to read hook input", file=sys.stderr)
        return

    debug_log(config, f"Stop hook input keys: {list(hook_input.keys())}")

    session_id = hook_input.get("session_id", "unknown")
    transcript_path = hook_input.get("transcript_path", "")
    hook_event_name = hook_input.get("hook_event_name", "")
    force_final_retain = (
        hook_event_name == "SessionEnd"
        and bool(config.get("sessionEndFinalRetain"))
    )

    # Read full transcript
    include_tool_calls = config.get("retainToolCalls", True)
    all_messages = read_transcript(transcript_path, include_tool_calls=include_tool_calls)
    if not all_messages:
        debug_log(config, "No messages in transcript, skipping retain")
        return

    debug_log(config, f"Read {len(all_messages)} messages from transcript")

    # Retention mode: incremental append (preferred), full session, or chunked.
    retain_mode = config.get("retainMode", "full-session")
    retain_every_n = max(1, config.get("retainEveryNTurns", 1))
    retain_full_window = False
    messages_to_retain = all_messages
    update_mode = None
    retention_plan = None
    document_id = session_id
    checkpoint = {}

    # Respect retainEveryNTurns in both modes
    if retain_every_n > 1 and not force_final_retain:
        turn_count = increment_turn_count(session_id)
        if turn_count % retain_every_n != 0:
            next_at = ((turn_count // retain_every_n) + 1) * retain_every_n
            debug_log(config, f"Turn {turn_count}/{retain_every_n}, skipping retain (next at turn {next_at})")
            return

    # Resolve API URL before incremental planning so pending async submissions
    # can be verified or idempotently retried.
    def _dbg(*a):
        debug_log(config, *a)

    try:
        api_url = get_api_url(config, debug_fn=_dbg, allow_daemon_start=True)
    except RuntimeError as e:
        print(f"[Hindsight] {e}", file=sys.stderr)
        return

    api_token = config.get("hindsightApiToken")
    try:
        client = HindsightClient(api_url, api_token)
    except ValueError as e:
        print(f"[Hindsight] Invalid API URL: {e}", file=sys.stderr)
        return

    bank_id = derive_bank_id(hook_input, config)
    ensure_bank_mission(client, bank_id, config, debug_fn=_dbg)

    if retain_mode == "incremental":
        checkpoint = get_retention_checkpoint(session_id)
        checkpoint, needs_recovery, can_continue = _reconcile_inflight_operations(
            client,
            bank_id,
            checkpoint,
            config,
        )
        if not can_continue:
            return
        commit_retention_checkpoint(session_id, checkpoint)
        retention_plan = plan_incremental_batch(all_messages, checkpoint)
        if needs_recovery:
            retention_plan = {
                "start_index": 0,
                "segment": int(checkpoint.get("segment", 0) or 0) + 1,
                "update_mode": "replace",
                "compacted": True,
            }
        start_index = retention_plan["start_index"]
        if start_index >= len(all_messages):
            debug_log(config, f"No new messages for session {session_id}, skipping retain")
            return

        messages_to_retain = all_messages[start_index:]
        retain_full_window = True
        update_mode = retention_plan["update_mode"]
        segment = retention_plan["segment"]
        if segment > 0:
            document_id = f"{session_id}-segment-{segment}"

        if retention_plan["compacted"]:
            debug_log(
                config,
                f"Transcript changed for session {session_id}; starting segment {segment}",
            )
        debug_log(
            config,
            f"Incremental retain: {len(messages_to_retain)} new messages "
            f"from {len(all_messages)} total using {update_mode}",
        )
    elif retain_mode == "chunked" and retain_every_n > 1:
        overlap_turns = config.get("retainOverlapTurns", 0)
        window_turns = retain_every_n + overlap_turns
        messages_to_retain = slice_last_turns_by_user_boundary(all_messages, window_turns)
        retain_full_window = True
        debug_log(
            config,
            f"Chunked retain firing (window: {window_turns} turns, {len(messages_to_retain)} messages)",
        )
    else:
        retain_full_window = True
        debug_log(config, f"Full session retain: {len(all_messages)} messages")

    # Format transcript
    retain_roles = config.get("retainRoles", ["user", "assistant"])
    transcript, message_count = prepare_retention_transcript(
        messages_to_retain, retain_roles, retain_full_window, include_tool_calls=include_tool_calls
    )

    if not transcript:
        if retention_plan is not None:
            empty_checkpoint = _checkpoint_for(
                all_messages,
                retention_plan["segment"],
            )
            inflight = checkpoint.get("inflight_operations")
            if inflight:
                empty_checkpoint["inflight_operations"] = inflight
            commit_retention_checkpoint(session_id, empty_checkpoint)
        debug_log(config, "Empty transcript after formatting, skipping retain")
        return

    # Legacy modes keep their existing document-ID behavior.
    if retain_mode == "chunked" and retain_every_n > 1:
        document_id = f"{session_id}-{int(time.time() * 1000)}"
    elif retain_mode != "incremental":
        document_id = session_id

    # Resolve template variables in tags and metadata
    template_vars = {
        "session_id": session_id,
        "bank_id": bank_id,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }

    def _resolve_template(value: str) -> str:
        for k, v in template_vars.items():
            value = value.replace(f"{{{k}}}", v)
        return value

    raw_tags = config.get("retainTags", [])
    tags = [_resolve_template(t) for t in raw_tags] if raw_tags else None

    metadata = {
        "retained_at": template_vars["timestamp"],
        "message_count": str(len(all_messages)),
        "batch_message_count": str(message_count),
        "session_id": session_id,
    }
    if retention_plan is not None:
        metadata["retention_segment"] = str(retention_plan["segment"])
        metadata["update_mode"] = update_mode
    for k, v in config.get("retainMetadata", {}).items():
        metadata[k] = _resolve_template(str(v))

    debug_log(
        config,
        f"Retaining to bank '{bank_id}', doc '{document_id}', "
        f"{message_count} batch messages, {len(transcript)} chars, mode={update_mode or 'replace'}",
    )
    if tags:
        debug_log(config, f"Tags: {tags}")

    target_checkpoint = (
        _checkpoint_for(all_messages, retention_plan["segment"])
        if retention_plan is not None
        else None
    )
    operation_id = (
        _operation_id_for(
            session_id,
            document_id,
            update_mode or "replace",
            target_checkpoint,
        )
        if target_checkpoint is not None
        else None
    )
    retain_request = {
        "bank_id": bank_id,
        "content": transcript,
        "document_id": document_id,
        "context": config.get("retainContext", "codex"),
        "metadata": metadata,
        "tags": tags,
        "update_mode": update_mode,
        "operation_id": operation_id,
        "timeout": 15,
    }
    if target_checkpoint is not None:
        stage_retention_operation(
            session_id,
            target_checkpoint,
            {
                "operation_id": operation_id,
                "request": retain_request,
            },
        )

    # POST to Hindsight retain API
    try:
        response = client.retain(**retain_request)
        if not response.get("success", False):
            raise RuntimeError(f"Retain was not accepted: {response}")
        debug_log(config, f"Retain response: {json.dumps(response)[:200]}")
    except Exception as e:
        print(f"[Hindsight] Retain failed: {e}", file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"[Hindsight] Unexpected error in retain: {e}", file=sys.stderr)
        try:
            from lib.config import load_config

            sys.exit(2 if load_config().get("debug") else 0)
        except Exception:
            sys.exit(0)
