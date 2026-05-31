import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../utils/fsx.js';
import { formatTimestamp } from '../utils/audio.js';
import { outputBaseName } from '../pipeline/session.js';

/**
 * Render a merged timeline to a Markdown transcript and write it to disk.
 * @returns {string} the written file path.
 */
export function writeMarkdown(cfg, { session, timeline, model, durationSec, speakers }) {
  const lines = [];
  lines.push(`# ${session.title}`);
  lines.push('');
  lines.push(`- **Date:** ${session.date}`);
  lines.push(`- **Duration:** ${formatTimestamp(durationSec)}`);
  lines.push(`- **Model:** ${model}`);
  lines.push(`- **Speakers:** ${speakers.join(', ')}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  if (timeline.length === 0) {
    lines.push('_No speech was transcribed. Check that both the microphone and the system-audio_');
    lines.push('_loopback were capturing (see `jamus devices`)._');
  } else {
    for (const turn of timeline) {
      lines.push(`**[${formatTimestamp(turn.start)}] ${turn.speaker}:** ${turn.text}`);
      lines.push('');
    }
  }

  const dir = ensureDir(cfg.resolved.transcripts);
  const file = path.join(dir, `${outputBaseName(session)}.md`);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}
