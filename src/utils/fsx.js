import fs from 'node:fs';
import path from 'node:path';

/** Ensure a directory exists (recursive). Returns the absolute path. */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return path.resolve(dir);
}

/** Turn an arbitrary title into a filesystem-safe slug. */
export function slugify(input, fallback = 'meeting') {
  const slug = String(input ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || fallback;
}

export function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return file;
}

export function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
