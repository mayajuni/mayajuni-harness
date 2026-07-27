import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock


SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from lib.config import load_config


class AgentProfileConfigTests(unittest.TestCase):
    def _load_for(self, agent_name: str) -> dict:
        with tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch.dict(
                os.environ,
                {
                    "HOME": temp_dir,
                    "HINDSIGHT_AGENT_NAME": agent_name,
                },
                clear=True,
            ):
                return load_config()

    def test_codex_profile_keeps_three_turn_cadence(self):
        config = self._load_for("codex")

        self.assertEqual(config["recallTypes"], ["observation", "world"])
        self.assertEqual(config["recallMaxTokens"], 256)
        self.assertEqual(config["retainMode"], "incremental")
        self.assertEqual(config["retainEveryNTurns"], 3)
        self.assertFalse(config["retainToolCalls"])
        self.assertFalse(config["sessionEndFinalRetain"])

    def test_claude_profile_uses_final_retain(self):
        config = self._load_for("claude-code")

        self.assertEqual(config["recallTypes"], ["observation", "world"])
        self.assertEqual(config["recallMaxTokens"], 256)
        self.assertEqual(config["retainMode"], "incremental")
        self.assertEqual(config["retainEveryNTurns"], 5)
        self.assertFalse(config["retainToolCalls"])
        self.assertTrue(config["sessionEndFinalRetain"])


if __name__ == "__main__":
    unittest.main()
