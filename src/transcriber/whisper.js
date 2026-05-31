import fs from 'node:fs';
import path from 'node:path';
import { nodewhisper } from 'nodejs-whisper';
import { validateModel } from './modelManager.js';
import { logger } from '../utils/logger.js';
import { fileExists, fileSize } from '../utils/fsx.js';

/**
 * Transcribe a single WAV file with local whisper.cpp.
 *
 * @returns {Promise<Array<{start:number,end:number,text:string}>>} segments in seconds.
 */
export async function transcribeFile(file, { model = 'large-v3', language = 'auto', withCuda = false } = {}) {
  validateModel(model);
  if (!fileExists(file) || fileSize(file) === 0) {
    logger.warn(`Skipping transcription — empty or missing file: ${file}`);
    return [];
  }

  const startedAt = Date.now();
  await nodewhisper(file, {
    modelName: model,
    autoDownloadModelName: model, // downloads the ggml model on first use
    removeWavFileAfterTranscription: false,
    withCuda,
    whisperOptions: {
      outputInJson: true,
      outputInSrt: true, // fallback parser source
      outputInText: false,
      outputInVtt: false,
      outputInCsv: false,
      translateToEnglish: false,
      wordTimestamps: false,
      language: language === 'auto' ? undefined : language,
      splitOnWord: true,
    },
  });
  logger.debug(`whisper finished ${path.basename(file)} in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  const segments = readWhisperOutput(file);
  // Clean up the intermediate output files whisper wrote next to the wav.
  cleanupArtifacts(file);
  return segments;
}

/** Locate and parse whisper's output (prefer JSON, fall back to SRT). */
function readWhisperOutput(wavFile) {
  const dir = path.dirname(wavFile);
  const base = path.basename(wavFile, path.extname(wavFile)); // e.g. "mic"

  const candidates = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(base) && (f.endsWith('.json') || f.endsWith('.srt')))
    .map((f) => path.join(dir, f));

  const jsonFile = candidates.find((f) => f.endsWith('.json'));
  if (jsonFile) {
    const parsed = parseWhisperJson(jsonFile);
    if (parsed.length) return parsed;
  }
  const srtFile = candidates.find((f) => f.endsWith('.srt'));
  if (srtFile) return parseSrt(srtFile);

  logger.warn(`No whisper output found next to ${wavFile}`);
  return [];
}

function parseWhisperJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const items = data.transcription ?? data.segments ?? [];
    return items
      .map((it) => {
        // whisper.cpp JSON: offsets.from/to in milliseconds
        const fromMs = it.offsets?.from ?? msFromTimestamp(it.timestamps?.from) ?? 0;
        const toMs = it.offsets?.to ?? msFromTimestamp(it.timestamps?.to) ?? fromMs;
        return { start: fromMs / 1000, end: toMs / 1000, text: cleanText(it.text) };
      })
      .filter((s) => s.text);
  } catch (err) {
    logger.debug(`Failed to parse whisper JSON ${file}: ${err.message}`);
    return [];
  }
}

function parseSrt(file) {
  const text = fs.readFileSync(file, 'utf8');
  const blocks = text.split(/\r?\n\r?\n/);
  const segments = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) continue;
    const timeLine = lines.find((l) => l.includes('-->'));
    if (!timeLine) continue;
    const [from, to] = timeLine.split('-->').map((s) => srtToSeconds(s.trim()));
    const content = lines.slice(lines.indexOf(timeLine) + 1).join(' ');
    const clean = cleanText(content);
    if (clean) segments.push({ start: from, end: to, text: clean });
  }
  return segments;
}

function srtToSeconds(ts) {
  // 00:00:01,000
  const m = ts.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  const [, h, mm, s, ms] = m;
  return +h * 3600 + +mm * 60 + +s + +ms / 1000;
}

function msFromTimestamp(ts) {
  if (!ts) return null;
  return srtToSeconds(ts) * 1000;
}

function cleanText(t) {
  return String(t ?? '')
    .replace(/\[(BLANK_AUDIO|SILENCE|MUSIC|NOISE|INAUDIBLE).*?\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanupArtifacts(wavFile) {
  const dir = path.dirname(wavFile);
  const base = path.basename(wavFile, path.extname(wavFile));
  for (const f of fs.readdirSync(dir)) {
    if (f === path.basename(wavFile)) continue; // keep the wav
    if (f.startsWith(base) && /\.(json|srt|vtt|txt|csv|tsv)$/i.test(f)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
    }
  }
}
