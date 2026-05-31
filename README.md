# Jamus 🎙️

A local, privacy-first meeting transcriber inspired by Jamie. Jamus records **your microphone**
and **your system audio** as two separate streams, transcribes them locally with **Whisper**
(no cloud, no API keys), and writes a **speaker-separated Markdown transcript** — your voice vs.
everyone else in the call.

> **Scope:** transcript only. No summaries / insights / action items (that's handled separately).
> Every transcript also gets a `.json` sidecar so you can feed it into your own AI step.

## How speaker separation works

Jamus doesn't use a fragile diarization model to tell "you" from "them". It records two physically
separate sources:

```
  Microphone     → mic.wav     → labeled "Me"
  System audio   → system.wav  → labeled "Participants"
```

Each file is transcribed independently, every segment is tagged with its source, and the two are
merged into one chronological transcript. The "me vs. others" split is therefore exact.

---

## Prerequisites

1. **Node.js ≥ 18**
2. **FFmpeg** on your PATH (`ffmpeg -version` should work).
   - Windows: `winget install Gyan.FFmpeg` (or download from ffmpeg.org).
   - Or set `JAMUS_FFMPEG` / `JAMUS_FFPROBE` to full binary paths.
3. **A system-audio loopback device** (this is the part that needs setup — there is no zero-config
   way to capture what your speakers play):
   - **Windows (your platform):** enable **Stereo Mix** *(Sound settings → More sound settings →
     Recording → right-click → Show Disabled Devices → enable "Stereo Mix")*, **or** install
     [VB-CABLE](https://vb-audio.com/Cable/) and route the meeting output to it.
   - **macOS:** `brew install blackhole-2ch`, then make a Multi-Output Device in Audio MIDI Setup.
   - **Linux:** use the PulseAudio/PipeWire `.monitor` source (already present).
4. **🎧 Use headphones.** If the call plays through speakers, your mic re-records it and you get
   duplicated text in both streams.

> First transcription downloads the Whisper model (default `large-v3`, ~3 GB). `nodejs-whisper`
> builds whisper.cpp on install — that needs a C/C++ toolchain (on Windows, Build Tools for VS / cmake).

---

## Install

```bash
npm install
npm link        # optional: makes the `jamus` command global
```

Without `npm link`, run commands as `node bin/jamus.js <command>` or `npm run <script>`.

---

## Usage

### 1. Check your devices

```bash
jamus devices
```

Lists every audio input, flags the loopback candidate, and prints setup help if none is found.

### 2. Record and transcribe in one go

```bash
jamus run --title "Weekly Standup"
```

- On first use it asks you to pick your **mic** and **system-audio loopback** (choices are saved to
  `~/.jamus/config.json` for next time).
- Recording starts. **Press Enter (or Ctrl+C) to stop.**
- It then transcribes both streams and writes:
  - `transcripts/<date>-<title>.md`   — the readable transcript
  - `transcripts/<date>-<title>.json` — structured segments for your AI step

### 3. Or split recording and transcription

```bash
jamus record --title "Weekly Standup"     # → prints a session id
jamus transcribe 20260531-101500-weekly-standup
```

### Useful options

```bash
jamus run --model small.en           # faster/lighter than the large-v3 default
jamus run --cuda                     # use the GPU build of whisper.cpp (set up CUDA first)
jamus run --me "Hayyun" --others "Team"   # custom speaker labels
jamus transcribe <session> --language en  # force a language instead of auto-detect

jamus models                         # list models + which are downloaded
jamus models --download large-v3     # pre-fetch a model so it's ready offline
```

---

## Output example

```markdown
# Weekly Standup

- **Date:** 2026-05-31
- **Duration:** 00:42:13
- **Model:** large-v3
- **Speakers:** Me, Participants

---

**[00:00:03] Me:** Hey, thanks for joining today.

**[00:00:09] Participants:** No problem — glad to be here.
```

---

## Configuration

Defaults live in [`config/default.json`](config/default.json); per-user overrides go in
`~/.jamus/config.json` (deep-merged over the defaults). Keys: `model`, `language`, `labels.me`,
`labels.participants`, `audio.*`, `paths.*`, `recordMode`, `devices.mic`, `devices.system`.

Environment overrides: `JAMUS_FFMPEG`, `JAMUS_FFPROBE`, `JAMUS_CUDA=1`, `JAMUS_DEBUG=1`.

---

## Project structure

See [`PLAN.md`](PLAN.md) for the full architecture. In short:

```
bin/jamus.js          CLI entrypoint
src/cli.js            commander wiring (devices/record/transcribe/run/models)
src/config.js         config load + merge + persistence
src/devices/          enumerate audio devices, detect loopback
src/recorder/         per-OS ffmpeg args, process wrapper, dual-capture orchestrator
src/transcriber/      whisper.cpp wrapper + model manager
src/pipeline/         session metadata, merge/label, transcribe orchestration
src/output/           markdown + JSON sidecar writers
src/utils/            logger, fs, audio, ffmpeg helpers
```

## Troubleshooting

- **"ffmpeg not found"** — install FFmpeg or set `JAMUS_FFMPEG`.
- **`system.wav` is empty / silent** — your loopback isn't capturing. Re-check `jamus devices` and
  make sure the meeting audio is routed to the loopback device (and that you're using headphones).
- **Same words appear twice** — your mic is picking up the speakers. Use headphones.
- **Transcription is very slow** — `large-v3` is heavy on CPU. Use `--cuda`, or `--model small.en`.
