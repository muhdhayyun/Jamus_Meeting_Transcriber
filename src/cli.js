import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import chalk from 'chalk';
import { select } from '@inquirer/prompts';

import { loadConfig, saveUserConfig } from './config.js';
import { assertFfmpegAvailable } from './utils/ffmpeg.js';
import { logger } from './utils/logger.js';
import { listAudioDevices } from './devices/enumerate.js';
import { loopbackSetupHelp, pickLoopback, pickMic } from './devices/loopback.js';
import { createSession, loadSession } from './pipeline/session.js';
import { recordSession } from './recorder/recorder.js';
import { transcribeSession } from './pipeline/transcribeSession.js';
import { KNOWN_MODELS, validateModel, isModelDownloaded } from './transcriber/modelManager.js';
import { transcribeFile } from './transcriber/whisper.js';

export async function run(argv) {
  const program = new Command();
  program
    .name('jamus')
    .description('Local meeting transcriber — records mic + system audio and writes a speaker-separated Markdown transcript.')
    .version('0.1.0');

  program
    .command('devices')
    .description('List audio input devices and check for a system-audio loopback source')
    .action(() => cmdDevices());

  program
    .command('record')
    .description('Record mic + system audio to a session (transcribe later)')
    .option('-t, --title <title>', 'meeting title')
    .option('--mic <device>', 'microphone device id/name')
    .option('--system <device>', 'system-audio (loopback) device id/name')
    .option('--mode <mode>', 'recording mode: dual | stereo', 'dual')
    .action((opts) => cmdRecord(opts));

  program
    .command('transcribe')
    .argument('<session>', 'session id, directory, or session.json path')
    .description('Transcribe a previously recorded session into Markdown + JSON')
    .option('-m, --model <model>', 'Whisper model')
    .option('--language <lang>', 'language code (or "auto")')
    .option('--me <name>', 'label for your own voice')
    .option('--others <name>', 'label for other participants')
    .option('--cuda', 'use the CUDA/GPU build of whisper.cpp')
    .action((sessionRef, opts) => cmdTranscribe(sessionRef, opts));

  program
    .command('run')
    .description('Record, then automatically transcribe when you stop')
    .option('-t, --title <title>', 'meeting title')
    .option('--mic <device>', 'microphone device id/name')
    .option('--system <device>', 'system-audio (loopback) device id/name')
    .option('--mode <mode>', 'recording mode: dual | stereo', 'dual')
    .option('-m, --model <model>', 'Whisper model')
    .option('--language <lang>', 'language code (or "auto")')
    .option('--me <name>', 'label for your own voice')
    .option('--others <name>', 'label for other participants')
    .option('--cuda', 'use the CUDA/GPU build of whisper.cpp')
    .action((opts) => cmdRun(opts));

  program
    .command('models')
    .description('List Whisper models and download status')
    .option('--list', 'list known models (default action)')
    .option('--download <name>', 'pre-download a model so it is ready offline')
    .action((opts) => cmdModels(opts));

  await program.parseAsync(argv);
}

// ---------------------------------------------------------------- devices
function cmdDevices() {
  assertFfmpegAvailable();
  const { platform, backend, devices } = listAudioDevices();
  logger.info(chalk.bold(`\nAudio input devices  ${chalk.dim(`(${platform} / ${backend})`)}\n`));

  if (devices.length === 0) {
    logger.warn('No audio input devices found. Is FFmpeg installed and are devices connected?');
  } else {
    for (const d of devices) {
      const tag =
        d.kind === 'loopback' ? chalk.green('[loopback]') : d.kind === 'mic' ? chalk.cyan('[mic]') : chalk.dim('[input]');
      logger.info(`  ${tag} ${d.name}`);
    }
  }

  const loop = pickLoopback(devices);
  logger.info('');
  if (loop) {
    logger.success(`System-audio loopback available: "${loop.name}"`);
  } else {
    logger.warn('No system-audio loopback detected.\n');
    logger.dim(loopbackSetupHelp());
  }
}

// ---------------------------------------------------------------- record
async function cmdRecord(opts) {
  const cfg = loadConfig();
  assertFfmpegAvailable();
  const session = await startRecording(cfg, opts);
  logger.success(`Saved session "${session.id}".`);
  logger.dim(`Transcribe it later with:  jamus transcribe ${session.id}`);
}

// ---------------------------------------------------------------- transcribe
async function cmdTranscribe(sessionRef, opts) {
  const cfg = loadConfig();
  assertFfmpegAvailable();
  const session = loadSession(cfg, sessionRef);
  const labels = {
    me: opts.me || cfg.labels.me,
    participants: opts.others || cfg.labels.participants,
  };
  const model = validateModel(opts.model || cfg.model);
  await transcribeSession(cfg, session, {
    model,
    language: opts.language || cfg.language,
    withCuda: !!opts.cuda || !!process.env.JAMUS_CUDA,
    labels,
  });
}

// ---------------------------------------------------------------- run
async function cmdRun(opts) {
  const cfg = loadConfig();
  assertFfmpegAvailable();
  const session = await startRecording(cfg, opts);
  const labels = {
    me: opts.me || cfg.labels.me,
    participants: opts.others || cfg.labels.participants,
  };
  const model = validateModel(opts.model || cfg.model);
  if (!isModelDownloaded(model)) {
    logger.dim(`Model "${model}" is not downloaded yet — it will be fetched now (first run only).`);
  }
  await transcribeSession(cfg, session, {
    model,
    language: opts.language || cfg.language,
    withCuda: !!opts.cuda || !!process.env.JAMUS_CUDA,
    labels,
  });
}

// ---------------------------------------------------------------- models
async function cmdModels(opts) {
  const cfg = loadConfig();
  if (opts.download) {
    const name = validateModel(opts.download);
    assertFfmpegAvailable();
    logger.step(`Downloading Whisper model "${name}" (this can take a while for large models)…`);
    await predownloadModel(cfg, name);
    logger.success(`Model "${name}" is ready.`);
    return;
  }
  logger.info(chalk.bold('\nWhisper models\n'));
  for (const m of KNOWN_MODELS) {
    const here = isModelDownloaded(m);
    const mark = here ? chalk.green('✔ downloaded') : chalk.dim('– not downloaded');
    const def = m === cfg.model ? chalk.yellow('  (default)') : '';
    logger.info(`  ${m.padEnd(16)} ${mark}${def}`);
  }
  logger.dim('\nModels download automatically on first transcription, or pre-fetch with: jamus models --download <name>');
}

// ---------------------------------------------------------------- helpers

/** Resolve devices (flags → saved config → interactive), create + run a recording session. */
async function startRecording(cfg, opts) {
  const { mic, system } = await resolveDevices(cfg, opts);
  const session = createSession(cfg, {
    title: opts.title || 'Untitled meeting',
    mic,
    system,
    mode: opts.mode || cfg.recordMode,
  });

  logger.info('');
  logger.info(chalk.bold(`Recording "${session.title}"`));
  logger.dim(`  mic    → ${mic}`);
  logger.dim(`  system → ${system}`);
  logger.dim(`  files  → ${path.relative(process.cwd(), session.dir)}`);
  logger.info('');

  return recordSession(cfg, session, { waitForStop });
}

/** Choose mic + system devices, persisting interactive choices for next time. */
async function resolveDevices(cfg, opts) {
  const { devices } = listAudioDevices();

  let mic = opts.mic || cfg.devices.mic;
  let system = opts.system || cfg.devices.system;
  let chose = false;

  if (!mic) {
    const def = pickMic(devices);
    mic = await pickDevice('Select your MICROPHONE (your voice):', devices, def?.id);
    chose = true;
  }
  if (!system) {
    const loop = pickLoopback(devices);
    if (!loop && devices.every((d) => !d.isLoopbackCandidate)) {
      logger.warn('No system-audio loopback detected.\n');
      logger.dim(loopbackSetupHelp());
      throw new Error('Set up a system-audio loopback (see above), then run "jamus devices" to confirm.');
    }
    system = await pickDevice('Select your SYSTEM-AUDIO loopback (other speakers):', devices, loop?.id);
    chose = true;
  }

  if (chose && process.stdin.isTTY) {
    saveUserConfig({ devices: { mic, system } });
    logger.dim(`Saved device choices to ${path.join(os.homedir(), '.jamus', 'config.json')}`);
  }
  return { mic, system };
}

async function pickDevice(message, devices, defaultId) {
  if (devices.length === 0) throw new Error('No audio input devices available.');
  return select({
    message,
    default: defaultId,
    choices: devices.map((d) => ({
      name: `${d.name}${d.isLoopbackCandidate ? ' (loopback)' : d.kind === 'mic' ? ' (mic)' : ''}`,
      value: d.id,
    })),
  });
}

/** Resolve when the user presses Enter or hits Ctrl+C. */
function waitForStop() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const done = () => {
      rl.close();
      process.off('SIGINT', done);
      resolve();
    };
    rl.on('line', done);
    process.once('SIGINT', done);
  });
}

/** Force a model download by transcribing a short silent clip. */
async function predownloadModel(cfg, name) {
  const tmp = path.join(os.tmpdir(), `jamus-silence-${Date.now()}.wav`);
  const r = spawnSync(
    process.env.JAMUS_FFMPEG || 'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '0.3', '-c:a', 'pcm_s16le', '-y', tmp],
    { encoding: 'utf8' }
  );
  if (r.status !== 0) throw new Error(`Could not create a temp audio file for model download: ${r.stderr}`);
  await transcribeFile(tmp, { model: name, withCuda: !!process.env.JAMUS_CUDA });
  try { (await import('node:fs')).unlinkSync(tmp); } catch { /* ignore */ }
}
