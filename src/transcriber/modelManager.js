import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { logger } from '../utils/logger.js';

const require = createRequire(import.meta.url);
const isWin = os.platform() === 'win32';

/**
 * Whisper models Jamus exposes. These map 1:1 to whisper.cpp ggml files
 * (ggml-<name>.bin) and to names accepted by its download-ggml-model script.
 */
export const KNOWN_MODELS = [
  'tiny', 'tiny.en',
  'base', 'base.en',
  'small', 'small.en',
  'medium', 'medium.en',
  'large-v1', 'large-v2', 'large-v3', 'large-v3-turbo',
];

export function validateModel(name) {
  if (!KNOWN_MODELS.includes(name)) {
    throw new Error(`Unknown Whisper model "${name}". Known models: ${KNOWN_MODELS.join(', ')}`);
  }
  return name;
}

/** Root of the vendored whisper.cpp tree (from the nodejs-whisper dependency). */
export function whisperRoot() {
  const pkg = require.resolve('nodejs-whisper/package.json');
  return path.join(path.dirname(pkg), 'cpp', 'whisper.cpp');
}

export function modelsDir() {
  return path.join(whisperRoot(), 'models');
}

export function modelPath(name) {
  return path.join(modelsDir(), `ggml-${name}.bin`);
}

export function isModelDownloaded(name) {
  return fs.existsSync(modelPath(name));
}

/** Path to the compiled whisper.cpp CLI binary. */
export function binaryPath() {
  const root = whisperRoot();
  return isWin
    ? path.join(root, 'build', 'bin', 'Release', 'whisper-cli.exe')
    : path.join(root, 'build', 'bin', 'whisper-cli');
}

export function isBuilt() {
  return fs.existsSync(binaryPath());
}

export function assertBuilt() {
  if (!isBuilt()) {
    throw new Error(
      `whisper.cpp is not built yet (missing ${binaryPath()}).\n` +
        `Build it once with:  npm run build:whisper\n` +
        `(On Windows this needs the Visual Studio "Desktop development with C++" workload.)`
    );
  }
}

/** Download a model via whisper.cpp's downloader if it isn't already present. */
export function ensureModel(name) {
  validateModel(name);
  if (isModelDownloaded(name)) return;

  const dir = modelsDir();
  logger.step(`Downloading Whisper model "${name}" (first use only)…`);
  let result;
  if (isWin) {
    // Use the absolute script path: cmd.exe does not search the cwd for commands.
    const script = path.join(dir, 'download-ggml-model.cmd');
    result = spawnSync('cmd.exe', ['/c', script, name], { cwd: dir, stdio: 'inherit' });
  } else {
    result = spawnSync('sh', [path.join(dir, 'download-ggml-model.sh'), name], { cwd: dir, stdio: 'inherit' });
  }
  if (result.status !== 0 || !isModelDownloaded(name)) {
    throw new Error(`Failed to download model "${name}". Check your internet connection.`);
  }
}
