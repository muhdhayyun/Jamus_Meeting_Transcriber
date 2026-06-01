# Changelog

All notable changes to Jamus are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/), and the project
adheres to [Semantic Versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).

## [Unreleased]

### Planned
- Desktop UI (Jamie-style) so the app runs as a window, not just the CLI.
- AI insights via the Groq API (summary, action items, decisions) → `*.insights.md`.
- Recording storage cap with automatic cleanup of oldest recordings.

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
