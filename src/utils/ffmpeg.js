import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const isWin = os.platform() === 'win32';
const exe = (name) => (isWin ? `${name}.exe` : name);

const cache = {};

/** Common locations to look for ffmpeg/ffprobe when they aren't on PATH. */
function candidateDirs() {
  const dirs = [];
  const toolsRoot = path.join(os.homedir(), 'tools');
  try {
    if (fs.existsSync(toolsRoot)) {
      for (const d of fs.readdirSync(toolsRoot)) {
        if (/ffmpeg/i.test(d)) dirs.push(path.join(toolsRoot, d, 'bin'));
      }
    }
  } catch { /* ignore */ }
  if (isWin) {
    dirs.push('C:\\ffmpeg\\bin');
    for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (pf) dirs.push(path.join(pf, 'ffmpeg', 'bin'));
    }
  } else {
    dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin');
  }
  return dirs;
}

function onPath(name) {
  const res = spawnSync(name, ['-version'], { encoding: 'utf8' });
  return !res.error && res.status === 0;
}

/** Resolve a tool to an env override, a PATH name, or a discovered absolute path. */
function resolveTool(kind) {
  if (cache[kind]) return cache[kind];

  const envOverride = kind === 'ffmpeg' ? process.env.JAMUS_FFMPEG : process.env.JAMUS_FFPROBE;
  if (envOverride) return (cache[kind] = envOverride);

  if (onPath(kind)) return (cache[kind] = kind);

  for (const dir of candidateDirs()) {
    const p = path.join(dir, exe(kind));
    if (fs.existsSync(p)) return (cache[kind] = p);
  }
  return kind; // not found — assertFfmpegAvailable() will produce a helpful error
}

export function ffmpegBin() {
  return resolveTool('ffmpeg');
}

export function ffprobeBin() {
  return resolveTool('ffprobe');
}

/** Verify ffmpeg is callable. Throws a friendly error if not. */
export function assertFfmpegAvailable() {
  const bin = ffmpegBin();
  const res = spawnSync(bin, ['-version'], { encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    throw new Error(
      `ffmpeg not found (tried "${bin}"). Install FFmpeg and ensure it is on your PATH.\n` +
        `  Windows:  winget install Gyan.FFmpeg   (or download from ffmpeg.org)\n` +
        `  Or set JAMUS_FFMPEG to the full path of ffmpeg.exe.\n` +
        `  (If you just installed it, restart your terminal/editor so PATH refreshes.)`
    );
  }
  return res.stdout.split('\n')[0];
}
