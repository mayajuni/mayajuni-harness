---
name: media-highlight
description: Create memory-style highlight videos from mixed personal media folders containing photos, videos, or both. Use when Codex should inspect every photo, select strong video moments, reject low-quality or duplicate media, combine still images and video clips into one polished MP4, preserve useful original audio, add subtle BGM, optional STT and location subtitles, and verify the final output.
metadata:
  short-description: Make polished highlights from photos and videos
---

# Media Highlight

Use this skill to turn a folder of personal photos and videos into one polished MP4. The goal is not archival completeness; the goal is a short memory film that preserves the most meaningful visual story without forcing the user to watch every source file.

Default mode is **high-quality memory pass**. Unless the user explicitly asks for speed, draft mode, no STT, no music, no color correction, no photo motion, or no fades, choose quality over runtime.

## Core Promise

- If only photos are present, create a photo-based highlight video.
- If only videos are present, use the video highlight workflow.
- If both are present, inspect both and build one timeline that mixes photos and video clips.
- For photos, do not sample blindly. Every image should be accounted for by at least technical metadata, quality scoring, duplicate grouping, and visual contact-sheet review.
- For videos, keep the existing high-quality clip selection approach: inspect sources, use STT/VAD when speech may matter, and avoid bad composition.
- If a file cannot be read, do not silently skip it. Record it in the analysis output and mention it in the final response.

## Workflow

1. Inspect all sources:
   - Run `scripts/analyze_media.py --input /path/to/media --work-dir /path/to/work`.
   - Count photos and videos, read timestamps, GPS/location metadata when present, dimensions, duration, audio presence, and quality flags.
   - Generate contact sheets that cover every readable photo and representative video frames.
2. Check dependencies before heavy work. If required tools are missing, run `scripts/setup_dependencies.py`.
3. Review the media inventory:
   - Use the JSON report for technical facts.
   - Use every generated photo contact sheet so no image is ignored.
   - For very large folders, review sheets batch by batch and keep notes on which sheet ranges were checked.
4. Decide the mode:
   - Photo-only: choose a paced sequence of strong images with subtle motion and transitions.
   - Video-only: follow the video highlight workflow.
   - Mixed: use photos to fill memory gaps, establish places, preserve people/food/details, and avoid repeating video-only scenery.
5. Build or update a clip config JSON. Use `items` for both photos and videos:

```json
{
  "output": "/absolute/path/highlight.mp4",
  "work_dir": "/absolute/path/build-dir",
  "title": "Memory title",
  "subtitle": "2026.05.01 - 2026.05.03",
  "fps": 60,
  "transition": 0.8,
  "bgm_file": "/absolute/path/youtube-audio-library-track.mp3",
  "bgm_volume": 0.12,
  "location_subtitle_file": "/absolute/path/location-labels.ass",
  "color_grade": true,
  "cover": {
    "file": "/absolute/path/cover.jpg"
  },
  "items": [
    {
      "type": "photo",
      "file": "/absolute/path/IMG_1001.HEIC",
      "duration": 4.0
    },
    {
      "type": "video",
      "file": "/absolute/path/clip.mov",
      "start": 10.0,
      "duration": 8.0
    }
  ]
}
```

`clips` remains accepted for backward compatibility with `video-highlight`, but new mixed-media configs should use `items`.

6. Reject weak media even when it is technically readable:
   - Photos: severe blur, accidental shots, covered lens, screenshots, receipts unless meaningful, duplicate bursts, bad exposure, awkward crops, or images that add no story value.
   - Videos: covered lens, sideways accidental footage, mostly ground/legs, dark pocket shots, camera handling, excessive shake, duplicate views, and cuts that interrupt meaningful speech.
7. Preserve chronology unless a creative reorder is intentional. Use EXIF/image timestamps, video metadata, filename order, and user-provided context.
8. If GPS or reliable place evidence exists, add broad location labels when they help orient the viewer.
9. Use a strong photo or video frame as the title card background. Add title and period text.
10. Render 1080p or source-appropriate output, usually 60 fps when the source supports it.
11. Preserve original video audio when available. Photos render with silent audio and blend naturally through `acrossfade`.
12. Add BGM only when a user-approved real music file is provided. If no `bgm_file` is provided, render with original video audio and silent photo segments only.
13. Apply light color correction by default; never use a heavy filter look.
14. Use crossfades instead of repeated black fades.
15. Add a gentle 1-2 second ending fade for both video and audio unless the user asks for a hard ending.
16. Run post-render QA. Do not stop at “file created.”

## Photo Review Policy

The default is **exhaustive accounting**, not necessarily exhaustive long-form captioning.

For every photo:

- Record path, dimensions, timestamp when available, GPS when available, readability, orientation handling, quality metrics, duplicate hash, and flags.
- Include it in a contact sheet unless unreadable.
- Either select it, reject it, or keep it as a near-duplicate/backup with a reason.

Meaning/content judgment has two levels:

- Default: every photo receives visual review through contact sheets; strong, ambiguous, representative, or selected photos get explicit content notes.
- Exhaustive semantic mode: if the user asks for every image to receive an individual description, do it in batches. This is possible but scales linearly with image count and can be slow/costly for hundreds or thousands of photos.

Do not claim that every image was semantically understood unless every image was actually reviewed at that level.

## Location Labels

When source media has GPS metadata or strong place evidence, use it to orient the highlight with light location labels:

- Prefer broad names such as `Da Lat`, `Nha Trang`, `Seoul`, or `Osaka`, not exact restaurants or hotels, unless the user asks for detailed place names.
- Use the strongest source first: photo EXIF GPS, video GPS tags, nearby photo GPS by timestamp, then visual evidence such as landmark signs or maps.
- Treat `(0,0)` GPS and other impossible coordinates as invalid.
- Cluster nearby coordinates into region spans and preserve chronological order. For videos without GPS, infer the region from adjacent media captured around the same time.
- Show the current broad location continuously during its region span, starting after the opening title clears and changing only when the broad region changes.
- Use short fades at region changes. If the label feels visually distracting for a particular video, fall back to brief 4-6 second chapter-style labels.
- Avoid showing location labels over the opening title if they compete with the title; delay the first label until the title clears.
- Place labels as small upper-left captions or another unobtrusive corner. They are orientation cues, not subtitles.
- If speech subtitles are also present, burn speech subtitles and location labels as separate tracks using `subtitle_file` and `location_subtitle_file`.
- QA at least one frame for each location label to confirm readability, placement, and that it does not cover faces, food, landmarks, or existing text.

## Dependencies

Required:

- Homebrew on macOS for installing video/STT tools.
- `ffmpeg-full` for `drawtext`, `subtitles`, `libass`, `xfade`, `acrossfade`, audio mixing, and `ffprobe`.
- Python 3 with `Pillow` and `pillow-heif` for photos, title cards, HEIC/HEIF support, and contact sheets.
- `whisper-cpp` and the multilingual `ggml-medium.bin` model when STT is useful.

Bootstrap or verify:

```bash
python3 scripts/setup_dependencies.py
```

Run commands from this installed skill directory, or resolve `scripts/...` relative to this `SKILL.md` file.

## BGM Selection

Do not use generated BGM. Use a real track from a license-checkable library such as YouTube Audio Library, Mixkit, Pixabay, or another user-approved source. If no `bgm_file` is provided, render with original video audio and silent photo segments only.

Preferred bright vlog/trip pool:

- When the highlight feels like bright personal vlog footage, city wandering, food, beach, pool, scooter/driving, friends, or sunny outdoor memories, choose from the user's approved candidate pool before searching broader libraries.
- If the user has not named a specific BGM but this pool fits the footage, pick the best-matching track yourself, download it from an official or user-approved source, and put it into the render without asking for another approval round.
- Strong defaults: `Ikson - Sunny`, `Scandinavianz - Vacation`, `Scandinavianz - Sunny Island`, `MBB - Feel Good`, `LiQWYD - Feel`, `LiQWYD - Free`, `Joakim Karud - Dreams`.
- Also use the `Scandinavianz - Travel` playlist as a discovery pool; audition 2-3 tracks from it when one fixed candidate does not fit.
- Match energy to footage: tropical house/happy tracks for food, streets, beaches, pools, and sunny travel; feel-good vlog tracks for mixed photos and city movement; relaxed hip-hop/pop only when the edit is warm and unhurried.
- Prefer official artist pages, YouTube Audio Library, verified artist download links, or other source URLs the user approves. Preserve title, artist, source URL, and license/attribution note in the work directory.
- If the user says copyright does not matter for private viewing, still avoid generated BGM and still record the source URL, but prioritize the best emotional fit from the approved pool.

When using YouTube Audio Library:

- Choose candidates after inspecting the media tone, not before.
- Use YouTube Audio Library filters for genre, mood, duration, attribution requirement, and search terms.
- Prefer `Attribution not required` when the output is likely to be shared casually.
- Avoid tracks that fight speech; for speech-heavy clips choose ambient, cinematic, acoustic, soft, calm, inspirational, or low-intensity music.
- For photo-heavy or scenic highlights, consider cinematic, ambient, acoustic, lo-fi, calm, bright, hopeful, or sentimental moods.
- For energetic events, beach, city, sports, or social clips, consider upbeat, dance/electronic, pop, hip-hop, bright, happy, or driving moods.
- Download the MP3 and preserve the track title, artist, source URL, license type, and attribution text if required in the work directory.
- Put the chosen local file in config as `bgm_file`. The renderer loops/trims it to the final video duration and applies the configured `bgm_volume`.
- Start with `bgm_volume` around `0.08-0.14` when original audio or speech matters, and `0.14-0.22` for photo-only or music-led montages.

## Useful Commands

Analyze a media folder:

```bash
python3 scripts/analyze_media.py \
  --input /path/to/media \
  --work-dir /path/to/work
```

Render a highlight:

```bash
FFMPEG=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg \
FFPROBE=/opt/homebrew/opt/ffmpeg-full/bin/ffprobe \
python3 scripts/create_highlight.py \
  --config /path/to/highlight_config.json
```

Run STT for speech-heavy video:

```bash
python3 scripts/transcribe_highlight.py \
  --video /path/to/source.mov \
  --work-dir /path/to/stt-work
```

## Post-Render QA

Technical QA:

- Run `ffprobe` on the final MP4 and report duration, size, codec, resolution, fps, audio codec, and channel count.
- Run `blackdetect` to catch unintended black frames.
- Run `silencedetect` to catch long unintended audio dropouts.
- Run `volumedetect` or equivalent to catch clipping or buried speech.
- Create a final timeline contact sheet across the rendered output.
- Extract at least one title-card frame, one photo segment frame, one video segment frame if present, one subtitle frame if subtitles are present, and one ending frame.

Memory-highlight QA:

- Confirm every readable photo was accounted for in the analysis report/contact sheets.
- Confirm every important time period or location is represented, or explain why it was excluded.
- If location labels are present, confirm each broad region label is grounded in GPS, nearby timestamp evidence, or visible place evidence.
- Check that photos add memory value rather than acting as filler.
- Check for duplicate-looking photos or repeated video views that slipped through.
- Confirm transitions do not cut off speech, reactions, or scenic motion.
- Distinguish clearly between analysis/contact-sheet QA and real-time playback review.
