#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
from datetime import datetime
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps, ImageStat

DEFAULT_FFMPEG = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"
DEFAULT_FFPROBE = "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe"
FFMPEG = os.environ.get("FFMPEG", DEFAULT_FFMPEG if Path(DEFAULT_FFMPEG).exists() else "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", DEFAULT_FFPROBE if Path(DEFAULT_FFPROBE).exists() else "ffprobe")
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".tif", ".tiff", ".webp"}
VIDEO_EXTENSIONS = {".mov", ".mp4", ".m4v", ".avi", ".mkv", ".mts", ".m2ts", ".3gp"}
EXIF_DATE_TAGS = (36867, 36868, 306)

try:
    from pillow_heif import register_heif_opener

    register_heif_opener()
except Exception:
    pass


def run(cmd, check=True):
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if check and proc.returncode != 0:
        raise RuntimeError("Command failed:\n" + " ".join(cmd) + "\n" + proc.stderr[-2000:])
    return proc


def ffprobe_json(path, entries, streams=None):
    cmd = [FFPROBE, "-v", "error"]
    if streams:
        cmd.extend(["-select_streams", streams])
    cmd.extend(["-show_entries", entries, "-of", "json", str(path)])
    proc = run(cmd)
    return json.loads(proc.stdout)


def iter_media(inputs):
    for root in inputs:
        root = Path(root).expanduser()
        if root.is_file():
            candidates = [root]
        else:
            candidates = sorted(p for p in root.rglob("*") if p.is_file())
        for path in candidates:
            suffix = path.suffix.lower()
            if suffix in IMAGE_EXTENSIONS:
                yield "photo", path
            elif suffix in VIDEO_EXTENSIONS:
                yield "video", path


def parse_exif_datetime(value):
    if not value:
        return None
    text = str(value)
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(text, fmt).isoformat(sep=" ")
        except ValueError:
            pass
    return text


def image_dhash(img):
    small = ImageOps.grayscale(img.resize((9, 8), Image.Resampling.LANCZOS))
    if hasattr(small, "get_flattened_data"):
        pixels = list(small.get_flattened_data())
    else:
        pixels = list(small.getdata())
    bits = []
    for row in range(8):
        offset = row * 9
        for col in range(8):
            bits.append(1 if pixels[offset + col] > pixels[offset + col + 1] else 0)
    value = 0
    for bit in bits:
        value = (value << 1) | bit
    return f"{value:016x}"


def image_metrics(img):
    thumb = ImageOps.contain(img.convert("RGB"), (512, 512), Image.Resampling.LANCZOS)
    gray = ImageOps.grayscale(thumb)
    stat = ImageStat.Stat(gray)
    edges = gray.filter(ImageFilter.FIND_EDGES)
    edge_score = ImageStat.Stat(edges).stddev[0]
    hsv = thumb.convert("HSV")
    saturation = ImageStat.Stat(hsv.split()[1]).mean[0]
    brightness = stat.mean[0]
    contrast = stat.stddev[0]
    flags = []
    if edge_score < 11:
        flags.append("soft_or_blurry")
    if brightness < 42:
        flags.append("too_dark")
    if brightness > 218:
        flags.append("too_bright")
    if contrast < 28:
        flags.append("low_contrast")
    if saturation < 28:
        flags.append("low_saturation")
    return {
        "brightness": round(brightness, 2),
        "contrast": round(contrast, 2),
        "edge_score": round(edge_score, 2),
        "saturation": round(saturation, 2),
        "flags": flags,
    }


def analyze_photo(path, index):
    record = {
        "index": index,
        "type": "photo",
        "path": str(path),
        "name": path.name,
        "readable": False,
    }
    try:
        img = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
        exif = img.getexif()
        taken_at = None
        for tag in EXIF_DATE_TAGS:
            taken_at = parse_exif_datetime(exif.get(tag))
            if taken_at:
                break
        metrics = image_metrics(img)
        record.update(
            {
                "readable": True,
                "width": img.width,
                "height": img.height,
                "aspect_ratio": round(img.width / img.height, 4),
                "taken_at": taken_at,
                "dhash": image_dhash(img),
                "quality": metrics,
            }
        )
    except Exception as exc:
        record["error"] = str(exc)
    return record


def analyze_video(path, index):
    record = {
        "index": index,
        "type": "video",
        "path": str(path),
        "name": path.name,
        "readable": False,
    }
    try:
        fmt = ffprobe_json(path, "format=duration,size,bit_rate,tags")
        video = ffprobe_json(path, "stream=width,height,r_frame_rate,avg_frame_rate,codec_name", "v:0")
        audio = ffprobe_json(path, "stream=codec_type,codec_name,channels", "a:0")
        stream = video.get("streams", [{}])[0]
        record.update(
            {
                "readable": True,
                "duration": float(fmt.get("format", {}).get("duration", 0)),
                "size": int(fmt.get("format", {}).get("size", 0)),
                "width": stream.get("width"),
                "height": stream.get("height"),
                "video_codec": stream.get("codec_name"),
                "avg_frame_rate": stream.get("avg_frame_rate"),
                "has_audio": bool(audio.get("streams")),
            }
        )
    except Exception as exc:
        record["error"] = str(exc)
    return record


def draw_label(draw, xy, text, font):
    x, y = xy
    draw.rectangle((x, y, x + 300, y + 42), fill=(0, 0, 0))
    draw.text((x + 5, y + 4), text[:42], fill=(255, 255, 255), font=font)


def make_photo_sheets(records, out_dir, per_sheet=35):
    readable = [r for r in records if r["type"] == "photo" and r.get("readable")]
    sheet_paths = []
    font = ImageFont.load_default()
    tile_w, tile_h = 300, 240
    cols = 5
    rows = max(1, per_sheet // cols)
    for sheet_idx, start in enumerate(range(0, len(readable), per_sheet), 1):
        batch = readable[start : start + per_sheet]
        sheet = Image.new("RGB", (cols * tile_w, rows * tile_h), (24, 24, 24))
        draw = ImageDraw.Draw(sheet)
        for i, record in enumerate(batch):
            x = (i % cols) * tile_w
            y = (i // cols) * tile_h
            try:
                img = ImageOps.exif_transpose(Image.open(record["path"])).convert("RGB")
                img.thumbnail((tile_w, tile_h - 44), Image.Resampling.LANCZOS)
                px = x + (tile_w - img.width) // 2
                py = y + (tile_h - 44 - img.height) // 2
                sheet.paste(img, (px, py))
            except Exception:
                pass
            flags = ",".join(record.get("quality", {}).get("flags", [])) or "ok"
            label = f"{record['index']:04d} {record['name']} {flags}"
            draw_label(draw, (x, y + tile_h - 42), label, font)
        out = out_dir / f"photos_sheet_{sheet_idx:03d}.jpg"
        sheet.save(out, quality=90)
        sheet_paths.append(str(out))
    return sheet_paths


def extract_video_thumb(record, out_dir):
    if not record.get("readable"):
        return None
    duration = max(0.0, float(record.get("duration", 0)))
    seek = min(max(duration * 0.2, 0.1), max(duration - 0.1, 0.1))
    out = out_dir / f"video_{record['index']:04d}.jpg"
    proc = run(
        [
            FFMPEG,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{seek:.3f}",
            "-i",
            record["path"],
            "-frames:v",
            "1",
            "-vf",
            "scale=300:169:force_original_aspect_ratio=decrease,pad=300:169:(ow-iw)/2:(oh-ih)/2",
            str(out),
        ],
        check=False,
    )
    return str(out) if proc.returncode == 0 and out.exists() else None


def make_video_sheet(records, out_dir):
    videos = [r for r in records if r["type"] == "video" and r.get("readable")]
    thumbs = []
    for record in videos:
        thumb = extract_video_thumb(record, out_dir)
        if thumb:
            thumbs.append((record, thumb))
    if not thumbs:
        return None
    font = ImageFont.load_default()
    tile_w, tile_h = 300, 220
    cols = 4
    rows = (len(thumbs) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tile_w, rows * tile_h), (24, 24, 24))
    draw = ImageDraw.Draw(sheet)
    for i, (record, thumb) in enumerate(thumbs):
        x = (i % cols) * tile_w
        y = (i // cols) * tile_h
        img = Image.open(thumb).convert("RGB")
        sheet.paste(img, (x, y))
        label = f"{record['index']:04d} {record['name']} {record.get('duration', 0):.1f}s"
        draw_label(draw, (x, y + 170), label, font)
    out = out_dir / "videos_sheet_001.jpg"
    sheet.save(out, quality=90)
    return str(out)


def assign_duplicate_groups(records):
    seen = {}
    for record in records:
        if record["type"] != "photo" or not record.get("readable"):
            continue
        dhash = record.get("dhash")
        if not dhash:
            continue
        group = seen.setdefault(dhash, f"photo_dup_{len(seen) + 1:04d}")
        record["duplicate_group"] = group


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, action="append", help="Media file or directory. May be repeated.")
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--json", default=None, help="Optional report path.")
    args = parser.parse_args()

    work_dir = Path(args.work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    sheets_dir = work_dir / "contact_sheets"
    sheets_dir.mkdir(exist_ok=True)

    records = []
    for idx, (media_type, path) in enumerate(iter_media(args.input), 1):
        if media_type == "photo":
            records.append(analyze_photo(path, idx))
        else:
            records.append(analyze_video(path, idx))

    assign_duplicate_groups(records)
    photo_sheets = make_photo_sheets(records, sheets_dir)
    video_sheet = make_video_sheet(records, sheets_dir)
    report = {
        "inputs": args.input,
        "counts": {
            "total": len(records),
            "photos": sum(1 for r in records if r["type"] == "photo"),
            "videos": sum(1 for r in records if r["type"] == "video"),
            "unreadable": sum(1 for r in records if not r.get("readable")),
        },
        "contact_sheets": {
            "photos": photo_sheets,
            "videos": [video_sheet] if video_sheet else [],
        },
        "records": records,
    }
    report_path = Path(args.json) if args.json else work_dir / "media_report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"report": str(report_path), "counts": report["counts"], "contact_sheets": report["contact_sheets"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
