import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Path to the compiled WASAPI loopback recorder. */
export function wasapiExePath() {
  return path.resolve(__dirname, '..', '..', 'native', 'wasapi-loopback.exe');
}

export function wasapiBuilt() {
  return fs.existsSync(wasapiExePath());
}

export function assertWasapiBuilt() {
  if (!wasapiBuilt()) {
    throw new Error(
      `The WASAPI loopback recorder is not built (missing ${wasapiExePath()}).\n` +
        `Build it once with:  npm run build:wasapi`
    );
  }
}

/**
 * Captures the default render endpoint via WASAPI loopback to a mono 16-bit WAV.
 * Mirrors the FfmpegCapture interface so the recorder can treat both uniformly.
 */
export class WasapiCapture {
  constructor({ label, outFile }) {
    this.label = label;
    this.outFile = outFile;
    this.proc = null;
    this.startedAt = null;
    this.stderr = '';
    this._exited = new Promise((resolve) => (this._resolveExit = resolve));
  }

  start() {
    this.proc = spawn(wasapiExePath(), [this.outFile], { stdio: ['pipe', 'ignore', 'pipe'] });
    this.startedAt = Date.now();

    this.proc.stderr.on('data', (d) => { this.stderr += d.toString(); });
    this.proc.on('error', (err) => {
      this.spawnError = err;
      this._resolveExit({ code: null, signal: null, error: err });
    });
    this.proc.on('close', (code, signal) => this._resolveExit({ code, signal }));
    return this.startedAt;
  }

  /** The recorder stops cleanly when its stdin receives a line / closes. */
  async stop(timeoutMs = 4000) {
    if (!this.proc || this.proc.exitCode !== null) return this._exited;
    try {
      this.proc.stdin.write('\n');
      this.proc.stdin.end();
    } catch {
      // already closed
    }
    const killer = setTimeout(() => {
      try { this.proc.kill('SIGKILL'); } catch { /* gone */ }
    }, timeoutMs);
    const result = await this._exited;
    clearTimeout(killer);
    return result;
  }

  whenExited() {
    return this._exited;
  }
}
