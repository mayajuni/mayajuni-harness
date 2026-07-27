import io
import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock


SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from lib.client import HindsightClient
import retain
from retain import _checkpoint_for, plan_incremental_batch


class IncrementalRetentionTests(unittest.TestCase):
    def setUp(self):
        self.first_batch = [
            {"role": "user", "content": "first question"},
            {"role": "assistant", "content": "first answer"},
        ]

    def test_first_batch_establishes_replace_baseline(self):
        plan = plan_incremental_batch(self.first_batch, {})

        self.assertEqual(plan["start_index"], 0)
        self.assertEqual(plan["segment"], 0)
        self.assertEqual(plan["update_mode"], "replace")
        self.assertFalse(plan["compacted"])

    def test_later_batch_appends_only_new_messages(self):
        checkpoint = _checkpoint_for(self.first_batch, segment=0)
        messages = self.first_batch + [
            {"role": "user", "content": "second question"},
            {"role": "assistant", "content": "second answer"},
        ]

        plan = plan_incremental_batch(messages, checkpoint)

        self.assertEqual(plan["start_index"], len(self.first_batch))
        self.assertEqual(plan["segment"], 0)
        self.assertEqual(plan["update_mode"], "append")
        self.assertFalse(plan["compacted"])

    def test_unchanged_transcript_has_no_new_batch(self):
        checkpoint = _checkpoint_for(self.first_batch, segment=0)

        plan = plan_incremental_batch(self.first_batch, checkpoint)

        self.assertEqual(plan["start_index"], len(self.first_batch))
        self.assertEqual(plan["update_mode"], "append")

    def test_changed_prefix_starts_new_replace_segment(self):
        checkpoint = _checkpoint_for(self.first_batch, segment=0)
        compacted_messages = [
            {"role": "user", "content": "compacted session summary"},
            {"role": "assistant", "content": "continued work"},
        ]

        plan = plan_incremental_batch(compacted_messages, checkpoint)

        self.assertEqual(plan["start_index"], 0)
        self.assertEqual(plan["segment"], 1)
        self.assertEqual(plan["update_mode"], "replace")
        self.assertTrue(plan["compacted"])


class RetainClientTests(unittest.TestCase):
    def test_retain_sends_append_update_mode(self):
        client = HindsightClient("https://example.com")
        captured = {}

        def fake_request(method, path, body=None, timeout=15):
            captured.update(
                {
                    "method": method,
                    "path": path,
                    "body": body,
                    "timeout": timeout,
                }
            )
            return {"success": True}

        client._request = fake_request
        client.retain(
            bank_id="hangil-ai",
            content="new messages",
            document_id="session-1",
            update_mode="append",
            operation_id="11111111-1111-5111-8111-111111111111",
        )

        item = captured["body"]["items"][0]
        self.assertEqual(item["document_id"], "session-1")
        self.assertEqual(item["update_mode"], "append")
        self.assertEqual(item["content"], "new messages")
        self.assertEqual(
            captured["body"]["operation_id"],
            "11111111-1111-5111-8111-111111111111",
        )

    def test_get_operation_status_uses_bank_operation_path(self):
        client = HindsightClient("https://example.com")
        captured = {}

        def fake_request(method, path, body=None, timeout=15):
            captured.update({"method": method, "path": path, "timeout": timeout})
            return {"status": "completed"}

        client._request = fake_request

        response = client.get_operation_status(
            "hangil-ai",
            "11111111-1111-5111-8111-111111111111",
        )

        self.assertEqual(response["status"], "completed")
        self.assertEqual(captured["method"], "GET")
        self.assertEqual(
            captured["path"],
            "/v1/default/banks/hangil-ai/operations/"
            "11111111-1111-5111-8111-111111111111",
        )


class RetainHookIntegrationTests(unittest.TestCase):
    def test_successive_hooks_replace_then_append_only_new_messages(self):
        config = {
            "autoRetain": True,
            "retainMode": "incremental",
            "retainEveryNTurns": 1,
            "retainToolCalls": False,
            "retainRoles": ["user", "assistant"],
            "retainContext": "codex",
            "retainTags": [],
            "retainMetadata": {},
        }
        calls = []
        operation_statuses = {}

        class FakeClient:
            def retain(self, **kwargs):
                calls.append(kwargs)
                operation_statuses[kwargs["operation_id"]] = "completed"
                return {
                    "success": True,
                    "operation_id": kwargs["operation_id"],
                }

            def get_operation_status(self, _bank_id, operation_id, timeout=5):
                return {"status": operation_statuses[operation_id]}

        with tempfile.TemporaryDirectory() as temp_dir:
            transcript_path = pathlib.Path(temp_dir) / "rollout.jsonl"
            initial_messages = [
                {"role": "user", "content": "first question"},
                {"role": "assistant", "content": "first answer"},
            ]
            initial_entries = [
                initial_messages[0],
                {
                    "type": "response_item",
                    "payload": {
                        "type": "function_call",
                        "name": "shell",
                        "arguments": '{"command":"ignored"}',
                    },
                },
                {
                    "type": "response_item",
                    "payload": {
                        "type": "function_call_output",
                        "output": "ignored tool output",
                    },
                },
                initial_messages[1],
            ]
            transcript_path.write_text(
                "".join(json.dumps(entry) + "\n" for entry in initial_entries),
                encoding="utf-8",
            )
            hook_input = json.dumps(
                {
                    "session_id": "session-1",
                    "transcript_path": str(transcript_path),
                    "cwd": temp_dir,
                }
            )

            patches = (
                mock.patch.object(retain, "load_config", return_value=config),
                mock.patch.object(retain, "get_api_url", return_value="https://example.com"),
                mock.patch.object(retain, "HindsightClient", return_value=FakeClient()),
                mock.patch.object(retain, "derive_bank_id", return_value="hangil-ai"),
                mock.patch.object(retain, "ensure_bank_mission"),
                mock.patch.dict(os.environ, {"HOME": temp_dir}),
            )
            with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5]:
                with mock.patch("sys.stdin", io.StringIO(hook_input)):
                    retain.main()

                later_messages = initial_messages + [
                    {"role": "user", "content": "second question"},
                    {"role": "assistant", "content": "second answer"},
                ]
                transcript_path.write_text(
                    "".join(json.dumps(message) + "\n" for message in later_messages),
                    encoding="utf-8",
                )
                with mock.patch("sys.stdin", io.StringIO(hook_input)):
                    retain.main()

        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["update_mode"], "replace")
        self.assertIn("first question", calls[0]["content"])
        self.assertNotIn("ignored tool output", calls[0]["content"])
        self.assertEqual(calls[1]["update_mode"], "append")
        self.assertNotIn("first question", calls[1]["content"])
        self.assertIn("second question", calls[1]["content"])
        self.assertNotEqual(calls[0]["operation_id"], calls[1]["operation_id"])

    def test_session_end_forces_final_retain_before_cadence(self):
        config = {
            "autoRetain": True,
            "retainMode": "incremental",
            "retainEveryNTurns": 5,
            "retainToolCalls": False,
            "retainRoles": ["user", "assistant"],
            "retainContext": "codex",
            "retainTags": [],
            "retainMetadata": {},
            "sessionEndFinalRetain": True,
        }
        calls = []

        class FakeClient:
            def retain(self, **kwargs):
                calls.append(kwargs)
                return {
                    "success": True,
                    "operation_id": kwargs["operation_id"],
                }

        with tempfile.TemporaryDirectory() as temp_dir:
            transcript_path = pathlib.Path(temp_dir) / "conversation.jsonl"
            transcript_path.write_text(
                "\n".join(
                    [
                        json.dumps({"role": "user", "content": "last question"}),
                        json.dumps({"role": "assistant", "content": "last answer"}),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            hook_input = json.dumps(
                {
                    "session_id": "claude-session",
                    "transcript_path": str(transcript_path),
                    "cwd": temp_dir,
                    "hook_event_name": "SessionEnd",
                }
            )

            with (
                mock.patch.object(retain, "load_config", return_value=config),
                mock.patch.object(
                    retain,
                    "get_api_url",
                    return_value="https://example.com",
                ),
                mock.patch.object(
                    retain,
                    "HindsightClient",
                    return_value=FakeClient(),
                ),
                mock.patch.object(retain, "derive_bank_id", return_value="hangil-ai"),
                mock.patch.object(retain, "ensure_bank_mission"),
                mock.patch.dict(os.environ, {"HOME": temp_dir}),
                mock.patch("sys.stdin", io.StringIO(hook_input)),
            ):
                retain.main()

        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["update_mode"], "replace")
        self.assertIn("last question", calls[0]["content"])

    def test_lost_ack_is_not_submitted_as_a_second_operation(self):
        config = {
            "autoRetain": True,
            "retainMode": "incremental",
            "retainEveryNTurns": 1,
            "retainToolCalls": False,
            "retainRoles": ["user", "assistant"],
            "retainContext": "codex",
            "retainTags": [],
            "retainMetadata": {},
        }
        calls = []
        accepted_operations = set()

        class FakeClient:
            def retain(self, **kwargs):
                calls.append(kwargs)
                accepted_operations.add(kwargs["operation_id"])
                raise TimeoutError("acknowledgement lost")

            def get_operation_status(self, _bank_id, operation_id, timeout=5):
                if operation_id in accepted_operations:
                    return {"status": "processing"}
                raise RuntimeError("not found")

        with tempfile.TemporaryDirectory() as temp_dir:
            transcript_path = pathlib.Path(temp_dir) / "conversation.jsonl"
            transcript_path.write_text(
                "\n".join(
                    [
                        json.dumps({"role": "user", "content": "question"}),
                        json.dumps({"role": "assistant", "content": "answer"}),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            hook_input = json.dumps(
                {
                    "session_id": "lost-ack-session",
                    "transcript_path": str(transcript_path),
                    "cwd": temp_dir,
                }
            )

            with (
                mock.patch.object(retain, "load_config", return_value=config),
                mock.patch.object(
                    retain,
                    "get_api_url",
                    return_value="https://example.com",
                ),
                mock.patch.object(
                    retain,
                    "HindsightClient",
                    return_value=FakeClient(),
                ),
                mock.patch.object(retain, "derive_bank_id", return_value="hangil-ai"),
                mock.patch.object(retain, "ensure_bank_mission"),
                mock.patch.dict(os.environ, {"HOME": temp_dir}),
            ):
                with mock.patch("sys.stdin", io.StringIO(hook_input)):
                    retain.main()
                with mock.patch("sys.stdin", io.StringIO(hook_input)):
                    retain.main()

        self.assertEqual(len(calls), 1)

    def test_failed_async_retain_recovers_into_full_replace_segment(self):
        config = {
            "autoRetain": True,
            "retainMode": "incremental",
            "retainEveryNTurns": 1,
            "retainToolCalls": False,
            "retainRoles": ["user", "assistant"],
            "retainContext": "codex",
            "retainTags": [],
            "retainMetadata": {},
        }
        calls = []
        operation_statuses = {}

        class FakeClient:
            def retain(self, **kwargs):
                calls.append(kwargs)
                operation_statuses[kwargs["operation_id"]] = (
                    "failed" if len(calls) == 1 else "processing"
                )
                return {
                    "success": True,
                    "operation_id": kwargs["operation_id"],
                }

            def get_operation_status(self, _bank_id, operation_id, timeout=5):
                return {"status": operation_statuses[operation_id]}

        with tempfile.TemporaryDirectory() as temp_dir:
            transcript_path = pathlib.Path(temp_dir) / "conversation.jsonl"
            first_messages = [
                {"role": "user", "content": "first question"},
                {"role": "assistant", "content": "first answer"},
            ]
            transcript_path.write_text(
                "".join(json.dumps(message) + "\n" for message in first_messages),
                encoding="utf-8",
            )
            hook_input = json.dumps(
                {
                    "session_id": "failed-session",
                    "transcript_path": str(transcript_path),
                    "cwd": temp_dir,
                }
            )

            with (
                mock.patch.object(retain, "load_config", return_value=config),
                mock.patch.object(
                    retain,
                    "get_api_url",
                    return_value="https://example.com",
                ),
                mock.patch.object(
                    retain,
                    "HindsightClient",
                    return_value=FakeClient(),
                ),
                mock.patch.object(retain, "derive_bank_id", return_value="hangil-ai"),
                mock.patch.object(retain, "ensure_bank_mission"),
                mock.patch.dict(os.environ, {"HOME": temp_dir}),
            ):
                with mock.patch("sys.stdin", io.StringIO(hook_input)):
                    retain.main()

                later_messages = first_messages + [
                    {"role": "user", "content": "second question"},
                    {"role": "assistant", "content": "second answer"},
                ]
                transcript_path.write_text(
                    "".join(
                        json.dumps(message) + "\n"
                        for message in later_messages
                    ),
                    encoding="utf-8",
                )
                with mock.patch("sys.stdin", io.StringIO(hook_input)):
                    retain.main()

        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1]["update_mode"], "replace")
        self.assertEqual(
            calls[1]["document_id"],
            "failed-session-segment-1",
        )
        self.assertIn("first question", calls[1]["content"])
        self.assertIn("second question", calls[1]["content"])


if __name__ == "__main__":
    unittest.main()
