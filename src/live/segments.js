import fs from 'node:fs';
import path from 'node:path';

/**
 * Parse one line of the WASAPI recorder's segments.jsonl manifest:
 *   {"index":0,"file":"seg_00000.wav","startMs":0,"durationMs":2420}
 */
function parseWasapiLine(line) {
  const obj = JSON.parse(line);
  return { index: obj.index, file: obj.file, startMs: obj.startMs, durationMs: obj.durationMs };
}

/**
 * Parse one line of ffmpeg's `-segment_list_type csv` output:
 *   mic_00000.wav,0.000000,2.026000
 */
function parseFfmpegCsvLine(line) {
  const [file, startSec, endSec] = line.split(',');
  const m = file.match(/(\d+)(?=\.\w+$)/);
  const index = m ? parseInt(m[1], 10) : 0;
  const startMs = Math.round(parseFloat(startSec) * 1000);
  const endMs = Math.round(parseFloat(endSec) * 1000);
  return { index, file, startMs, durationMs: endMs - startMs };
}

/**
 * Polls a segment manifest file (WASAPI jsonl or ffmpeg csv) and yields newly
 * completed segment entries since the last poll. Only lines that end with a
 * newline are considered — an in-progress final write is never half-read.
 */
export class ManifestTailer {
  constructor(manifestPath, format) {
    this.manifestPath = manifestPath;
    this.parseLine = format === 'wasapi' ? parseWasapiLine : parseFfmpegCsvLine;
    this.seen = 0;
  }

  /** @returns {Array<{index:number,file:string,startMs:number,durationMs:number}>} */
  poll() {
    let text;
    try {
      text = fs.readFileSync(this.manifestPath, 'utf8');
    } catch {
      return [];
    }
    if (!text) return [];
    const endsWithNewline = text.endsWith('\n') || text.endsWith('\r\n');
    const rawLines = text.split(/\r?\n/).filter((l) => l.length > 0);
    // Drop a trailing partial line if the file didn't end with a newline.
    const completeLines = endsWithNewline ? rawLines : rawLines.slice(0, -1);

    if (completeLines.length <= this.seen) return [];
    const newLines = completeLines.slice(this.seen);
    this.seen = completeLines.length;

    const entries = [];
    for (const line of newLines) {
      try {
        entries.push(this.parseLine(line));
      } catch {
        // Skip a malformed/partial line rather than crash the live session.
      }
    }
    return entries;
  }
}

/** Absolute path to a segment's WAV file given the entry from a tailer. */
export function segmentFilePath(outDir, entry) {
  return path.join(outDir, entry.file);
}
