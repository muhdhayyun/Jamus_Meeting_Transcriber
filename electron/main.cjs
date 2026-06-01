// Electron main process (CommonJS). The core engine is ESM, so we load it via
// dynamic import() — this avoids Electron's ESM-main CJS-interop issues.
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const isWin = os.platform() === 'win32';
const imp = (rel) => import(pathToFileURL(path.join(__dirname, rel)).href);

let core = null;
let mainWindow = null;
let recordingState = null; // { cfg, session, stopResolver, donePromise }

async function loadCore() {
  const [config, ffmpeg, enumerate, loopback, session, recorder, wasapi, transcribe, modelManager, groq, meetings, storage] =
    await Promise.all([
      imp('../src/config.js'),
      imp('../src/utils/ffmpeg.js'),
      imp('../src/devices/enumerate.js'),
      imp('../src/devices/loopback.js'),
      imp('../src/pipeline/session.js'),
      imp('../src/recorder/recorder.js'),
      imp('../src/recorder/wasapiCapture.js'),
      imp('../src/pipeline/transcribeSession.js'),
      imp('../src/transcriber/modelManager.js'),
      imp('../src/insights/groq.js'),
      imp('../src/pipeline/meetings.js'),
      imp('../src/utils/storage.js'),
    ]);
  core = {
    loadConfig: config.loadConfig,
    saveUserConfig: config.saveUserConfig,
    assertFfmpegAvailable: ffmpeg.assertFfmpegAvailable,
    listAudioDevices: enumerate.listAudioDevices,
    pickLoopback: loopback.pickLoopback,
    pickMic: loopback.pickMic,
    createSession: session.createSession,
    loadSession: session.loadSession,
    recordSession: recorder.recordSession,
    wasapiBuilt: wasapi.wasapiBuilt,
    assertWasapiBuilt: wasapi.assertWasapiBuilt,
    transcribeSession: transcribe.transcribeSession,
    isBuilt: modelManager.isBuilt,
    isModelDownloaded: modelManager.isModelDownloaded,
    writeInsightsForSession: groq.writeInsightsForSession,
    listMeetings: meetings.listMeetings,
    readTranscript: meetings.readTranscript,
    readInsights: meetings.readInsights,
    renameMeeting: meetings.renameMeeting,
    recordingsSize: storage.recordingsSize,
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f5f6fa',
    title: 'Jamus',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  await loadCore();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

function status(msg) {
  mainWindow?.webContents.send('status', msg);
}

// ---- status / devices --------------------------------------------------
ipcMain.handle('app:status', async () => {
  const cfg = core.loadConfig();
  let ffmpeg = true;
  try { core.assertFfmpegAvailable(); } catch { ffmpeg = false; }
  const usedBytes = core.recordingsSize(cfg.resolved.recordings);
  return {
    platform: os.platform(),
    ffmpeg,
    whisperBuilt: core.isBuilt(),
    wasapiBuilt: isWin ? core.wasapiBuilt() : true,
    modelDownloaded: core.isModelDownloaded(cfg.model),
    model: cfg.model,
    storage: {
      usedGB: +(usedBytes / 1024 / 1024 / 1024).toFixed(2),
      capGB: cfg.storage?.maxRecordingsGB ?? 20,
    },
  };
});

ipcMain.handle('devices:list', async () => core.listAudioDevices().devices);

// ---- settings ----------------------------------------------------------
ipcMain.handle('settings:get', async () => {
  const cfg = core.loadConfig();
  return { model: cfg.model, language: cfg.language, labels: cfg.labels, devices: cfg.devices, storage: cfg.storage, groq: cfg.groq };
});

ipcMain.handle('settings:save', async (_e, partial) => {
  core.saveUserConfig(partial);
  return true;
});

// ---- meetings ----------------------------------------------------------
ipcMain.handle('meetings:list', async () => core.listMeetings(core.loadConfig()));

ipcMain.handle('meeting:get', async (_e, id) => {
  const cfg = core.loadConfig();
  const m = core.listMeetings(cfg).find((x) => x.id === id);
  if (!m) throw new Error('Meeting not found.');
  return { meeting: m, transcript: core.readTranscript(m), insights: core.readInsights(m) };
});

ipcMain.handle('open:transcripts', async () => {
  await shell.openPath(core.loadConfig().resolved.transcripts);
});

ipcMain.handle('meeting:rename', async (_e, { id, title }) => {
  core.renameMeeting(core.loadConfig(), id, title);
  return true;
});

// ---- recording ---------------------------------------------------------
ipcMain.handle('record:start', async (_e, { title, mic }) => {
  if (recordingState) throw new Error('Already recording.');
  const cfg = core.loadConfig();
  core.assertFfmpegAvailable();
  if (isWin) core.assertWasapiBuilt();

  const { devices } = core.listAudioDevices();
  const micId = mic || cfg.devices.mic || core.pickMic(devices)?.id;
  if (!micId) throw new Error('No microphone available.');

  let systemId;
  if (isWin) {
    systemId = 'wasapi';
  } else {
    const loop = core.pickLoopback(devices);
    if (!loop) throw new Error('No system-audio loopback device found (see README).');
    systemId = loop.id;
  }

  const session = core.createSession(cfg, { title, mic: micId, system: systemId, mode: cfg.recordMode });
  let stopResolver;
  const waitForStop = () => new Promise((r) => (stopResolver = r));
  const donePromise = core.recordSession(cfg, session, { waitForStop });
  await Promise.race([donePromise.then(() => 'done').catch(() => 'err'), new Promise((r) => setTimeout(r, 600))]);
  recordingState = { cfg, session, stopResolver, donePromise };
  return { id: session.id, title: session.title };
});

ipcMain.handle('record:stop', async (_e, { insights } = {}) => {
  if (!recordingState) throw new Error('Not recording.');
  const { cfg, session, stopResolver, donePromise } = recordingState;
  recordingState = null;

  status('Finalizing recording…');
  stopResolver?.();
  await donePromise;

  status(`Transcribing with ${cfg.model}…`);
  await core.transcribeSession(cfg, session, { model: cfg.model, language: cfg.language, labels: cfg.labels });

  if (insights ?? cfg.groq?.enabled) {
    try {
      status('Generating insights…');
      await core.writeInsightsForSession(cfg, session);
    } catch (err) {
      status(`Insights skipped: ${err.message}`);
    }
  }
  status('Done.');
  return { id: session.id };
});

ipcMain.handle('record:cancel', async () => {
  if (!recordingState) return false;
  const { stopResolver, donePromise } = recordingState;
  recordingState = null;
  stopResolver?.();
  try { await donePromise; } catch { /* ignore */ }
  return true;
});

// ---- insights ----------------------------------------------------------
ipcMain.handle('insights:generate', async (_e, id) => {
  const cfg = core.loadConfig();
  const session = core.loadSession(cfg, id);
  return core.writeInsightsForSession(cfg, session);
});
