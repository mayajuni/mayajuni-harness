---
name: video-highlight
description: Create memory-style highlight videos from large folders of personal footage. Use when the user wants Codex to select good moments, avoid bad composition, add a location/date title card, optional broad location subtitles, preserve or mix original audio, use natural transitions, render a single MP4, and verify the result with ffprobe and preview sheets.
metadata:
  short-description: Make polished memory highlight videos
---

# Video Highlight

Use `scripts/create_highlight.py` to turn a folder of videos into one polished MP4. The goal is not archival completeness; the goal is a short memory film that helps the user remember and feel the trip without watching every source video.

Default mode is **high-quality memory pass**. Unless the user explicitly asks for speed, draft mode, no STT, no music, no color correction, or no fades, choose quality over runtime.

## Workflow

1. Inspect sources with `ffprobe`: count files, total duration, resolution, fps, GPS/location tags when present, and whether audio exists.
2. Before heavy work, check dependencies. If required tools or the Whisper model are missing, run `scripts/setup_dependencies.py`.
3. Use high-quality mode by default:
   - Run STT/VAD across all source audio before selecting clips when speech may matter, then use speech meaning as part of the selection score.
   - Use word-timing-based lower subtitles for meaningful speech moments, not large transcript blocks.
   - Use broad location subtitles when GPS, nearby photo GPS, STT, filenames, or visible signs can reliably identify the region.
   - Use a user-approved real BGM track when provided, preserve original sound, and keep speech/ambient audio in front.
   - Apply a light color grade, natural crossfade transitions, and a final 1-2 second video/audio fadeout.
   - Only switch to visual-first mode when the footage clearly does not benefit from STT, such as scuba diving, drone footage, scenery, action sports, underwater clips, or music-only montages.
   - Only use fast memory pass when the user explicitly prioritizes speed.
4. Build or update a clip config JSON. Prefer enough scenes to preserve the trip's memory, but avoid rapid flashing. A 2-3 minute highlight is often a good target for 60-90 minutes of personal footage.
5. Reject clips with bad composition even if they are technically sharp: covered lens, upside-down/sideways accidental footage, mostly ground/legs, dark pocket shots, long shaky transitions, duplicate views, or moments that feel like camera handling rather than memory.
6. Use a strong scenic frame as the title card background. Add location and period text.
7. Name the output file from the opening title and period, e.g. `강원_여행_하이라이트_2023.06.02-2023.06.05_60fps.mp4`, so it is recognizable later.
8. Render 1080p or source-appropriate output, usually 60 fps when the source supports it.
9. Preserve original audio when available. Use `acrossfade` between clips so sound does not cut abruptly.
10. Add BGM only when a user-approved real music file is provided. Otherwise keep the original audio only. Music should support the footage, not dominate it.
11. Apply light color correction by default: a little more contrast/saturation/brightness, never a heavy filter look.
12. Use video `xfade` transitions instead of repeated black fades.
13. Add a gentle 1-2 second ending fade for both video and audio unless the user asks for a hard ending.
14. Add broad location subtitles when they improve orientation without cluttering the memory film.
15. Run final STT when speech is present and useful. Use word-level timing to create natural sentence or phrase subtitles.
16. Run post-render QA. Do not stop at “file created”: verify technical integrity and whether the final video actually works as a memory highlight.
17. If QA finds a meaningful issue, revise the config and re-render the smallest necessary scope instead of delivering a known-weak result.

## Dependencies

Required:

- Homebrew on macOS for installing video/STT tools.
- `ffmpeg-full` for `drawtext`, `subtitles`, `libass`, `xfade`, audio mixing, and `ffprobe`.
- `whisper-cpp` for local private STT.
- Whisper model: **`ggml-medium.bin` multilingual from whisper.cpp**. This is the required default STT model for this skill. Do not silently use `tiny`, `base`, `small`, `large`, or any `.en` model unless the user explicitly asks for a different model.
- Python 3 and `Pillow` for title cards and preview sheets.

Bootstrap or verify:

```bash
python3 scripts/setup_dependencies.py
```

Run commands from this installed skill directory, or resolve `scripts/...` relative to this `SKILL.md` file. This script may install Homebrew formulae, install Python packages with `pip3 --user`, and download the required STT model to `~/.cache/video-highlight/models/ggml-medium.bin` unless `VIDEO_HIGHLIGHT_MODEL_DIR` is set.

## Clip Selection

For high-quality memory highlights, score candidate moments with both visual and speech signals:

- Visual: clear place, people, scenery, food, activity, stable composition, good exposure, non-duplicate view.
- Speech: place names, reactions, laughter, decisions, explanations, emotional comments, or lines that make the scene memorable.
- Story: preserve sequence and variety: arrival, walking, market/food, beach/harbor, nature, museum/landmark, ending.
- Balance: do not include every source equally. Include what helps the user remember the trip.
- Exclusions: camera handling, pockets, covered lens, accidental low-angle walking, and overly tilted footage unless the speech is unusually meaningful.
- For scuba, underwater, drone, scenery, or action-first footage, prioritize motion, clarity, subject visibility, composition, variety, and pacing over STT. Use captions only for location/date/chapter cues if helpful.

## Location Labels

Use location labels as light orientation cues, especially when the highlight is chronological and spans multiple places:

- Prefer broad names such as `Da Lat`, `Nha Trang`, `Seoul`, or `Osaka`, not exact restaurants or hotels, unless the user asks for detail.
- Ground labels in the strongest available evidence: video GPS tags, nearby photo EXIF GPS by timestamp, STT place names, filenames, visible signs, or landmarks.
- Treat `(0,0)` GPS and impossible coordinates as invalid.
- Cluster nearby coordinates into region spans. For clips without GPS, infer the region from adjacent media captured around the same time.
- Show the current broad location continuously during its region span, starting after the opening title clears and changing only when the broad region changes.
- Use short fades at region changes. If the label feels visually distracting for a particular video, fall back to brief 4-6 second chapter-style labels.
- Avoid covering faces, food, signs, or speech subtitles. A small upper-left caption usually works well.
- If speech subtitles are also present, use `subtitle_file` for speech and `location_subtitle_file` for location labels so both can be burned in sequence.
- QA at least one frame for every location label.

## Audio And Music

- Keep original sound as the emotional anchor when it contains waves, footsteps, city ambience, laughter, reactions, or underwater breathing.
- Do not generate BGM. Use only a user-approved downloaded music file, or render with original audio only.
- Mix conservatively: background music should usually sit under the original audio, with ambient sound still audible.
- Fade music and original audio at the end with a 1-2 second tail.
- Do not add music if it fights important speech unless ducking or careful volume automation is used.

## STT And Subtitles

Use local `whisper-cpp` with **`ggml-medium.bin` multilingual** for private personal footage. This is the default and expected STT model because Korean quality matters for memory subtitles.

Default STT model resolution:

1. If the user explicitly provides `WHISPER_MODEL` or `--model`, use that path and mention that the default was overridden.
2. Otherwise use `~/.cache/video-highlight/models/ggml-medium.bin`.
3. If `VIDEO_HIGHLIGHT_MODEL_DIR` is set, use `$VIDEO_HIGHLIGHT_MODEL_DIR/ggml-medium.bin`.
4. If the model is missing, run `scripts/setup_dependencies.py` before transcription.

Use subtitles for memory cues, not full transcription:

- Subtitle judgment should serve the highlight video, not the transcript. Add captions only when they improve memory, context, emotion, or story flow.
- Keep only short, meaningful lines: place names, reactions, jokes, decisions, and emotional comments.
- Correct obvious STT errors before burning subtitles.
- If the user wants the full STT reflected, keep most speech segments but lightly rewrite obvious recognition errors and split long text into 1-2 short lines.
- For personal memory videos, prefer smaller lower-third subtitles near the bottom: e.g. `FontSize=18`, `MarginV=22`, `Alignment=2` for 1080p.
- For higher subtitle quality, use word-level STT timing to refine sentence subtitle start/end times. This is the default. Do not show every word as karaoke unless the user explicitly wants that style.
- If speech and subtitle timing feels awkward after word-level timing, prefer trimming, merging, delaying, or omitting the caption over forcing a literal transcript onto the scene.
- Avoid captions during very short shots, fast transitions, unclear speech, or moments where the visual memory is stronger without text.
- Avoid subtitles over the opening title unless the first spoken line is essential.
- Use `ffmpeg-full` when available because it includes `drawtext`, `subtitles`, and `libass`.

## Post-Render QA

After rendering, perform both **technical QA** and **memory-highlight QA** before reporting completion. The user expects the output to be watched/analyzed enough to know whether it matches their intent, not merely encoded successfully.

Technical QA checklist:

- Run `ffprobe` on the final MP4 and report duration, size, video codec, resolution, fps, audio codec, and channel count.
- Run `blackdetect` to catch unintended black frames or broken video. Ignore only intentional title/ending fades.
- Run `silencedetect` to catch long unintended audio dropouts. Intentional silent title cards are acceptable; unexpected mid-video silence is not.
- Run `volumedetect` or equivalent to catch clipping and obviously too-quiet audio. Speech should not be buried under BGM.
- Create a final timeline contact sheet with timestamps across the whole rendered output, not only source candidates.
- Extract at least one title-card frame, one subtitle frame if subtitles are present, one frame per location label if present, and one ending frame. Inspect them for readability, cropping, overlap, and professional layout.
- Confirm the final file path is the intended keeper file, and remove or clearly distinguish draft/no-sub/intermediate outputs if the user asked for cleanup.

Memory-highlight QA checklist:

- Compare source chronological order against the final clip order. The final story should not accidentally jump backward unless that is an intentional creative choice.
- Confirm every important source period or location is represented, or explicitly note why a source was excluded.
- Confirm location labels are grounded in GPS, nearby timestamp evidence, STT, or visible place evidence, and that they appear only when useful.
- Check that the title and date are grounded in source metadata or STT evidence. Do not infer “day 1/day 2” in the title unless the user asked for that wording.
- Verify the opening gives context, the middle has variety, and the ending feels like a natural closing memory rather than an arbitrary cutoff.
- Check for repeated-looking shots, camera handling, covered lens, ground/feet-only walking, awkward tilted footage, or duplicate views that slipped through selection.
- Check that selected subtitles are memory cues: short, meaningful, corrected for obvious STT errors, and not full transcript clutter.
- Check that transitions feel natural and do not cut off important speech, laughter, reactions, or scenic motion.
- Decide whether the output is a relaxed memory film or a tighter social highlight. If it feels too long, repetitive, or slow for the user’s stated intent, revise rather than rationalizing it.

QA should be explicit in the final response. Summarize what was checked and whether any residual risk remains. If the user asks whether “all video flow” was checked, distinguish clearly between analysis-based flow QA and real-time playback review. When time permits or the user asks for stronger assurance, perform a real-time or near-real-time review pass of the final MP4 in addition to contact sheets and probes.

Useful QA commands:

```bash
ffprobe -v error \
  -show_entries stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,channels:format=duration,size,bit_rate \
  -of json /path/to/final.mp4

ffmpeg -hide_banner -nostats -i /path/to/final.mp4 \
  -vf blackdetect=d=0.5:pix_th=0.10 -an -f null -

ffmpeg -hide_banner -nostats -i /path/to/final.mp4 \
  -af silencedetect=noise=-45dB:d=1.0 -vn -f null -

ffmpeg -hide_banner -nostats -i /path/to/final.mp4 \
  -af volumedetect -vn -f null -

ffmpeg -y -hide_banner -loglevel error -i /path/to/final.mp4 \
  -vf "fps=1/12,scale=360:203,drawtext=fontfile=/System/Library/Fonts/AppleSDGothicNeo.ttc:text='%{pts\\:hms}':x=8:y=8:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.45,tile=4x6" \
  -frames:v 1 /path/to/qa/timeline_sheet.jpg
```

Useful paths on this machine:

```bash
FFMPEG=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg
FFPROBE=/opt/homebrew/opt/ffmpeg-full/bin/ffprobe
WHISPER=/opt/homebrew/opt/whisper-cpp/bin/whisper-cli
WHISPER_MODEL=~/.cache/video-highlight/models/ggml-medium.bin
```

## Script

Run:

```bash
python3 scripts/create_highlight.py \
  --config /path/to/highlight_config.json
```

To use `ffmpeg-full` without changing the user shell:

```bash
FFMPEG=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg \
FFPROBE=/opt/homebrew/opt/ffmpeg-full/bin/ffprobe \
python3 scripts/create_highlight.py \
  --config /path/to/highlight_config.json
```

The config should include:

```json
{
  "output": "/absolute/path/highlight.mp4",
  "work_dir": "/absolute/path/build-dir",
  "title": "Location or trip name",
  "subtitle": "2023.06.02 - 2023.06.05",
  "fps": 60,
  "transition": 0.8,
  "title_duration": 2.0,
  "bgm_file": "/absolute/path/youtube-audio-library-track.mp3",
  "bgm_volume": 0.12,
  "color_grade": true,
  "ending_fade_duration": 1.5,
  "subtitle_file": "/absolute/path/word-timed-subtitles.srt",
  "subtitle_style": "FontSize=18,MarginV=22,Alignment=2,Outline=1,Shadow=0",
  "location_subtitle_file": "/absolute/path/location-labels.ass",
  "location_subtitle_style": "FontSize=22,MarginV=58,MarginL=72,Alignment=7,Outline=2,Shadow=1",
  "cover": {
    "file": "/absolute/path/source.mp4",
    "time": 80.0
  },
  "clips": [
    {
      "file": "/absolute/path/source.mp4",
      "start": 10.0,
      "duration": 8.0
    }
  ]
}
```

For first passes, create a contact sheet from candidate clips before rendering the final video. If the user critiques the result, revise the config rather than starting from scratch.

## BGM Selection

Do not use generated BGM. Use a real track from a license-checkable library such as YouTube Audio Library, Mixkit, Pixabay, or another user-approved source. If no `bgm_file` is provided, render with original audio only.

Preferred bright vlog/trip pool:

- When the highlight feels like bright personal vlog footage, city wandering, food, beach, pool, scooter/driving, friends, or sunny outdoor memories, choose from the user's approved candidate pool before searching broader libraries.
- If the user has not named a specific BGM but this pool fits the footage, pick the best-matching track yourself, download it from an official or user-approved source, and put it into the render without asking for another approval round.
- Strong defaults: `Ikson - Sunny`, `Scandinavianz - Vacation`, `Scandinavianz - Sunny Island`, `MBB - Feel Good`, `LiQWYD - Feel`, `LiQWYD - Free`, `Joakim Karud - Dreams`.
- Also use the `Scandinavianz - Travel` playlist as a discovery pool; audition 2-3 tracks from it when one fixed candidate does not fit.
- Match energy to footage: tropical house/happy tracks for food, streets, beaches, pools, and sunny travel; feel-good vlog tracks for mixed motion and city movement; relaxed hip-hop/pop only when the edit is warm and unhurried.
- Prefer official artist pages, YouTube Audio Library, verified artist download links, or other source URLs the user approves. Preserve title, artist, source URL, and license/attribution note in the work directory.
- If the user says copyright does not matter for private viewing, still avoid generated BGM and still record the source URL, but prioritize the best emotional fit from the approved pool.

When using YouTube Audio Library:

- Choose candidates after inspecting the footage tone, not before.
- Use YouTube Audio Library filters for genre, mood, duration, attribution requirement, and search terms.
- Prefer `Attribution not required` when the output is likely to be shared casually.
- Avoid tracks that fight speech; for speech-heavy clips choose ambient, cinematic, acoustic, soft, calm, inspirational, or low-intensity music.
- For scenic highlights, consider cinematic, ambient, acoustic, lo-fi, calm, bright, hopeful, or sentimental moods.
- For energetic trips, beach, city, sports, or social clips, consider upbeat, dance/electronic, pop, hip-hop, bright, happy, or driving moods.
- Download the MP3 and preserve the track title, artist, source URL, license type, and attribution text if required in the work directory.
- Put the chosen local file in config as `bgm_file`. The renderer loops/trims it to the final video duration and applies the configured `bgm_volume`.
- Start with `bgm_volume` around `0.08-0.14` when original audio or speech matters, and `0.14-0.22` for music-led montages.
