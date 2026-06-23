# Changelog

All notable changes to Jamus are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/), and the project
adheres to [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).

## [Unreleased]

## [0.5.0] - 2026-06-01

### Added
- **Import existing audio** (phone memos, mp3/m4a/wav/…): converts any format and
  transcribes it as a single-speaker transcript that appears in the meeting list.
  - Desktop: "⤓ Import audio file" button (file picker, multi-select supported).
  - CLI: `jamus transcribe-file <path> [--title --model --me --insights]`.
- **Drop-In Recordings/** folder — drop files here; the app's import picker opens it
  by default. Contents are gitignored.

### Added
- **Delete audio** per meeting (🗑 next to the title) and **Delete all recording audio**
  (Settings → Storage) to free space. Transcripts, insights, and the meeting list are kept —
  only the `.wav` files are removed (you just can't re-transcribe afterward).

### Changed
- The storage cap now clears only the **audio** of the oldest recordings (keeping
  `session.json` + transcripts) instead of deleting whole meeting folders, so capped-out
  meetings still appear in the app.

### Added
- **Dark mode** toggle (🌙/☀️) in the sidebar; preference persists across launches.
- **Rename meeting** (✎ next to the title) — updates the title and the transcript/insights
  headings; file ids stay stable.

## [0.2.0] - 2026-06-01

Adds a desktop app, cloud insights, and storage management on top of the core engine.

### Added
- **Desktop UI (Electron, Jamie-style)**: sidebar meeting list, one-click record
  with live timer, transcript + insights tabs, and a settings panel. Run with `npm run app`.
- **AI insights via Groq** (cloud): generates Summary / Action Items / Key Decisions /
  Topics & Open Questions into `transcripts/<id>.insights.md`. Off by default; enable with
  an API key in Settings (stored locally). CLI: `jamus insights <session>` or `--insights`.
- **Recording storage cap** (default 20 GB) — oldest recordings auto-deleted past the cap.
- `scripts/start-app.mjs` launcher that clears `ELECTRON_RUN_AS_NODE` (set by some
  terminals/VS Code) so the GUI launches reliably.

### Notes
- Insights use a cloud API, so transcript text is sent to Groq's servers (not local).

## [0.1.0] - 2026-06-01

Initial working version — a fully local, CLI meeting transcriber.

### Added
- **Dual-source recording**: microphone (FFmpeg) + system audio, captured as
  separate 16 kHz mono WAV streams.
- **Zero-install system audio on Windows** via a custom WASAPI loopback recorder
  (`native/WasapiLoopbackRecorder.cs`, compiled with the built-in `csc.exe`) — no
  Stereo Mix or virtual cable required.
- **Local transcription** with `whisper.cpp` driven directly (`whisper-cli.exe`),
  supporting the full model list incl. `large-v3` / `large-v3-turbo`.
- **Speaker separation**: mic → "Me", system audio → "Participants", merged into one
  timestamped, chronological Markdown transcript.
- **CUDA/GPU build** (`npm run build:whisper:cuda`) — ~30× real-time on an
  RTX 4070 SUPER; cuBLAS DLLs auto-bundled next to the binary.
- **VAD (Silero)** on by default to stop Whisper hallucinating filler ("thank you")
  on silent/quiet audio.
- CLI commands: `devices`, `record`, `transcribe`, `run`, `models`.
- FFmpeg auto-discovery (PATH → env override → common install locations).
- Unique, timestamped transcript filenames (`<session-id>.md`) to prevent overwrites.

### Changed
- Default model set to `large-v3-turbo` (v3-family accuracy, much faster on CPU).

### Removed
- JSON sidecar output — transcripts are Markdown (`.md`) only.
