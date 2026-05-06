#!/usr/bin/env python3
import argparse
import json
import math
import os
import struct
import subprocess
import wave
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")


def run(cmd):
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        raise RuntimeError("Command failed:\n" + " ".join(cmd) + "\n" + proc.stderr[-4000:])
    return proc


def ffprobe_json(path, entries, streams=None):
    cmd = [FFPROBE, "-v", "error"]
    if streams:
        cmd.extend(["-select_streams", streams])
    cmd.extend(["-show_entries", entries, "-of", "json", str(path)])
    return json.loads(subprocess.check_output(cmd, text=True))


def duration(path):
    data = ffprobe_json(path, "format=duration")
    return float(data["format"]["duration"])


def has_audio(path):
    data = ffprobe_json(path, "stream=codec_type", "a:0")
    return bool(data.get("streams"))


def encode_args_videotoolbox(bitrate):
    return [
        "-c:v",
        "h264_videotoolbox",
        "-allow_sw",
        "1",
        "-b:v",
        bitrate,
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
    ]


def encode_args_x264(crf):
    return ["-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf), "-pix_fmt", "yuv420p"]


def clip_video_filter(fps, color_grade):
    filters = [
        "scale=1920:1080:force_original_aspect_ratio=decrease",
        "pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
        "setsar=1",
        f"fps={fps}",
    ]
    if color_grade:
        filters.append("eq=contrast=1.035:saturation=1.08:brightness=0.006")
    filters.append("format=yuv420p")
    return ",".join(filters)


def encode_with_fallback(base_cmd, out_path, bitrate, crf):
    cmd = base_cmd + encode_args_videotoolbox(bitrate) + [
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        str(out_path),
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode == 0:
        return
    cmd = base_cmd + encode_args_x264(crf) + [
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        str(out_path),
    ]
    run(cmd)


def extract_cover_frame(source, time_sec, out_png):
    vf = "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080"
    run(
        [
            FFMPEG,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{time_sec:.3f}",
            "-i",
            str(source),
            "-frames:v",
            "1",
            "-vf",
            vf,
            str(out_png),
        ]
    )


def make_title_card(config, work_dir):
    title_png = work_dir / "title_card.png"
    cover = config["cover"]
    raw_cover = work_dir / "title_cover_raw.png"
    extract_cover_frame(cover["file"], float(cover.get("time", 0)), raw_cover)

    img = Image.open(raw_cover).convert("RGB")
    overlay = Image.new("RGB", img.size, (0, 0, 0))
    img = Image.blend(img, overlay, 0.38)
    draw = ImageDraw.Draw(img)

    font_candidates = [
        "/System/Library/Fonts/AppleSDGothicNeo.ttc",
        "/System/Library/Fonts/Supplemental/NotoSansGothic-Regular.ttf",
        "/System/Library/Fonts/Supplemental/AppleGothic.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ]
    font_path = next((p for p in font_candidates if Path(p).exists()), font_candidates[-1])
    title_font = ImageFont.truetype(font_path, int(config.get("title_font_size", 82)))
    sub_font = ImageFont.truetype(font_path, int(config.get("subtitle_font_size", 38)))

    title = config.get("title", "HIGHLIGHTS")
    subtitle = config.get("subtitle", "")
    y = int(config.get("title_y", 430))
    for text, font, fill, offset in [
        (title, title_font, (255, 255, 255), 0),
        (subtitle, sub_font, (232, 232, 232), 105),
    ]:
        if not text:
            continue
        bbox = draw.textbbox((0, 0), text, font=font)
        x = (img.width - (bbox[2] - bbox[0])) // 2
        draw.text((x, y + offset), text, font=font, fill=fill)

    img.save(title_png, quality=95)
    return title_png


def render_title(title_png, out_path, fps, title_duration, bitrate, crf):
    base = [
        FFMPEG,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-loop",
        "1",
        "-t",
        f"{title_duration:.3f}",
        "-i",
        str(title_png),
        "-f",
        "lavfi",
        "-t",
        f"{title_duration:.3f}",
        "-i",
        "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-vf",
        f"fps={fps},format=yuv420p",
        "-shortest",
    ]
    encode_with_fallback(base, out_path, bitrate, crf)


def render_clip(clip, out_path, fps, bitrate, crf, color_grade=True):
    source = Path(clip["file"])
    start = float(clip["start"])
    dur = float(clip["duration"])
    vf = clip_video_filter(fps, color_grade)

    if has_audio(source):
        base = [
            FFMPEG,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{start:.3f}",
            "-t",
            f"{dur:.3f}",
            "-i",
            str(source),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0",
            "-vf",
            vf,
            "-af",
            "aresample=async=1:first_pts=0",
            "-shortest",
        ]
    else:
        base = [
            FFMPEG,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{start:.3f}",
            "-t",
            f"{dur:.3f}",
            "-i",
            str(source),
            "-f",
            "lavfi",
            "-t",
            f"{dur:.3f}",
            "-i",
            "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-vf",
            vf,
            "-shortest",
        ]
    encode_with_fallback(base, out_path, bitrate, crf)


def make_generated_ambient_bgm(out_path, total_duration, volume=0.018, sample_rate=48000):
    total_frames = max(1, int(total_duration * sample_rate))
    fade_frames = max(1, int(min(2.5, total_duration / 3) * sample_rate))
    frequencies = (110.0, 146.83, 196.0, 246.94)

    with wave.open(str(out_path), "w") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        for frame in range(total_frames):
            t = frame / sample_rate
            env = min(1.0, frame / fade_frames, (total_frames - frame) / fade_frames)
            slow = 0.72 + 0.28 * math.sin(2 * math.pi * 0.035 * t)
            left = 0.0
            right = 0.0
            for idx, freq in enumerate(frequencies):
                phase = 0.19 * idx
                tone = math.sin(2 * math.pi * freq * t + phase)
                left += tone * (0.55 if idx % 2 == 0 else 0.35)
                right += tone * (0.35 if idx % 2 == 0 else 0.55)
            left_sample = int(max(-1.0, min(1.0, left * volume * env * slow)) * 32767)
            right_sample = int(max(-1.0, min(1.0, right * volume * env * slow)) * 32767)
            wav.writeframes(struct.pack("<hh", left_sample, right_sample))


def escape_filter_arg(value):
    return str(value).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def build_crossfade(
    rendered,
    durations,
    output,
    transition,
    ambient_bgm=None,
    bgm_volume=0.16,
    fade_duration=1.5,
    subtitle_file=None,
    subtitle_style=None,
):
    inputs = []
    for path in rendered:
        inputs.extend(["-i", str(path)])
    if ambient_bgm:
        inputs.extend(["-i", str(ambient_bgm)])

    filters = []
    for i in range(len(rendered)):
        filters.append(f"[{i}:v]settb=AVTB,setpts=PTS-STARTPTS[v{i}]")
        filters.append(f"[{i}:a]asetpts=PTS-STARTPTS[a{i}]")

    current_v = "v0"
    current_a = "a0"
    current_duration = durations[0]
    for i in range(1, len(rendered)):
        offset = max(0.1, current_duration - transition)
        next_v = f"vx{i}"
        next_a = f"ax{i}"
        filters.append(
            f"[{current_v}][v{i}]xfade=transition=fade:duration={transition:.3f}:offset={offset:.3f}[{next_v}]"
        )
        filters.append(f"[{current_a}][a{i}]acrossfade=d={transition:.3f}:c1=tri:c2=tri[{next_a}]")
        current_v = next_v
        current_a = next_a
        current_duration += durations[i] - transition

    video_out = current_v
    audio_out = current_a
    if subtitle_file:
        style = subtitle_style or "FontSize=18,MarginV=22,Alignment=2,Outline=1,Shadow=0"
        subtitled_v = "vsub"
        filters.append(
            f"[{video_out}]subtitles='{escape_filter_arg(subtitle_file)}':force_style='{escape_filter_arg(style)}'[{subtitled_v}]"
        )
        video_out = subtitled_v
    if fade_duration > 0:
        fade_start = max(0.0, current_duration - fade_duration)
        faded_v = "vfade"
        faded_a = "afade"
        filters.append(f"[{video_out}]fade=t=out:st={fade_start:.3f}:d={fade_duration:.3f}[{faded_v}]")
        filters.append(f"[{audio_out}]afade=t=out:st={fade_start:.3f}:d={fade_duration:.3f}[{faded_a}]")
        video_out = faded_v
        audio_out = faded_a
    if ambient_bgm:
        bgm_index = len(rendered)
        mixed_a = "amixout"
        filters.append(f"[{bgm_index}:a]volume={bgm_volume:.3f}[bgm]")
        filters.append(f"[{audio_out}][bgm]amix=inputs=2:duration=first:dropout_transition=0[{mixed_a}]")
        audio_out = mixed_a

    base = [
        FFMPEG,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        *inputs,
        "-filter_complex",
        ";".join(filters),
        "-map",
        f"[{video_out}]",
        "-map",
        f"[{audio_out}]",
    ]
    cmd = base + [
        "-c:v",
        "h264_videotoolbox",
        "-allow_sw",
        "1",
        "-b:v",
        "16M",
        "-profile:v",
        "high",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-movflags",
        "+faststart",
        str(output),
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode == 0:
        return
    run(
        base
        + [
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "19",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-movflags",
            "+faststart",
            str(output),
        ]
    )


def make_preview_sheet(video, out_path):
    run(
        [
            FFMPEG,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(video),
            "-vf",
            "fps=1/10,scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2,tile=4x4,format=yuvj420p",
            "-frames:v",
            "1",
            str(out_path),
        ]
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()

    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    work_dir = Path(config.get("work_dir", Path(config["output"]).with_suffix("")))
    work_dir.mkdir(parents=True, exist_ok=True)
    clip_dir = work_dir / "rendered"
    clip_dir.mkdir(exist_ok=True)

    fps = int(config.get("fps", 60))
    transition = float(config.get("transition", 0.8))
    bitrate = config.get("bitrate", "16M")
    crf = int(config.get("crf", 19))
    title_duration = float(config.get("title_duration", 2.0))
    color_grade = bool(config.get("color_grade", True))
    ambient_bgm_enabled = bool(config.get("ambient_bgm", True))
    ambient_bgm_volume = float(config.get("ambient_bgm_volume", 0.16))
    ending_fade_duration = float(config.get("ending_fade_duration", 1.5))
    subtitle_file = config.get("subtitles") or config.get("subtitle_file")
    subtitle_style = config.get("subtitle_style")

    for old in clip_dir.glob("*.mp4"):
        old.unlink()

    rendered = []
    rendered_durations = []
    title_png = make_title_card(config, work_dir)
    title_mp4 = clip_dir / "000_title.mp4"
    render_title(title_png, title_mp4, fps, title_duration, bitrate, crf)
    rendered.append(title_mp4)
    rendered_durations.append(title_duration)
    print(f"rendered title: {title_mp4}", flush=True)

    for idx, clip in enumerate(config["clips"], 1):
        out = clip_dir / f"{idx:03d}.mp4"
        render_clip(clip, out, fps, bitrate, crf, color_grade=color_grade)
        rendered.append(out)
        rendered_durations.append(float(clip["duration"]))
        print(f"rendered {idx:02d}/{len(config['clips']):02d}: {Path(clip['file']).name}", flush=True)

    output = Path(config["output"])
    tmp_output = output.with_suffix(".tmp.mp4")
    if tmp_output.exists():
        tmp_output.unlink()
    total_duration = sum(rendered_durations) - (transition * max(0, len(rendered_durations) - 1))
    ambient_bgm = None
    if ambient_bgm_enabled:
        ambient_bgm = work_dir / "generated_ambient_bgm.wav"
        make_generated_ambient_bgm(ambient_bgm, total_duration)
    build_crossfade(
        rendered,
        rendered_durations,
        tmp_output,
        transition,
        ambient_bgm=ambient_bgm,
        bgm_volume=ambient_bgm_volume,
        fade_duration=ending_fade_duration,
        subtitle_file=subtitle_file,
        subtitle_style=subtitle_style,
    )
    tmp_output.replace(output)

    preview = Path(config.get("preview", str(work_dir / "preview_sheet.jpg")))
    make_preview_sheet(output, preview)

    info = ffprobe_json(output, "stream=width,height,r_frame_rate,avg_frame_rate,codec_name:format=duration,size", "v:0")
    print(json.dumps({"output": str(output), "preview": str(preview), "ffprobe": info}, indent=2), flush=True)


if __name__ == "__main__":
    main()
