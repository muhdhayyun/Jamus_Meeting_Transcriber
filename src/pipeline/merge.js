/**
 * Merge per-source transcripts into one chronological, speaker-labeled timeline.
 *
 * @param {object} args
 * @param {Array<{start,end,text}>} args.micSegments      from mic.wav  → "Me"
 * @param {Array<{start,end,text}>} args.systemSegments   from system.wav → "Participants"
 * @param {number} args.systemOffsetSec  add to every system timestamp to align the two streams
 * @param {object} args.labels  { me, participants }
 * @param {boolean} args.coalesce  merge consecutive same-speaker segments into one turn
 * @param {number} args.maxSentencesPerTurn  start a new turn after this many sentences, even if
 *   the same speaker keeps talking with no interruption (keeps long monologues readable)
 * @returns {Array<{start,end,speaker,text}>}
 */
export function mergeTranscripts({
  micSegments,
  systemSegments,
  systemOffsetSec = 0,
  labels,
  coalesce = true,
  maxSentencesPerTurn = 6,
}) {
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

  return coalesce ? coalesceTurns(tagged, maxSentencesPerTurn) : tagged;
}

const SENTENCE_END_RE = /[^.!?]*[.!?]+/g;

/** Rough sentence count for a chunk of transcript text (splits on . ! ?). */
function countSentences(text) {
  const matches = text.match(SENTENCE_END_RE);
  if (matches) return matches.length;
  return text.trim() ? 1 : 0;
}

/**
 * Collapse adjacent segments from the same speaker into a single turn, but start a fresh turn
 * once the current one reaches `maxSentencesPerTurn` — otherwise one speaker talking uninterrupted
 * for minutes becomes a single unreadable wall of text under one timestamp.
 */
function coalesceTurns(segments, maxSentencesPerTurn) {
  const out = [];
  let sentenceCount = 0;
  for (const seg of segments) {
    const last = out[out.length - 1];
    const segSentences = countSentences(seg.text);
    if (last && last.speaker === seg.speaker && (!maxSentencesPerTurn || sentenceCount < maxSentencesPerTurn)) {
      last.end = Math.max(last.end, seg.end);
      last.text = `${last.text} ${seg.text}`.trim();
      sentenceCount += segSentences;
    } else {
      out.push({ ...seg });
      sentenceCount = segSentences;
    }
  }
  return out;
}
