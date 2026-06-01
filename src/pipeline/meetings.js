import fs from 'node:fs';
import path from 'node:path';
import { readJsonIfExists } from '../utils/fsx.js';

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
