import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

/** Recursively sum the byte size of a directory. */
function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    try {
      total += e.isDirectory() ? dirSize(full) : fs.statSync(full).size;
    } catch {
      /* ignore */
    }
  }
  return total;
}

/** Total size (bytes) of all recordings. */
export function recordingsSize(recordingsDir) {
  return dirSize(recordingsDir);
}

/**
 * Enforce a size cap on the recordings directory by deleting the .wav files of the
 * OLDEST sessions until the total is under the cap. Transcripts and session.json are
 * kept, so capped-out meetings still appear in the app (just without re-transcribable audio).
 * @returns {{ before:number, after:number, deleted:string[] }}
 */
export function enforceStorageCap(recordingsDir, maxGB) {
  const maxBytes = Math.max(0, Number(maxGB) || 0) * 1024 * 1024 * 1024;
  const deleted = [];
  const before = dirSize(recordingsDir);
  if (maxBytes <= 0 || before <= maxBytes) return { before, after: before, deleted };

  let sessions;
  try {
    sessions = fs
      .readdirSync(recordingsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const full = path.join(recordingsDir, e.name);
        return { name: e.name, full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime); // oldest first
  } catch {
    return { before, after: before, deleted };
  }

  let total = before;
  for (const s of sessions) {
    if (total <= maxBytes) break;
    let removedHere = 0;
    try {
      for (const f of fs.readdirSync(s.full)) {
        if (!f.toLowerCase().endsWith('.wav')) continue;
        const full = path.join(s.full, f);
        try { const sz = fs.statSync(full).size; fs.rmSync(full, { force: true }); total -= sz; removedHere += sz; } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    if (removedHere) deleted.push(s.name);
  }
  if (deleted.length) {
    logger.dim(`Storage cap (${maxGB} GB) exceeded — cleared audio from ${deleted.length} oldest recording(s).`);
  }
  return { before, after: total, deleted };
}
