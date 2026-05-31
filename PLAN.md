# Jamus — Local Meeting Transcriber · Architecture

> A local, privacy-first meeting transcriber inspired by Jamie.
> **Scope:** record audio → transcribe locally with Whisper → write a speaker-separated `.md` transcript.
> **Out of scope:** AI summaries / insights / action items (handled separately by the user).

**Confirmed build decisions:** primary OS **Windows** (`dshow` mic + WASAPI loopback for system audio);
default model **`large-v3-turbo`** (v3-family accuracy, much faster on CPU than full `large-v3`).

---

## 1. Core idea — speaker separation "for free"

Two physically separate audio sources mean the "me vs. others" split is exact, with no diarization model:

```
  Microphone     → mic.wav     → "Me"
  System audio   → system.wav  → "Participants"
```

Each file is transcribed independently, every segment is tagged with its source label, then the two
segment lists are merged and sorted by timestamp into one conversation.

- **Tier 1 (built):** source-based separation → `Me` vs `Participants`.
- **Tier 2 (future):** diarize *only* `system.wav` to split multiple remote speakers.

---

## 2. Technology

| Concern | Choice |
|---|---|
| Runtime | Node.js ≥ 18 (ESM) |
| Audio capture | FFmpeg via `child_process` — `dshow` (Win), `avfoundation` (mac), `pulse` (Linux) |
| Transcription | `whisper.cpp` via `nodejs-whisper` (auto-builds, auto-downloads ggml models) |
| CLI | `commander` + `@inquirer/prompts` + `ora` + `chalk` |
| Time | `dayjs` |
| Config | `config/default.json` merged with `~/.jamus/config.json` |

---

## 3. Structure (as built)

```
bin/jamus.js                CLI entrypoint (error wrapper)
config/default.json         defaults: model, labels, audio, paths
src/
  cli.js                    commander wiring: devices/record/transcribe/run/models
  config.js                 load + deep-merge defaults & user config; resolve paths
  devices/
    enumerate.js            list audio inputs per-OS, classify mic/loopback
    loopback.js             loopback picker + per-OS setup help
  recorder/
    platform.js             per-OS ffmpeg input args
    ffmpegProcess.js        spawn ffmpeg, graceful "q" stop, finalize WAV
    wasapiCapture.js        spawn the WASAPI loopback recorder (Windows system audio)
    recorder.js             dual-capture orchestrator + start-skew offset
native/
    WasapiLoopbackRecorder.cs   dependency-free C# WASAPI loopback recorder (Windows)
  transcriber/
    modelManager.js         known models, validation, download status
    whisper.js              run whisper.cpp on a wav → [{start,end,text}] (JSON→SRT fallback)
  pipeline/
    session.js              session id/dir/metadata (session.json)
    merge.js                interleave + label + coalesce turns
    transcribeSession.js    transcribe both streams → merge → write outputs
  output/
    markdown.js             render timeline → .md
    jsonSidecar.js          structured .json for the user's AI step
  utils/
    logger.js  fsx.js  audio.js  ffmpeg.js
scripts/
    build-whisper.mjs       one-time CMake build of whisper.cpp (auto-loads VS env on Windows)
models/        downloaded ggml models (gitignored, managed by nodejs-whisper)
recordings/    per-session mic.wav + system.wav + session.json (gitignored)
transcripts/   <date>-<slug>.md and .json
```

---

## 4. Capture (per-OS) — `recorder/platform.js`

Two ffmpeg processes write 16 kHz mono `pcm_s16le` WAV (Whisper's native format).

- **Windows (primary):** mic via `-f dshow -i audio="<name>"`. **System audio via WASAPI loopback**
  (`native/wasapi-loopback.exe`, a dependency-free C# helper compiled with the built-in `csc.exe`) —
  captures the default render endpoint, **no Stereo Mix / virtual cable required**. Its output is
  normalized to 16 kHz mono with FFmpeg after capture.
- **macOS:** `-f avfoundation -i ":<index>"`; loopback via BlackHole + Multi-Output Device.
- **Linux:** `-f pulse -i <source>`; loopback via the sink `.monitor` source.

**Graceful stop:** write `q` to ffmpeg stdin so the WAV header is finalized; SIGKILL only as a timeout fallback.

**Alignment:** record each process's wall-clock start; `offset = systemStart − micStart` is applied to
system timestamps before merge. (Optional future "stereo aggregate" mode = zero drift.)

---

## 5. Transcription — `transcriber/whisper.js` + `transcriber/modelManager.js`

The `nodejs-whisper` npm package is used only to **vendor the whisper.cpp source + downloader**; Jamus
drives the compiled binary directly (the wrapper artificially restricts model names and blocks
`large-v3`). `npm run build:whisper` (`scripts/build-whisper.mjs`) compiles whisper.cpp once via CMake,
auto-loading the Visual Studio `vcvars64` environment on Windows.

1. `modelManager.ensureModel(name)` → download `ggml-<name>.bin` via whisper.cpp's
   `download-ggml-model.cmd/.sh` if missing. Full model list incl. `large-v3`, `large-v3-turbo`.
2. Run `whisper-cli.exe -m <model> -f <wav> -l <lang> -oj -of <out>` → `<out>.json`.
3. Parse JSON (`offsets.from/to` in ms) → `[{start,end,text}]`; strip `[BLANK_AUDIO]`-style tokens.

Default model `large-v3-turbo` (configurable via `--model` / config; `large-v3` for max accuracy).
GPU is a *compile-time* whisper.cpp option (`-DGGML_CUDA=1` rebuild), not a runtime flag.

---

## 6. Merge & output

`pipeline/merge.js`: tag mic→`Me`, system→`Participants` (+offset), sort by start, optionally coalesce
consecutive same-speaker turns. `output/markdown.js` + `output/jsonSidecar.js` write the two files.

Markdown: `**[HH:MM:SS] Speaker:** text`. JSON: `{ title, date, durationSec, model, speakers, segments[] }`.

---

## 7. CLI

```
jamus devices                              list inputs, detect loopback, print setup help
jamus record   [--title --mic --system --mode]      record → session
jamus transcribe <session> [--model --language --me --others]
jamus run      [--title --mic --system --model --me --others --language]   record→transcribe
jamus models   [--list | --download <name>]
```

First run prompts for mic + loopback and saves them to `~/.jamus/config.json`.

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Capturing system audio | Windows: WASAPI loopback (zero config). mac/Linux: loopback device; `jamus devices` guides |
| Mic echoes meeting audio → double text | Recommend headphones |
| Two-process clock drift | Shared start timestamp + offset |
| Hard-killed ffmpeg → corrupt WAV | Graceful `q` stop, SIGKILL only on timeout |
| `large-v3` slow on CPU | `--cuda`, or `--model small.en` for drafts |

---

## 9. Future extensions
Tier-2 diarization on `system.wav`; live/streaming captions; echo suppression; Electron/Tauri GUI;
speaker enrollment for recurring participants.
