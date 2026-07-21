import os from 'node:os';

const platform = os.platform();

/**
 * Build the ffmpeg argv for capturing a single audio input device to a WAV file.
 *
 * @param {object} opts
 * @param {string} opts.deviceId  backend-specific device identifier (see devices/enumerate.js)
 * @param {string} opts.outFile   destination .wav path
 * @param {number} opts.sampleRate
 * @param {number} opts.channels
 * @param {string} opts.codec     e.g. "pcm_s16le"
 * @returns {string[]} ffmpeg arguments (excluding the binary name)
 */
export function buildCaptureArgs({ deviceId, outFile, sampleRate, channels, codec }) {
  const inputArgs = inputArgsForPlatform(deviceId);
  return [
    '-hide_banner',
    '-loglevel', 'error',
    ...inputArgs,
    '-ac', String(channels),
    '-ar', String(sampleRate),
    '-c:a', codec,
    '-y',
    outFile,
  ];
}

/**
 * Build the ffmpeg argv for capturing a device to a rolling series of WAV segments
 * (used by live transcription). Produces `<outDir>/mic_00000.wav`, `mic_00001.wav`, …
 * and a `<outDir>/mic_segments.csv` list (filename,start_time,end_time in seconds) that
 * is updated as each segment finalizes — including the final (possibly short) segment
 * on a graceful stop.
 */
export function buildSegmentedCaptureArgs({ deviceId, outDir, segSeconds, sampleRate, channels, codec, prefix = 'mic' }) {
  const inputArgs = inputArgsForPlatform(deviceId);
  return [
    '-hide_banner',
    '-loglevel', 'error',
    ...inputArgs,
    '-ac', String(channels),
    '-ar', String(sampleRate),
    '-c:a', codec,
    '-f', 'segment',
    '-segment_time', String(segSeconds),
    '-reset_timestamps', '1',
    '-segment_list', `${outDir}/${prefix}_segments.csv`,
    '-segment_list_type', 'csv',
    `${outDir}/${prefix}_%05d.wav`,
  ];
}

function inputArgsForPlatform(deviceId) {
  switch (platform) {
    case 'win32':
      // dshow device names are passed as audio="<name>"
      return ['-f', 'dshow', '-i', `audio=${deviceId}`];
    case 'darwin':
      // avfoundation audio-only input is ":<index>"
      return ['-f', 'avfoundation', '-i', deviceId];
    default:
      // PulseAudio / PipeWire-pulse
      return ['-f', 'pulse', '-i', deviceId];
  }
}
