import ora from 'ora';
import { transcribeFile } from '../transcriber/whisper.js';
import { mergeTranscripts } from './merge.js';
import { writeMarkdown } from '../output/markdown.js';
import { probeDuration } from '../utils/audio.js';
import { logger } from '../utils/logger.js';

/**
 * Transcribe both streams of a session, merge them, and write the .md transcript.
 * @returns {{ mdFile, timeline }}
 */
export async function transcribeSession(cfg, session, { model, language, labels }) {
  const sysOffsetSec = (session.offsets?.systemMinusMicMs ?? 0) / 1000;
  const vad = cfg.vad !== false; // speech-gating on by default

  const spinner = ora({ text: `Transcribing your microphone with ${model}…`, isEnabled: process.stdout.isTTY }).start();
  let micSegments = [];
  let systemSegments = [];
  try {
    micSegments = await transcribeFile(session.files.mic, { model, language, vad });
    spinner.text = `Transcribing participants (system audio) with ${model}…`;
    systemSegments = await transcribeFile(session.files.system, { model, language, vad });
    spinner.succeed('Transcription complete.');
  } catch (err) {
    spinner.fail('Transcription failed.');
    throw err;
  }

  const timeline = mergeTranscripts({
    micSegments,
    systemSegments,
    systemOffsetSec: sysOffsetSec,
    labels,
    coalesce: cfg.coalesceSpeakerTurns,
    maxSentencesPerTurn: cfg.maxSentencesPerTurn,
  });

  const durationSec = Math.max(
    probeDuration(session.files.mic),
    probeDuration(session.files.system),
    timeline.length ? timeline[timeline.length - 1].end : 0
  );

  const speakers = [];
  if (micSegments.length) speakers.push(labels.me);
  if (systemSegments.length) speakers.push(labels.participants);
  if (!speakers.length) speakers.push(labels.me, labels.participants);

  const ctx = { session, timeline, model, durationSec, speakers };
  const mdFile = writeMarkdown(cfg, ctx);

  logger.success(`Transcript: ${mdFile}`);
  return { mdFile, timeline };
}
