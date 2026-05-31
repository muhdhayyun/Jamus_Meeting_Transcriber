/**
 * Merge per-source transcripts into one chronological, speaker-labeled timeline.
 *
 * @param {object} args
 * @param {Array<{start,end,text}>} args.micSegments      from mic.wav  → "Me"
 * @param {Array<{start,end,text}>} args.systemSegments   from system.wav → "Participants"
 * @param {number} args.systemOffsetSec  add to every system timestamp to align the two streams
 * @param {object} args.labels  { me, participants }
 * @param {boolean} args.coalesce  merge consecutive same-speaker segments into one turn
 * @returns {Array<{start,end,speaker,text}>}
 */
export function mergeTranscripts({ micSegments, systemSegments, systemOffsetSec = 0, labels, coalesce = true }) {
  const tagged = [
    ...micSegments.map((s) => ({ ...s, speaker: labels.me })),
    ...systemSegments.map((s) => ({
      ...s,
      start: s.start + systemOffsetSec,
      end: s.end + systemOffsetSec,
      speaker: labels.participants,
    })),
  ]
    .filter((s) => s.text && s.text.trim())
    .sort((a, b) => a.start - b.start || a.end - b.end);

  return coalesce ? coalesceTurns(tagged) : tagged;
}

/** Collapse adjacent segments from the same speaker into a single turn. */
function coalesceTurns(segments) {
  const out = [];
  for (const seg of segments) {
    const last = out[out.length - 1];
    if (last && last.speaker === seg.speaker) {
      last.end = Math.max(last.end, seg.end);
      last.text = `${last.text} ${seg.text}`.trim();
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}
