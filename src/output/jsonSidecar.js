import path from 'node:path';
import { writeJson } from '../utils/fsx.js';
import { outputBaseName } from '../pipeline/session.js';

/**
 * Write a structured JSON sidecar next to the Markdown transcript.
 * This is the machine-readable form intended for the user's downstream AI step.
 * @returns {string} the written file path.
 */
export function writeJsonSidecar(cfg, { session, timeline, model, durationSec, speakers }) {
  const file = path.join(cfg.resolved.transcripts, `${outputBaseName(session)}.json`);
  writeJson(file, {
    title: session.title,
    date: session.date,
    sessionId: session.id,
    startedAt: session.startedAt,
    durationSec,
    model,
    speakers,
    segments: timeline.map((t) => ({
      start: round(t.start),
      end: round(t.end),
      speaker: t.speaker,
      text: t.text,
    })),
  });
  return file;
}

const round = (n) => Math.round(n * 1000) / 1000;
