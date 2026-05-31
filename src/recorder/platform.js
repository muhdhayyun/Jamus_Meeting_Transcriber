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
