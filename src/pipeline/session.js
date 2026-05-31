import path from 'node:path';
import dayjs from 'dayjs';
import { ensureDir, slugify, writeJson, readJsonIfExists } from '../utils/fsx.js';

/**
 * Create a new recording session: a directory under recordings/ plus metadata.
 * Session id = <YYYYMMDD-HHmmss>-<slug>.
 */
export function createSession(cfg, { title, mic, system, mode }) {
  const now = dayjs();
  const slug = slugify(title, 'meeting');
  const id = `${now.format('YYYYMMDD-HHmmss')}-${slug}`;
  const dir = ensureDir(path.join(cfg.resolved.recordings, id));

  const session = {
    id,
    title: title || 'Untitled meeting',
    date: now.format('YYYY-MM-DD'),
    startedAt: now.toISOString(),
    mode,
    devices: { mic, system },
    files: {
      mic: path.join(dir, 'mic.wav'),
      system: path.join(dir, 'system.wav'),
    },
    dir,
    metaFile: path.join(dir, 'session.json'),
    // populated after recording stops
    offsets: { systemMinusMicMs: 0 },
  };
  return session;
}

export function saveSession(session) {
  // Strip absolute-only convenience fields we don't need to persist verbatim; keep everything useful.
  writeJson(session.metaFile, session);
  return session.metaFile;
}

/** Load a session from either a session id, a session directory, or a session.json path. */
export function loadSession(cfg, ref) {
  let metaFile;
  if (ref.endsWith('session.json')) {
    metaFile = ref;
  } else if (ref.endsWith('.json')) {
    metaFile = ref;
  } else {
    // treat as id or directory under recordings/
    const asDir = path.isAbsolute(ref) ? ref : path.join(cfg.resolved.recordings, ref);
    metaFile = path.join(asDir, 'session.json');
  }
  const data = readJsonIfExists(metaFile);
  if (!data) throw new Error(`Could not load session metadata at ${metaFile}`);
  return data;
}
