import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { ffmpegBin } from '../utils/ffmpeg.js';

const platform = os.platform();

/**
 * List audio input devices for the current OS.
 * Returns: { platform, backend, devices: [{ id, name, kind, isLoopbackCandidate }] }
 *  - `id` is what gets passed to ffmpeg's `-i` for the chosen backend.
 *  - `kind` is 'mic' | 'loopback' | 'unknown' (best-effort heuristic).
 */
export function listAudioDevices() {
  if (platform === 'win32') return listWindows();
  if (platform === 'darwin') return listMac();
  return listLinux();
}

// ---- Windows (dshow) ----------------------------------------------------
function listWindows() {
  // ffmpeg prints the device list to stderr and exits non-zero — that's expected.
  const res = spawnSync(ffmpegBin(), ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
    encoding: 'utf8',
  });
  const text = `${res.stdout || ''}\n${res.stderr || ''}`;
  const lines = text.split('\n');

  const devices = [];
  let inAudio = false;
  for (const line of lines) {
    if (/DirectShow audio devices/i.test(line)) { inAudio = true; continue; }
    if (/DirectShow video devices/i.test(line)) { inAudio = false; continue; }
    if (!inAudio) continue;
    // Match the quoted device name; skip the "Alternative name" lines.
    if (/Alternative name/i.test(line)) continue;
    const m = line.match(/"([^"]+)"/);
    if (m) {
      const name = m[1];
      devices.push({ id: name, name, ...classify(name) });
    }
  }
  return { platform, backend: 'dshow', devices };
}

// ---- macOS (avfoundation) ----------------------------------------------
function listMac() {
  const res = spawnSync(ffmpegBin(), ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
    encoding: 'utf8',
  });
  const text = `${res.stdout || ''}\n${res.stderr || ''}`;
  const lines = text.split('\n');

  const devices = [];
  let inAudio = false;
  for (const line of lines) {
    if (/AVFoundation audio devices/i.test(line)) { inAudio = true; continue; }
    if (/AVFoundation video devices/i.test(line)) { inAudio = false; continue; }
    if (!inAudio) continue;
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (m) {
      const index = m[1];
      const name = m[2];
      // avfoundation audio input is addressed as ":<index>"
      devices.push({ id: `:${index}`, name, ...classify(name) });
    }
  }
  return { platform, backend: 'avfoundation', devices };
}

// ---- Linux (PulseAudio / PipeWire-pulse) -------------------------------
function listLinux() {
  const res = spawnSync('pactl', ['list', 'sources', 'short'], { encoding: 'utf8' });
  const devices = [];
  if (res.status === 0 && res.stdout) {
    for (const line of res.stdout.split('\n')) {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 2) {
        const name = cols[1];
        devices.push({ id: name, name, ...classify(name) });
      }
    }
  }
  return { platform, backend: 'pulse', devices };
}

// ---- shared heuristics -------------------------------------------------
const LOOPBACK_HINTS = /stereo mix|loopback|monitor|blackhole|vb-?cable|cable output|wave out|what u hear|soundflower/i;
const MIC_HINTS = /mic|microphone|input|headset|webcam|array/i;

function classify(name) {
  const isLoopbackCandidate = LOOPBACK_HINTS.test(name);
  let kind = 'unknown';
  if (isLoopbackCandidate) kind = 'loopback';
  else if (MIC_HINTS.test(name)) kind = 'mic';
  return { kind, isLoopbackCandidate };
}
