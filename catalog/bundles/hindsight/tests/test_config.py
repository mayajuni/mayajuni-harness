import os
import pathlib
import sys
import tempfile
import unittest
import json
from unittest import mock


SCRIPTS_DIR = pathlib.Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS_DIR))

from lib import config as config_module
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


class ProjectSecretConfigTests(unittest.TestCase):
    def test_project_secret_wins_and_environment_is_the_fallback(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = pathlib.Path(temp_dir)
            install_root = root / "bundle"
            fake_config_path = install_root / "scripts" / "lib" / "config.py"
            fake_config_path.parent.mkdir(parents=True)
            (install_root / "secrets.json").write_text(
                json.dumps({"hindsightApiToken": "project-token"})
            )
            user_config_dir = root / ".hindsight"
            user_config_dir.mkdir()
            (user_config_dir / "codex.json").write_text(
                json.dumps({"hindsightApiToken": "user-token"})
            )

            with mock.patch.object(config_module, "__file__", str(fake_config_path)):
                with mock.patch.dict(os.environ, {"HOME": temp_dir}, clear=True):
                    self.assertEqual(
                        load_config()["hindsightApiToken"],
                        "project-token",
                    )

                with mock.patch.dict(
                    os.environ,
                    {
                        "HOME": temp_dir,
                        "HINDSIGHT_API_TOKEN": "environment-token",
                    },
                    clear=True,
                ):
                    self.assertEqual(
                        load_config()["hindsightApiToken"],
                        "project-token",
                    )

                (install_root / "secrets.json").unlink()
                with mock.patch.dict(
                    os.environ,
                    {
                        "HOME": temp_dir,
                        "HINDSIGHT_API_TOKEN": "environment-token",
                    },
                    clear=True,
                ):
                    self.assertEqual(
                        load_config()["hindsightApiToken"],
                        "environment-token",
                    )


if __name__ == "__main__":
    unittest.main()
