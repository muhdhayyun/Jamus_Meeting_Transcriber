import fs from 'node:fs';
import path from 'node:path';
import { readJsonIfExists, writeJson } from '../utils/fsx.js';

/**
 * List all meetings, newest first, by scanning the recordings directory for
 * session.json files and cross-referencing transcript/insights output.
 *
 * @returns {Array<{
 *   id, title, date, startedAt, durationSec,
 *   hasAudio, hasTranscript, hasInsights,
 *   mdPath, insightsPath, dir
 * }>}
 */
export function listMeetings(cfg) {
  const recDir = cfg.resolved.recordings;
  const txDir = cfg.resolved.transcripts;
  let entries = [];
  try {
    entries = fs.readdirSync(recDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }

  const meetings = entries
    .map((e) => {
      const dir = path.join(recDir, e.name);
      const meta = readJsonIfExists(path.join(dir, 'session.json'));
      if (!meta) return null;
      const mdPath = path.join(txDir, `${meta.id}.md`);
      const insightsPath = path.join(txDir, `${meta.id}.insights.md`);
      const dur = Math.max(meta.results?.mic?.durationSec ?? 0, meta.results?.system?.durationSec ?? 0);
      return {
        id: meta.id,
        title: meta.title || 'Untitled meeting',
        date: meta.date,
        startedAt: meta.startedAt,
        durationSec: dur,
        hasAudio: !!(meta.files && fs.existsSync(meta.files.mic)),
        hasTranscript: fs.existsSync(mdPath),
        hasInsights: fs.existsSync(insightsPath),
        mdPath,
        insightsPath,
        dir,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)); // newest first

  return meetings;
}

/** Load a meeting's transcript markdown (or '' if not transcribed). */
export function readTranscript(meeting) {
  try {
    return fs.readFileSync(meeting.mdPath, 'utf8');
  } catch {
    return '';
  }
}

/** Load a meeting's insights markdown (or '' if none). */
export function readInsights(meeting) {
  try {
    return fs.readFileSync(meeting.insightsPath, 'utf8');
  } catch {
    return '';
  }
}

/** Replace the first "# ..." heading line of a markdown file (if it exists). */
function rewriteHeading(file, heading) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const idx = lines.findIndex((l) => l.startsWith('# '));
    if (idx >= 0) {
      lines[idx] = heading;
      fs.writeFileSync(file, lines.join('\n'), 'utf8');
    }
  } catch {
    /* file may not exist yet */
  }
}

/**
 * Rename a meeting's title. Updates session.json and the transcript/insights
 * headings. Filenames stay keyed to the (stable) session id.
 */
export function renameMeeting(cfg, id, newTitle) {
  const title = String(newTitle || '').trim();
  if (!title) throw new Error('Title cannot be empty.');

  const metaPath = path.join(cfg.resolved.recordings, id, 'session.json');
  const meta = readJsonIfExists(metaPath);
  if (!meta) throw new Error('Meeting not found.');
  meta.title = title;
  writeJson(metaPath, meta);

  const txDir = cfg.resolved.transcripts;
  rewriteHeading(path.join(txDir, `${id}.md`), `# ${title}`);
  rewriteHeading(path.join(txDir, `${id}.insights.md`), `# Insights — ${title}`);
  return true;
}
