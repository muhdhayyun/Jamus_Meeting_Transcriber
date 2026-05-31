import { buildCaptureArgs } from './platform.js';
import { FfmpegCapture } from './ffmpegProcess.js';
import { saveSession } from '../pipeline/session.js';
import { logger } from '../utils/logger.js';
import { probeDuration } from '../utils/audio.js';
import { fileSize } from '../utils/fsx.js';

/**
 * Record a session's two audio sources (mic + system loopback) in parallel.
 *
 * `waitForStop` is an async function that resolves when the user wants to stop
 * (Enter key, Ctrl+C, etc.). The caller owns that interaction so this stays testable.
 *
 * Returns the (mutated) session with offsets and finalized file info.
 */
export async function recordSession(cfg, session, { waitForStop }) {
  const { sampleRate, channels, codec } = cfg.audio;

  const mic = new FfmpegCapture({
    label: 'mic',
    args: buildCaptureArgs({ deviceId: session.devices.mic, outFile: session.files.mic, sampleRate, channels, codec }),
  });
  const system = new FfmpegCapture({
    label: 'system',
    args: buildCaptureArgs({ deviceId: session.devices.system, outFile: session.files.system, sampleRate, channels, codec }),
  });

  // Start as close together as possible, then record the wall-clock skew for alignment.
  const micStart = mic.start();
  const systemStart = system.start();
  session.offsets.systemMinusMicMs = systemStart - micStart;

  // If a process dies immediately (bad device, permissions), surface it fast.
  await new Promise((r) => setTimeout(r, 400));
  assertAlive(mic, 'microphone');
  assertAlive(system, 'system audio');

  logger.success('Recording… speak normally. Press Enter (or Ctrl+C) to stop.');

  await waitForStop();

  logger.step('Finalizing recording…');
  await Promise.all([mic.stop(), system.stop()]);

  // Verify we actually captured something on each stream.
  session.results = {
    mic: summarize(session.files.mic, mic),
    system: summarize(session.files.system, system),
  };

  saveSession(session);
  return session;
}

function assertAlive(capture, human) {
  if (capture.spawnError) {
    throw new Error(`Failed to start ${human} capture: ${capture.spawnError.message}`);
  }
  if (capture.proc && capture.proc.exitCode !== null && capture.proc.exitCode !== 0) {
    throw new Error(
      `${human} capture exited immediately (code ${capture.proc.exitCode}).\n` +
        `ffmpeg said:\n${capture.stderr.trim() || '(no output)'}\n` +
        `Check the device name with "jamus devices".`
    );
  }
}

function summarize(file, capture) {
  const bytes = fileSize(file);
  const duration = probeDuration(file);
  if (bytes === 0 || duration === 0) {
    logger.warn(`No audio captured on the ${capture.label} stream (${file}). ` + (capture.stderr.trim() || ''));
  }
  return { file, bytes, durationSec: duration };
}
