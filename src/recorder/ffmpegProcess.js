import { spawn } from 'node:child_process';
import { ffmpegBin } from '../utils/ffmpeg.js';

/**
 * A single ffmpeg capture process with a graceful-stop path.
 *
 * ffmpeg quits cleanly (and finalizes the WAV header) when it receives "q" on stdin.
 * A hard kill can leave a zero-duration / unplayable file, so we always try "q" first.
 */
export class FfmpegCapture {
  constructor({ label, args }) {
    this.label = label;
    this.args = args;
    this.proc = null;
    this.startedAt = null; // wall-clock ms when spawn returned
    this.stderr = '';
    this._exited = new Promise((resolve) => (this._resolveExit = resolve));
  }

  start() {
    this.proc = spawn(ffmpegBin(), this.args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.startedAt = Date.now();

    this.proc.stderr.on('data', (d) => {
      this.stderr += d.toString();
    });

    this.proc.on('error', (err) => {
      this.spawnError = err;
      this._resolveExit({ code: null, signal: null, error: err });
    });

    this.proc.on('close', (code, signal) => {
      this._resolveExit({ code, signal });
    });

    return this.startedAt;
  }

  /** Ask ffmpeg to stop cleanly; force-kill if it does not exit within `timeoutMs`. */
  async stop(timeoutMs = 4000) {
    if (!this.proc || this.proc.exitCode !== null) return this._exited;
    try {
      this.proc.stdin.write('q');
      this.proc.stdin.end();
    } catch {
      // stdin may already be closed — fall through to the kill timer.
    }
    const killer = setTimeout(() => {
      try { this.proc.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    const result = await this._exited;
    clearTimeout(killer);
    return result;
  }

  whenExited() {
    return this._exited;
  }
}
