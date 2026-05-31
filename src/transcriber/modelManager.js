import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Whisper models supported by whisper.cpp / nodejs-whisper that Jamus exposes. */
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

/**
 * Best-effort location of nodejs-whisper's bundled model directory so we can report
 * which models are already downloaded. Returns null if it can't be resolved.
 */
export function whisperModelsDir() {
  try {
    const pkg = require.resolve('nodejs-whisper/package.json');
    const dir = path.join(path.dirname(pkg), 'cpp', 'whisper.cpp', 'models');
    return fs.existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

export function isModelDownloaded(name) {
  const dir = whisperModelsDir();
  if (!dir) return false;
  return fs.existsSync(path.join(dir, `ggml-${name}.bin`));
}
