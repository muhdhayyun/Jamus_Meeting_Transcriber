import fs from 'node:fs';
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
