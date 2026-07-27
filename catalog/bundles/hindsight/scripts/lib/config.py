"""Configuration management for Hindsight Codex plugin.

Loads settings from settings.json (plugin defaults) merged with environment
variable overrides. Full config schema matching Openclaw's 30+ options.
"""

import json
import os
import sys

DEFAULTS = {
    # Recall
    "autoRecall": True,
    "recallBudget": "mid",
    "recallMaxTokens": 1024,
    "recallTimeout": 10,
    "recallTypes": ["world", "experience"],
    "recallContextTurns": 1,
    "recallMaxQueryChars": 800,
    "recallRoles": ["user", "assistant"],
    "recallMinScores": {},
    "recallBrowseFallback": True,
    "recallBrowseMaxQueries": 6,
    "recallBrowseLimit": 25,
    "recallBrowseTimeout": 3,
    "recallMaxResults": 4,
    "recallContextMaxChars": 1200,
    "recallMinLexicalScore": 6,
    "recallRankMaxTerms": 16,
    "recallPromptPreamble": (
        "Relevant memories from past conversations (prioritize recent when "
        "conflicting). Only use memories that are directly useful to continue "
        "this conversation; ignore the rest:"
    ),
    # Retain
    "autoRetain": True,
    "retainMode": "full-session",
    "retainRoles": ["user", "assistant"],
    "retainEveryNTurns": 10,
    "retainOverlapTurns": 2,
    "retainContext": "codex",
    "retainTags": [],
    "retainMetadata": {},
    "retainToolCalls": False,
    "sessionEndFinalRetain": False,
    # Connection
    "hindsightApiUrl": None,
    "hindsightApiToken": None,
    "apiPort": 9077,
    "daemonIdleTimeout": 0,
    "embedVersion": "latest",
    "embedPackagePath": None,
    # Bank
    "bankId": None,
    "bankIdPrefix": "",
    "dynamicBankId": False,
    "dynamicBankGranularity": ["agent", "project"],
    "bankMission": "",
    "retainMission": None,
    "agentName": "codex",
    # LLM (for daemon mode)
    "llmProvider": None,
    "llmModel": None,
    "llmApiKeyEnv": None,
    # Misc
    "debug": False,
}

# Map env var names to config keys and their types
ENV_OVERRIDES = {
    "HINDSIGHT_API_URL": ("hindsightApiUrl", str),
    "HINDSIGHT_API_TOKEN": ("hindsightApiToken", str),
    "HINDSIGHT_BANK_ID": ("bankId", str),
    "HINDSIGHT_AGENT_NAME": ("agentName", str),
    "HINDSIGHT_AUTO_RECALL": ("autoRecall", bool),
    "HINDSIGHT_AUTO_RETAIN": ("autoRetain", bool),
    "HINDSIGHT_RETAIN_MODE": ("retainMode", str),
    "HINDSIGHT_RETAIN_EVERY_N_TURNS": ("retainEveryNTurns", int),
    "HINDSIGHT_RETAIN_TOOL_CALLS": ("retainToolCalls", bool),
    "HINDSIGHT_SESSION_END_FINAL_RETAIN": ("sessionEndFinalRetain", bool),
    "HINDSIGHT_RECALL_BUDGET": ("recallBudget", str),
    "HINDSIGHT_RECALL_MAX_TOKENS": ("recallMaxTokens", int),
    "HINDSIGHT_RECALL_TIMEOUT": ("recallTimeout", int),
    "HINDSIGHT_RECALL_MAX_QUERY_CHARS": ("recallMaxQueryChars", int),
    "HINDSIGHT_RECALL_CONTEXT_TURNS": ("recallContextTurns", int),
    "HINDSIGHT_RECALL_BROWSE_FALLBACK": ("recallBrowseFallback", bool),
    "HINDSIGHT_RECALL_BROWSE_MAX_QUERIES": ("recallBrowseMaxQueries", int),
    "HINDSIGHT_RECALL_BROWSE_LIMIT": ("recallBrowseLimit", int),
    "HINDSIGHT_RECALL_BROWSE_TIMEOUT": ("recallBrowseTimeout", int),
    "HINDSIGHT_RECALL_MAX_RESULTS": ("recallMaxResults", int),
    "HINDSIGHT_RECALL_CONTEXT_MAX_CHARS": ("recallContextMaxChars", int),
    "HINDSIGHT_RECALL_MIN_LEXICAL_SCORE": ("recallMinLexicalScore", int),
    "HINDSIGHT_RECALL_RANK_MAX_TERMS": ("recallRankMaxTerms", int),
    "HINDSIGHT_API_PORT": ("apiPort", int),
    "HINDSIGHT_DAEMON_IDLE_TIMEOUT": ("daemonIdleTimeout", int),
    "HINDSIGHT_EMBED_VERSION": ("embedVersion", str),
    "HINDSIGHT_EMBED_PACKAGE_PATH": ("embedPackagePath", str),
    "HINDSIGHT_DYNAMIC_BANK_ID": ("dynamicBankId", bool),
    "HINDSIGHT_BANK_MISSION": ("bankMission", str),
    "HINDSIGHT_LLM_PROVIDER": ("llmProvider", str),
    "HINDSIGHT_LLM_MODEL": ("llmModel", str),
    "HINDSIGHT_DEBUG": ("debug", bool),
}


def _cast_env(value: str, typ):
    """Cast environment variable string to target type. Returns None on failure."""
    try:
        if typ is bool:
            return value.lower() in ("true", "1", "yes")
        if typ is int:
            return int(value)
        return value
    except (ValueError, AttributeError):
        return None


def _agent_profile(file_config: dict, agent_name: str) -> dict:
    """Return the agent-specific settings overlay for the current harness."""
    normalized = str(agent_name or "codex").lower().replace("-", "").replace("_", "")
    profile_names = ["claudeCode", "claude-code"] if normalized == "claudecode" else ["codex"]
    containers = [file_config]
    if isinstance(file_config.get("agentProfiles"), dict):
        containers.append(file_config["agentProfiles"])

    merged = {}
    for container in containers:
        for profile_name in profile_names:
            profile = container.get(profile_name)
            if isinstance(profile, dict):
                merged.update({k: v for k, v in profile.items() if v is not None})
    return merged


def _load_settings_file(path: str, config: dict) -> None:
    """Merge common settings and the current agent profile into config."""
    if not os.path.exists(path):
        return
    try:
        with open(path) as f:
            file_config = json.load(f)
        profile_keys = {"codex", "claudeCode", "claude-code", "agentProfiles"}
        config.update(
            {
                k: v
                for k, v in file_config.items()
                if v is not None and k not in profile_keys
            }
        )
        agent_name = os.environ.get("HINDSIGHT_AGENT_NAME", config.get("agentName", "codex"))
        config.update(_agent_profile(file_config, agent_name))
    except (json.JSONDecodeError, OSError) as e:
        debug_log(config, f"Failed to load {path}: {e}")


def load_config() -> dict:
    """Load plugin configuration from settings.json + env overrides.

    Loading order (later entries win):
      1. Built-in defaults
      2. Plugin install settings.json  (~/.hindsight/codex/settings.json)
      3. User config                   (~/.hindsight/codex.json)
      4. Environment variable overrides

    ~/.hindsight/codex.json is the recommended place to configure the
    plugin — stable across updates.
    """
    config = dict(DEFAULTS)

    # 1. Plugin install settings.json (written by get-codex installer)
    install_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    _load_settings_file(os.path.join(install_root, "settings.json"), config)

    # 2. User config — stable, version-independent
    user_config_path = os.path.join(os.path.expanduser("~"), ".hindsight", "codex.json")
    _load_settings_file(user_config_path, config)

    # Apply environment variable overrides
    for env_name, (key, typ) in ENV_OVERRIDES.items():
        val = os.environ.get(env_name)
        if val is not None:
            cast_val = _cast_env(val, typ)
            if cast_val is not None:
                config[key] = cast_val

    return config


def debug_log(config: dict, *args):
    """Log to stderr if debug mode is enabled."""
    if config.get("debug"):
        print("[Hindsight]", *args, file=sys.stderr)
