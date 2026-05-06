#!/usr/bin/env python3
import argparse
import os
import subprocess
from pathlib import Path

DEFAULT_MODEL = (
    Path(os.environ.get("VIDEO_HIGHLIGHT_MODEL_DIR", Path.home() / ".cache" / "video-highlight" / "models")).expanduser()
    / "ggml-medium.bin"
)


def run(cmd):
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        raise RuntimeError("Command failed:\n" + " ".join(cmd) + "\n" + proc.stderr[-4000:])
    return proc


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument(
        "--model",
        default=os.environ.get("WHISPER_MODEL", str(DEFAULT_MODEL)),
        help="Whisper model path. Defaults to multilingual ggml-medium.bin.",
    )
    parser.add_argument("--language", default="ko")
    parser.add_argument("--ffmpeg", default="/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg")
    parser.add_argument("--whisper", default="/opt/homebrew/opt/whisper-cpp/bin/whisper-cli")
    parser.add_argument("--prefix", default="stt")
    args = parser.parse_args()

    work_dir = Path(args.work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    model = Path(args.model).expanduser()
    if not model.exists():
        raise SystemExit(
            f"Missing STT model: {model}\n"
            "Default model is whisper.cpp multilingual ggml-medium.bin. "
            "Run scripts/setup_dependencies.py or set WHISPER_MODEL explicitly."
        )
    wav = work_dir / "audio.wav"
    out_prefix = work_dir / args.prefix

    run(
        [
            args.ffmpeg,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            args.video,
            "-vn",
            "-ar",
            "16000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s16le",
            str(wav),
        ]
    )
    run(
        [
            args.whisper,
            "-m",
            str(model),
            "-f",
            str(wav),
            "-l",
            args.language,
            "-sow",
            "-oj",
            "-ojf",
            "-osrt",
            "-owts",
            "-of",
            str(out_prefix),
            "--print-progress",
        ]
    )
    print(f"wrote {out_prefix}.json, {out_prefix}.srt, and word-timing helpers")


if __name__ == "__main__":
    main()
