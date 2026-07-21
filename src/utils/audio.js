import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ffprobeBin, ffmpegBin } from './ffmpeg.js';
import { fileExists } from './fsx.js';

/** Format a number of seconds as HH:MM:SS (zero-padded). */
export function formatTimestamp(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** Return the duration of an audio file in seconds (0 if unknown). */
export function probeDuration(file) {
  if (!fileExists(file)) return 0;
  const res = spawnSync(
    ffprobeBin(),
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
    { encoding: 'utf8' }
  );
  if (res.status !== 0) return 0;
  const dur = parseFloat(String(res.stdout).trim());
  return Number.isFinite(dur) ? dur : 0;
}

/** Convert any audio file to 16 kHz mono pcm_s16le WAV at `dest`. Returns true on success. */
export function convertAudioTo16kMono(src, dest) {
  if (!fileExists(src)) return false;
  const res = spawnSync(
    ffmpegBin(),
    ['-hide_banner', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', dest],
    { encoding: 'utf8' }
  );
  return res.status === 0 && fileExists(dest);
}

/**
 * Concatenate WAV files that share the same format (sample rate/channels/codec) into
 * one output file via ffmpeg's concat demuxer (stream copy — no re-encoding).
 * Used to stitch finalized live-mode segments back into a single session WAV.
 * Returns true on success (or if `files` is empty, in which case an empty-ish dest is not created).
 */
export function concatWavFiles(files, dest) {
  if (!files.length) return false;
  const listFile = path.join(os.tmpdir(), `jamus-concat-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const escape = (p) => p.replace(/'/g, "'\\''");
  fs.writeFileSync(listFile, files.map((f) => `file '${escape(f)}'`).join('\n'), 'utf8');
  try {
    const res = spawnSync(
      ffmpegBin(),
      ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-y', dest],
      { encoding: 'utf8' }
    );
    return res.status === 0 && fileExists(dest);
  } finally {
    try { fs.unlinkSync(listFile); } catch { /* ignore */ }
  }
}

/** Convert a WAV in place to 16 kHz mono pcm_s16le (Whisper's required format). */
export function ensure16kMono(file) {
  if (!fileExists(file)) return;
  const tmp = file.replace(/\.wav$/i, '') + '.16k.wav';
  const res = spawnSync(
    ffmpegBin(),
    ['-hide_banner', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-y', tmp],
    { encoding: 'utf8' }
  );
  if (res.status === 0 && fileExists(tmp)) {
    fs.renameSync(tmp, file);
  } else {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}
