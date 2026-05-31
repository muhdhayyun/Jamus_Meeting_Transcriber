import os from 'node:os';

const platform = os.platform();

/** OS-specific guidance for enabling a system-audio loopback source. */
export function loopbackSetupHelp() {
  if (platform === 'win32') {
    return [
      'No system-audio loopback device detected. To capture the *other* participants you need one of:',
      '  1) Enable "Stereo Mix": Sound settings → More sound settings → Recording tab →',
      '     right-click → Show Disabled Devices → enable "Stereo Mix".',
      '  2) Or install VB-CABLE (https://vb-audio.com/Cable/) and set the meeting app/Windows',
      '     output to "CABLE Input", then capture "CABLE Output" here.',
      'Tip: use headphones so your microphone does not re-record the meeting audio.',
    ].join('\n');
  }
  if (platform === 'darwin') {
    return [
      'No system-audio loopback device detected. On macOS install a loopback driver:',
      '  brew install blackhole-2ch',
      'Then open Audio MIDI Setup → create a Multi-Output Device (BlackHole + your headphones)',
      'so you still hear the call while it is captured. Grant Microphone + Screen Recording perms.',
    ].join('\n');
  }
  return [
    'No system-audio monitor source detected. On PulseAudio/PipeWire the loopback is the sink',
    'monitor, e.g. "alsa_output.<...>.monitor". List them with:  pactl list sources short',
  ].join('\n');
}

/** Pick the best loopback candidate from an enumerated device list, or null. */
export function pickLoopback(devices) {
  return devices.find((d) => d.isLoopbackCandidate) ?? null;
}

/** Pick a reasonable default microphone, or null. */
export function pickMic(devices) {
  return devices.find((d) => d.kind === 'mic') ?? devices.find((d) => !d.isLoopbackCandidate) ?? null;
}
