import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonIfExists, writeJson, ensureDir } from './utils/fsx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const DEFAULTS_FILE = path.join(PROJECT_ROOT, 'config', 'default.json');
const USER_CONFIG_DIR = path.join(os.homedir(), '.jamus');
const USER_CONFIG_FILE = path.join(USER_CONFIG_DIR, 'config.json');

/** Deep-merge plain objects (b overrides a). Arrays/scalars are replaced. */
function deepMerge(a, b) {
  if (b === null || b === undefined) return a;
  if (typeof a !== 'object' || Array.isArray(a)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a[k] ?? {}, v) : v;
  }
  return out;
}

/**
 * Load merged configuration: packaged defaults < user config (~/.jamus/config.json).
 * Relative paths in `paths` are resolved against the project root.
 */
export function loadConfig() {
  const defaults = JSON.parse(fs.readFileSync(DEFAULTS_FILE, 'utf8'));
  const user = readJsonIfExists(USER_CONFIG_FILE) ?? {};
  const cfg = deepMerge(defaults, user);

  cfg.projectRoot = PROJECT_ROOT;
  cfg.userConfigFile = USER_CONFIG_FILE;
  cfg.resolved = {
    models: path.resolve(PROJECT_ROOT, cfg.paths.models),
    recordings: path.resolve(PROJECT_ROOT, cfg.paths.recordings),
    transcripts: path.resolve(PROJECT_ROOT, cfg.paths.transcripts),
    dropin: path.resolve(PROJECT_ROOT, cfg.paths.dropin || 'Drop-In Recordings'),
  };
  return cfg;
}

/** Persist a partial config into the user config file (merged with what's there). */
export function saveUserConfig(partial) {
  ensureDir(USER_CONFIG_DIR);
  const existing = readJsonIfExists(USER_CONFIG_FILE) ?? {};
  const merged = deepMerge(existing, partial);
  writeJson(USER_CONFIG_FILE, merged);
  return USER_CONFIG_FILE;
}
