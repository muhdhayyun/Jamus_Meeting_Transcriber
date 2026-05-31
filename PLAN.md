# Jamus — Local Meeting Transcriber · Build Blueprint

> A local, privacy-first meeting transcriber inspired by Jamie.
> **Scope of this app:** record audio → transcribe locally with Whisper → write a clean `.md` transcript.
> **Explicitly out of scope:** AI summaries / insights / action items (handled separately by the user).

This document is the implementation plan. It is intentionally detailed so it can be handed to an
implementation pass (Sonnet) and built without re-deriving design decisions.

> **Confirmed build decisions:**
> - **Primary target OS: Windows.** Implement and test the `dshow`/WASAPI capture backend first;
>   macOS/Linux backends follow the same `recorder/platform.js` interface.
> - **Default Whisper model: `large-v3`** (best accuracy, multilingual). GPU build of whisper.cpp
>   strongly recommended given its size/speed; `--model` still allows lighter models.

---

## 1. Goals & Non-Goals

### Goals
- 100% local. **No OpenAI / no cloud API keys.** Transcription runs on local `whisper.cpp`.
- Record **two audio sources simultaneously**:
  - **Microphone** → your own voice.
  - **System / loopback audio** → everyone else in the meeting (their voices come out of your speakers/headphones).
- Produce a single, chronological transcript that **separates your speech from other speakers**.
- Save the result as a Markdown (`.md`) file (plus a machine-readable JSON sidecar for the user's downstream AI step).
- Cross-platform: macOS, Windows, Linux.

### Non-Goals
- No summarization, no sentiment, no action-item extraction, no chat/LLM features.
- No real-time live captions in v1 (transcription happens after recording stops). Live mode is a documented future extension.

---

## 2. The Core Idea — Speaker Separation "For Free"

Most transcribers do speaker separation with **diarization models** (pyannote etc.), which are heavy and error-prone.
Jamus avoids that for the primary requirement by exploiting the recording topology:

```
  Your microphone  ──────────────►  mic.wav      → labeled "Me"
  System loopback  ──────────────►  system.wav   → labeled "Participants"
```

Because the two voices arrive on **physically separate streams**, the "me vs. others" split is exact.
Each file is transcribed independently, every segment is tagged with its source label, and the two
segment lists are merged and sorted by timestamp into one conversation.

**Tiering:**
- **Tier 1 (v1, required):** source-based separation → `Me` vs `Participants`. Deterministic, no ML beyond Whisper.
- **Tier 2 (optional, future):** run diarization *only on `system.wav`* to split multiple remote
  participants into `Speaker 1 / Speaker 2 / …`. Documented in §11, not built in v1.

---

## 3. Technology Choices

| Concern | Choice | Why |
|---|---|---|
| Runtime | **Node.js ≥ 18 (ESM)** | Requested; modern fetch, AbortController, ESM. |
| Audio capture | **FFmpeg** (spawned via `child_process`) | Only practical cross-platform way to grab mic *and* system loopback. Per-OS input backends: `avfoundation` (mac), `dshow`/`wasapi` (win), `pulse` (linux). |
| Transcription | **whisper.cpp** via [`nodejs-whisper`](https://www.npmjs.com/package/nodejs-whisper) | Pure-local, CPU-friendly, GPU optional (Metal/CUDA), gives segment timestamps, auto-downloads `ggml` models. Fallback: shell out to a prebuilt `whisper-cli` binary. |
| CLI framework | **commander** | Subcommands (`devices`, `record`, `transcribe`, `run`). |
| Interactive prompts | **@inquirer/prompts** | Device picker, first-run setup. |
| Terminal UX | **ora** (spinners) + **chalk** (color) | Progress feedback during capture/transcription. |
| Time formatting | **dayjs** | Timestamps, durations, filenames. |
| Config | JSON file + env overrides | `config/default.json` merged with `~/.jamus/config.json`. |

**Why not Tier-anything-else:**
- `transformers.js` Whisper (ONNX) is an alternative needing no native build, but it's slower and heavier than `whisper.cpp`. Keep as a documented fallback, not the default.
- `naudiodon`/PortAudio can capture devices too, but FFmpeg is more robust for loopback and needs no node-gyp build.

---

## 4. Repository / Module Structure

```
jamus/
├── package.json
├── README.md
├── PLAN.md                      ← this file
├── .gitignore                   ← ignores models/, recordings/, transcripts/*.local
├── config/
│   └── default.json             ← model size, sample rate, speaker labels, output dir
├── bin/
│   └── jamus.js                 ← CLI shebang entrypoint
├── src/
│   ├── cli.js                   ← commander setup, wires subcommands
│   ├── config.js                ← load + merge config, resolve paths
│   │
│   ├── devices/
│   │   ├── enumerate.js         ← list input devices via ffmpeg
│   │   └── loopback.js          ← detect/validate a system-audio loopback source per OS
│   │
│   ├── recorder/
│   │   ├── recorder.js          ← orchestrates dual capture, session lifecycle
│   │   ├── ffmpegProcess.js     ← thin wrapper: spawn ffmpeg, graceful stop, finalize wav
│   │   └── platform.js          ← per-OS ffmpeg input args (darwin/win32/linux)
│   │
│   ├── transcriber/
│   │   ├── whisper.js           ← run whisper.cpp on a wav → [{start,end,text}]
│   │   └── modelManager.js      ← ensure ggml model present (download/verify)
│   │
│   ├── pipeline/
│   │   ├── merge.js             ← interleave + label segments → unified timeline
│   │   └── session.js           ← session metadata (id, title, startedAt, files)
│   │
│   ├── output/
│   │   ├── markdown.js          ← render unified timeline → .md
│   │   └── jsonSidecar.js       ← write structured JSON for downstream AI
│   │
│   └── utils/
│       ├── logger.js
│       ├── audio.js             ← ffprobe duration, ensure 16k mono pcm_s16le
│       └── fsx.js               ← path/dir helpers
│
├── models/                      ← downloaded ggml-*.bin (gitignored)
├── recordings/<session-id>/     ← mic.wav, system.wav, session.json (gitignored)
└── transcripts/                 ← <date>-<title>.md  +  .json sidecar
```

---

## 5. Audio Capture — The Hard Part (Per-OS)

Jamus records **two FFmpeg processes started as close together as possible**, each writing
16 kHz, mono, `pcm_s16le` WAV (Whisper's native format — no resample step later).

> **Recording mode A (default): dual-process.** Two independent ffmpeg processes (mic + loopback).
> Simplest to set up; sync handled via shared start timestamp (§6).
>
> **Recording mode B (optional: stereo aggregate).** Route mic → left channel, system → right
> channel of one aggregate device, record a single stereo WAV, then split channels. Perfect sync,
> but requires the user to build an aggregate device. Document as an advanced option.

### Per-OS input arguments (`recorder/platform.js`)
> Build/verify the **Windows** path first (confirmed primary OS); the others share the same interface.

**Windows (`dshow`) — PRIMARY:**
```
ffmpeg -f dshow -i audio="<Microphone name>"            -ac 1 -ar 16000 -c:a pcm_s16le mic.wav
# loopback via Stereo Mix OR a virtual cable (VB-CABLE) OR ffmpeg WASAPI loopback build
ffmpeg -f dshow -i audio="Stereo Mix (Realtek...)"      -ac 1 -ar 16000 -c:a pcm_s16le system.wav
# enumerate devices: ffmpeg -list_devices true -f dshow -i dummy
```

**macOS (`avfoundation`):**
```
# mic (device index from `ffmpeg -f avfoundation -list_devices true -i ""`)
ffmpeg -f avfoundation -i ":<mic_index>"      -ac 1 -ar 16000 -c:a pcm_s16le mic.wav
# system loopback (a virtual device, e.g. BlackHole, shows up as an avfoundation audio device)
ffmpeg -f avfoundation -i ":<blackhole_index>" -ac 1 -ar 16000 -c:a pcm_s16le system.wav
```

**Linux (`pulse` / PipeWire-pulse):**
```
ffmpeg -f pulse -i default                  -ac 1 -ar 16000 -c:a pcm_s16le mic.wav
# system audio = the sink's ".monitor" source (find via `pactl list sources short`)
ffmpeg -f pulse -i <sink_name>.monitor      -ac 1 -ar 16000 -c:a pcm_s16le system.wav
```

### ⚠️ Prerequisite: System audio is NOT capturable without OS setup
This must be loud in the README. There is no zero-config system-audio capture on macOS/Windows.

- **macOS:** install a loopback driver — `brew install blackhole-2ch`. Then create a **Multi-Output
  Device** in *Audio MIDI Setup* (so meeting audio goes to BlackHole **and** your headphones — otherwise
  you can't hear the call). Grant Terminal/Node **Microphone** + **Screen Recording** permissions.
- **Windows:** enable **Stereo Mix** in Sound settings, or install **VB-CABLE**, or use an ffmpeg build
  with WASAPI loopback. Mic usually works out of the box via `dshow`.
- **Linux (PipeWire/PulseAudio):** the monitor source exists natively. `jamus devices` surfaces it.

### 🎧 Use headphones
If the meeting plays through speakers, your **mic re-captures it** → the same words land in both files →
double transcription. Recommend headphones; note future echo/cross-talk suppression as an enhancement.

### Graceful stop
- Stop via Enter keypress (interactive) or `SIGINT`.
- Send `q`/`SIGTERM` to each ffmpeg process so it **finalizes the WAV header** (a killed `-9` ffmpeg can
  leave an unplayable/zero-duration file). `ffmpegProcess.js` owns this.

---

## 6. Timestamp Alignment

- Whisper timestamps are relative to each file's start (`0`).
- In mode A, capture a **monotonic start time** (`process.hrtime.bigint()` wall-clock anchor) for each
  ffmpeg process at spawn. Compute `offset = systemStart - micStart` and add it to system segments before
  merging. Sub-second drift is acceptable for a readable transcript.
- In mode B (single stereo file) there is **zero drift** — the two channels are sample-aligned.

---

## 7. Transcription (`transcriber/whisper.js`)

1. `modelManager.ensure(modelName)` → guarantee `models/ggml-<model>.bin` exists (download if missing).
2. For each WAV: run whisper.cpp with word/segment timestamps and JSON output.
3. Parse → `[{ start: seconds, end: seconds, text: string }]` (trim, drop empty/`[BLANK_AUDIO]`).
4. Long meetings: whisper.cpp streams long files fine; emit progress via `ora`. Optionally chunk for
   progress granularity (document, not required for v1).

**Model defaults & trade-offs** (configurable in `config/default.json`):

| Model | Size | Speed (CPU) | Use when |
|---|---|---|---|
| `tiny.en` / `base.en` | ~75–150 MB | fastest | quick drafts, low-end machines |
| `small.en` | ~500 MB | balanced | **recommended default** |
| `medium.en` | ~1.5 GB | slow | higher accuracy |
| `large-v3` | ~3 GB | slowest | best accuracy, multilingual |

`.en` variants are English-only and faster. **Default: `large-v3`** (confirmed), with `--model`/config
override. Because `large-v3` is ~3 GB and slow on CPU, the implementation should: (a) detect and use a
GPU build of whisper.cpp when available (CUDA on Windows), (b) show clear progress, and (c) document
falling back to `small.en` for quick drafts on weaker hardware.

---

## 8. Merge & Label (`pipeline/merge.js`)

```
micSegments    = transcribe(mic.wav).map(s => ({ ...s, speaker: config.labels.me }))           // "Me"
systemSegments = transcribe(system.wav)
                   .map(s => ({ ...s, start: s.start + offset, end: s.end + offset,
                                speaker: config.labels.participants }))                          // "Participants"
timeline = [...micSegments, ...systemSegments].sort((a,b) => a.start - b.start)
// optional: coalesce consecutive same-speaker segments into one paragraph
```

Output of this stage is the canonical structure consumed by both writers in §9.

---

## 9. Output Formats (`output/`)

### Markdown (`transcripts/<YYYY-MM-DD>-<slug>.md`)
```markdown
# Weekly Standup

- **Date:** 2026-05-31
- **Duration:** 00:42:13
- **Model:** small.en
- **Speakers:** Me, Participants

---

**[00:00:03] Me:** Hey, thanks for joining today.

**[00:00:09] Participants:** No problem — glad to be here.

**[00:00:15] Me:** Let's start with the roadmap.
```

### JSON sidecar (`transcripts/<...>.json`) — for the user's downstream AI step
```json
{
  "title": "Weekly Standup",
  "date": "2026-05-31",
  "durationSec": 2533,
  "model": "small.en",
  "segments": [
    { "start": 3.1, "end": 8.4, "speaker": "Me", "text": "Hey, thanks for joining today." }
  ]
}
```

Speaker labels (`Me`, `Participants`) come from config and are user-overridable per session (`--me "Hayyun"`).

---

## 10. CLI Surface (`src/cli.js`)

```
jamus devices
    List input devices; flag which can serve as a system-audio loopback. Prints OS-specific setup tips.

jamus record [--title "Standup"] [--mic <id>] [--system <id>] [--mode dual|stereo]
    Start dual capture → recordings/<session>/. Stop with Enter or Ctrl+C. Writes session.json.

jamus transcribe <session-id|path> [--model small.en] [--me "Name"] [--others "Name"]
    Transcribe an existing session's WAVs → merged .md + .json.

jamus run [--title ...] [--model ...]
    Convenience: record, then auto-transcribe on stop. (record → transcribe in one command.)

jamus models [--download <name>] [--list]
    Manage local ggml models.
```

First-run: if no loopback configured, interactively guide the user (inquirer) through OS setup and
persist their device choices to `~/.jamus/config.json`.

---

## 11. Optional / Future Extensions (NOT in v1)
- **Tier-2 diarization** on `system.wav` to split multiple remote speakers (pyannote via a sidecar, or
  `whisper-diarization`). Only the system stream needs it; `Me` is always known.
- **Live / streaming transcription** with chunked capture for near-real-time captions.
- **Echo / cross-talk suppression** when not using headphones.
- **GUI** (Electron/Tauri) wrapper over the same core modules.
- **Speaker enrollment** to auto-name recurring participants.

---

## 12. Dependencies

**System prerequisites (documented in README, checked at startup):**
- `ffmpeg` + `ffprobe` on PATH (or bundle `ffmpeg-static`; verify it includes the OS audio backend).
- Build toolchain for `whisper.cpp` if `nodejs-whisper` compiles locally (or ship a prebuilt binary).
- OS loopback driver per §5 (BlackHole / Stereo Mix / monitor source).

**npm dependencies (proposed `package.json`):**
```json
{
  "name": "jamus",
  "version": "0.1.0",
  "type": "module",
  "bin": { "jamus": "bin/jamus.js" },
  "engines": { "node": ">=18" },
  "scripts": {
    "start": "node bin/jamus.js",
    "devices": "node bin/jamus.js devices"
  },
  "dependencies": {
    "commander": "^12",
    "@inquirer/prompts": "^5",
    "ora": "^8",
    "chalk": "^5",
    "dayjs": "^1",
    "nodejs-whisper": "^0.2"
  }
}
```
(`ffmpeg-static` optional; pin exact versions at implementation time.)

---

## 13. Build Order (suggested for the implementation pass)
1. Scaffold: `package.json`, `bin/jamus.js`, `src/cli.js`, `config/default.json`, `.gitignore`.
2. `utils/` (logger, fsx, audio) + `config.js`.
3. `devices/enumerate.js` + `devices/loopback.js` + `jamus devices` — verify capture works on the dev OS first.
4. `recorder/` (platform args, ffmpegProcess, recorder) + `jamus record` — confirm two clean WAVs + session.json.
5. `transcriber/` (modelManager, whisper) — transcribe a single WAV to segments.
6. `pipeline/merge.js` + `output/markdown.js` + `output/jsonSidecar.js` + `jamus transcribe`.
7. `jamus run` end-to-end; then README with the per-OS setup walkthrough.

---

## 14. Key Risks & Mitigations
| Risk | Mitigation |
|---|---|
| System audio not captured (no loopback) | `jamus devices` detects & guides setup; fail fast with clear instructions. |
| Mic echoes meeting audio → double text | Recommend headphones; future cross-talk suppression. |
| Two-process clock drift | Shared start timestamp + offset; offer mode B (stereo, zero drift). |
| ffmpeg killed hard → corrupt WAV | Graceful `q`/SIGTERM stop that finalizes the header. |
| `large-v3` slow on CPU | Prefer CUDA/GPU build of whisper.cpp on Windows; expose `--model` to drop to `small.en` for drafts. |
| First-run model download size/time | Pre-flight `jamus models --download`; progress UI. |
```
