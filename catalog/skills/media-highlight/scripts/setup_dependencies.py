#!/usr/bin/env python3
import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path


FFMPEG_FULL = Path("/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg")
FFPROBE_FULL = Path("/opt/homebrew/opt/ffmpeg-full/bin/ffprobe")
WHISPER_CLI = Path("/opt/homebrew/opt/whisper-cpp/bin/whisper-cli")
MODEL_DIR = Path(os.environ.get("VIDEO_HIGHLIGHT_MODEL_DIR", Path.home() / ".cache" / "video-highlight" / "models")).expanduser()
MODEL_PATH = MODEL_DIR / "ggml-medium.bin"
MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin"


def run(cmd, check=True):
    print("+", " ".join(map(str, cmd)), flush=True)
    return subprocess.run(cmd, check=check)


def command_exists(name):
    return shutil.which(name) is not None


def ensure_brew():
    if not command_exists("brew"):
        raise SystemExit("Homebrew is required to install ffmpeg-full and whisper-cpp. Install Homebrew first.")


def ensure_formula(formula, expected_path):
    if Path(expected_path).exists():
        print(f"ok: {formula}", flush=True)
        return
    ensure_brew()
    run(["brew", "install", formula])
    if not Path(expected_path).exists():
        raise SystemExit(f"Installed {formula}, but expected path is missing: {expected_path}")


def ensure_python_package(module_name, package_name):
    if importlib.util.find_spec(module_name) is not None:
        print(f"ok: {package_name}", flush=True)
        return
    if not command_exists("pip3"):
        raise SystemExit(f"pip3 is required to install {package_name}.")
    run(["pip3", "install", "--user", package_name])
    if importlib.util.find_spec(module_name) is None:
        raise SystemExit(f"{package_name} installation did not become importable in this Python.")


def ensure_photo_packages():
    ensure_python_package("PIL", "Pillow")
    ensure_python_package("pillow_heif", "pillow-heif")


def ensure_model():
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    if MODEL_PATH.exists() and MODEL_PATH.stat().st_size > 1_000_000_000:
        print(f"ok: Whisper model {MODEL_PATH}", flush=True)
        return
    if not command_exists("curl"):
        raise SystemExit("curl is required to download the Whisper model.")
    run(["curl", "-L", "--fail", "--continue-at", "-", "-o", str(MODEL_PATH), MODEL_URL])
    if not MODEL_PATH.exists() or MODEL_PATH.stat().st_size <= 1_000_000_000:
        raise SystemExit(f"Whisper model download looks incomplete: {MODEL_PATH}")


def verify_ffmpeg_filters():
    proc = subprocess.run(
        [str(FFMPEG_FULL), "-hide_banner", "-filters"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=True,
    )
    required = ["drawtext", "subtitles", "xfade", "acrossfade"]
    missing = [name for name in required if name not in proc.stdout]
    if missing:
        raise SystemExit(f"ffmpeg-full is missing required filters: {', '.join(missing)}")
    print("ok: ffmpeg-full filters", flush=True)


def main():
    ensure_formula("ffmpeg-full", FFMPEG_FULL)
    ensure_formula("whisper-cpp", WHISPER_CLI)
    if not FFPROBE_FULL.exists():
        raise SystemExit(f"ffprobe from ffmpeg-full is missing: {FFPROBE_FULL}")
    ensure_photo_packages()
    ensure_model()
    verify_ffmpeg_filters()
    print("\nmedia-highlight dependencies are ready.")
    print(f"FFMPEG={FFMPEG_FULL}")
    print(f"FFPROBE={FFPROBE_FULL}")
    print(f"WHISPER={WHISPER_CLI}")
    print(f"WHISPER_MODEL={MODEL_PATH}")


if __name__ == "__main__":
    main()
