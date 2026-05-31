import { spawnSync } from 'node:child_process';

/**
 * Resolve the ffmpeg / ffprobe binary names.
 * Honors JAMUS_FFMPEG / JAMUS_FFPROBE env overrides, otherwise assumes they are on PATH.
 */
export function ffmpegBin() {
  return process.env.JAMUS_FFMPEG || 'ffmpeg';
}

export function ffprobeBin() {
  return process.env.JAMUS_FFPROBE || 'ffprobe';
}

/** Verify ffmpeg is callable. Throws a friendly error if not. */
export function assertFfmpegAvailable() {
  const bin = ffmpegBin();
  const res = spawnSync(bin, ['-version'], { encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    throw new Error(
      `ffmpeg not found (tried "${bin}"). Install FFmpeg and ensure it is on your PATH.\n` +
        `  Windows:  winget install Gyan.FFmpeg   (or download from ffmpeg.org)\n` +
        `  Or set JAMUS_FFMPEG to the full path of ffmpeg.exe.`
    );
  }
  return res.stdout.split('\n')[0];
}
