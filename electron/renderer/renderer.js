const J = window.jamus;
const $ = (sel) => document.querySelector(sel);
const view = $('#view');
const statusBar = $('#statusBar');

// Apply the saved theme immediately to avoid a flash.
document.documentElement.dataset.theme = localStorage.getItem('jamus-theme') || 'light';
function applyTheme(t) {
  const theme = t === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('jamus-theme', theme);
  const btn = $('#themeBtn');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
}

let state = {
  meetings: [],
  activeId: null,
  recording: false,
  recTimer: null,
  recStart: 0,
  status: null,
  settings: null,
  liveTab: 'transcript',
  liveTimeline: [],
  liveSummary: '',
  liveUnsubs: [],
};

// ---------- helpers ----------
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function fmtDur(sec) {
  sec = Math.floor(sec || 0);
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
function inline(s) {
  return esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>');
}

/** Render transcript/insights Markdown to HTML (with speaker-turn styling). */
function renderMarkdown(md, labels) {
  const me = labels?.me || 'Me';
  const lines = md.split(/\r?\n/);
  let html = '';
  let inList = false;
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const turn = line.match(/^\*\*\[(.+?)\]\s+(.+?):\*\*\s*(.*)$/);
    if (turn) {
      closeList();
      const [, ts, who, txt] = turn;
      const cls = who === me ? 'me' : 'them';
      html += `<div class="turn"><span class="who ${cls}">${esc(who)}</span><span class="ts">${esc(ts)}</span><div class="txt">${inline(txt)}</div></div>`;
      continue;
    }
    if (/^###\s+/.test(line)) { closeList(); html += `<h3>${inline(line.replace(/^###\s+/, ''))}</h3>`; continue; }
    if (/^##\s+/.test(line)) { closeList(); html += `<h2>${inline(line.replace(/^##\s+/, ''))}</h2>`; continue; }
    if (/^#\s+/.test(line)) { closeList(); html += `<h1>${inline(line.replace(/^#\s+/, ''))}</h1>`; continue; }
    if (/^---+$/.test(line)) { closeList(); html += '<hr/>'; continue; }
    if (/^[-*]\s+/.test(line)) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`; continue; }
    if (line === '') { closeList(); continue; }
    closeList();
    html += `<p>${inline(line)}</p>`;
  }
  closeList();
  return html;
}

/** Render a live in-progress timeline ([{start,speaker,text}]) the same way the markdown turns look. */
function renderLiveTurns(timeline, labels) {
  const me = labels?.me || 'Me';
  if (!timeline.length) {
    return `<div class="live-placeholder">Listening… the transcript will appear here as people speak.</div>`;
  }
  return timeline.map((t) => {
    const cls = t.speaker === me ? 'me' : 'them';
    return `<div class="turn"><span class="who ${cls}">${esc(t.speaker)}</span><span class="ts">${esc(fmtDur(t.start))}</span><div class="txt">${inline(t.text)}</div></div>`;
  }).join('');
}

// ---------- data ----------
async function refreshMeetings() {
  state.meetings = await J.listMeetings();
  renderMeetingList();
}

function renderMeetingList() {
  const el = $('#meetingList');
  if (!state.meetings.length) {
    el.innerHTML = `<div style="color:var(--muted);font-size:12.5px;padding:10px 8px;">No meetings yet. Hit “New recording”.</div>`;
    return;
  }
  el.innerHTML = state.meetings.map((m) => `
    <div class="meeting-item ${m.id === state.activeId ? 'active' : ''}" data-id="${m.id}">
      <div class="mi-title">${esc(m.title)}</div>
      <div class="mi-meta">
        <span>${esc(m.date)}</span><span>·</span><span>${fmtDur(m.durationSec)}</span>
        ${m.hasInsights ? '<span class="badge">insights</span>' : m.hasTranscript ? '<span class="badge gray">transcript</span>' : ''}
      </div>
    </div>`).join('');
  el.querySelectorAll('.meeting-item').forEach((it) => it.addEventListener('click', () => openMeeting(it.dataset.id)));
}

// ---------- views ----------
function setStatus(msg) {
  if (!msg) { statusBar.classList.add('hidden'); return; }
  statusBar.textContent = msg;
  statusBar.classList.remove('hidden');
}

function renderEmpty() {
  state.activeId = null;
  renderMeetingList();
  const s = state.status;
  let warn = '';
  if (s) {
    const issues = [];
    if (!s.ffmpeg) issues.push('FFmpeg not found — install it (see README).');
    if (!s.whisperBuilt) issues.push('whisper.cpp not built — run <code>npm run build:whisper</code>.');
    if (!s.wasapiBuilt) issues.push('WASAPI recorder not built — run <code>npm run build:wasapi</code>.');
    if (issues.length) warn = `<div class="setup-warn"><strong>Setup needed:</strong><ul style="margin:6px 0 0 18px;">${issues.map((i) => `<li>${i}</li>`).join('')}</ul></div>`;
  }
  view.innerHTML = `${warn}
    <div class="empty">
      <div class="big">🎙️</div>
      <h2>Welcome to Jamus</h2>
      <p>Record a meeting and get a speaker-separated transcript — fully local.<br/>Your mic is “Me”, system audio is “Participants”.</p>
      <button class="btn primary" id="emptyRecord">＋ New recording</button>
    </div>`;
  $('#emptyRecord')?.addEventListener('click', openRecordPanel);
}

async function openRecordPanel() {
  state.activeId = null;
  renderMeetingList();
  const [devices, settings] = await Promise.all([
    J.listDevices().catch(() => []),
    J.getSettings().catch(() => state.settings),
  ]);
  state.settings = settings || state.settings;
  const mics = devices.filter((d) => !d.isLoopbackCandidate);
  const savedMic = state.settings?.devices?.mic;
  const today = new Date().toISOString().slice(0, 10);
  view.innerHTML = `
    <div style="max-width:520px;">
      <h1 style="font-size:22px;font-weight:700;margin-bottom:4px;">New recording</h1>
      <p style="color:var(--muted);font-size:13px;margin-bottom:20px;">System audio is captured automatically. Use headphones so your mic doesn't pick up the other speakers.</p>
      <div class="field">
        <label>Meeting title</label>
        <input type="text" id="recTitle" value="Meeting ${today}" />
      </div>
      <div class="field">
        <label>Microphone</label>
        <select id="recMic">${mics.map((m) => `<option value="${esc(m.id)}" ${m.id === savedMic ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
        ${mics.length ? '' : '<div class="hint" style="color:var(--warn)">No microphone detected.</div>'}
      </div>
      <div class="field" id="sysAudioField"></div>
      <button class="btn primary" id="startRec" ${mics.length ? '' : 'disabled'}>● Start recording</button>
    </div>`;
  $('#startRec')?.addEventListener('click', startRecording);
  renderSysAudioStatus();
}

function renderSysAudioStatus() {
  const el = $('#sysAudioField');
  if (!el) return;
  const sa = state.settings?.systemAudio || {};
  const name = sa.excludeProcess;
  const on = name && sa.enabled !== false;
  el.innerHTML = name
    ? `<label>System audio</label>
       <div class="toggle-row" style="margin:0;">
         <span>${on ? `🔇 Excluding <strong>${esc(name)}</strong> — everything else is captured` : `Excluding <strong>${esc(name)}</strong> is off — capturing everything`}</span>
         <input type="checkbox" id="sysAudioToggle" ${on ? 'checked' : ''} />
       </div>`
    : `<label>System audio</label><div class="hint" style="margin:0;">Capturing everything. Set an app to exclude (e.g. Spotify) in Settings.</div>`;
  $('#sysAudioToggle')?.addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    await J.saveSettings({ systemAudio: { enabled } });
    state.settings = await J.getSettings().catch(() => state.settings);
    renderSysAudioStatus();
  });
}

async function startRecording() {
  const title = $('#recTitle').value.trim() || 'Untitled meeting';
  const mic = $('#recMic').value;
  $('#startRec').disabled = true;
  setStatus('Starting…');
  try {
    await J.startLive({ title, mic });
  } catch (err) {
    setStatus(null);
    alert('Could not start recording:\n\n' + err.message);
    return openRecordPanel();
  }
  setStatus(null);
  state.recording = true;
  state.recStart = Date.now();
  state.liveTimeline = [];
  state.liveSummary = '';
  state.liveTab = 'transcript';
  renderRecording(title);
}

function renderRecording(title) {
  view.innerHTML = `
    <div class="recording-view">
      <div class="rec-header">
        <div class="pulse">●</div>
        <div class="timer" id="recTimerEl">00:00:00</div>
        <div class="rec-sub">Recording “${esc(title)}” — your mic + system audio</div>
        <div class="rec-actions">
          <button class="btn danger" id="stopRec">■ Stop &amp; finish</button>
          <button class="btn" id="cancelRec">Cancel</button>
        </div>
        <div class="tabs" style="margin:14px 0 0;">
          <div class="tab ${state.liveTab === 'transcript' ? 'active' : ''}" data-livetab="transcript"><span class="live-dot"></span>Live Transcript</div>
          <div class="tab ${state.liveTab === 'summary' ? 'active' : ''}" data-livetab="summary">Live Summary</div>
        </div>
      </div>
      <div class="rec-live" id="recLive"></div>
    </div>`;
  clearInterval(state.recTimer);
  state.recTimer = setInterval(() => {
    $('#recTimerEl').textContent = fmtDur((Date.now() - state.recStart) / 1000);
  }, 500);
  $('#stopRec').addEventListener('click', stopRecording);
  $('#cancelRec').addEventListener('click', cancelRecording);
  view.querySelectorAll('[data-livetab]').forEach((t) => t.addEventListener('click', () => {
    state.liveTab = t.dataset.livetab;
    view.querySelectorAll('[data-livetab]').forEach((x) => x.classList.toggle('active', x === t));
    paintLive();
  }));

  // Subscribe to live updates for the duration of this recording view.
  const labels = state.settings?.labels || { me: 'Me', participants: 'Participants' };
  state.liveUnsubs.push(J.onLiveTranscript((timeline) => { state.liveTimeline = timeline; if (state.liveTab === 'transcript') paintLive(); }));
  state.liveUnsubs.push(J.onLiveSummary((text) => { state.liveSummary = text; if (state.liveTab === 'summary') paintLive(); }));
  paintLive();

  function paintLive() {
    const el = $('#recLive');
    if (!el) return;
    if (state.liveTab === 'transcript') {
      el.innerHTML = `<div class="md">${renderLiveTurns(state.liveTimeline, labels)}</div>`;
    } else {
      el.innerHTML = state.liveSummary
        ? `<div class="md">${renderMarkdown(state.liveSummary, labels)}</div>`
        : `<div class="live-placeholder">Building a summary from the conversation so far — check back shortly.</div>`;
    }
  }
}

function unsubscribeLive() {
  state.liveUnsubs.forEach((fn) => { try { fn(); } catch { /* ignore */ } });
  state.liveUnsubs = [];
}

async function stopRecording() {
  clearInterval(state.recTimer);
  state.recording = false;
  $('#stopRec').disabled = true;
  $('#cancelRec').disabled = true;
  unsubscribeLive();
  const wantInsights = !!(state.settings?.groq?.enabled && state.settings?.groq?.apiKey);
  let result;
  try {
    result = await J.stopLive({ insights: wantInsights });
  } catch (err) {
    setStatus(null);
    alert('Finishing the recording failed:\n\n' + err.message);
    return renderEmpty();
  }
  setStatus(null);
  await refreshMeetings();
  if (result?.id) openMeeting(result.id);
}

async function cancelRecording() {
  clearInterval(state.recTimer);
  state.recording = false;
  unsubscribeLive();
  await J.cancelLive().catch(() => {});
  setStatus(null);
  renderEmpty();
}

async function openImport() {
  const picked = await J.importPick();
  if (!picked || !picked.length) return;
  const wantInsights = !!(state.settings?.groq?.enabled && state.settings?.groq?.apiKey);
  const stripExt = (n) => n.replace(/\.[^.]+$/, '');

  if (picked.length > 1) {
    if (!confirm(`Transcribe ${picked.length} files? Each becomes its own transcript, titled by filename.`)) return;
    setStatus('Importing…');
    let res;
    try { res = await J.importRun({ files: picked.map((f) => ({ path: f.path, title: stripExt(f.name) })), insights: wantInsights }); }
    catch (e) { setStatus(null); alert('Import failed:\n\n' + e.message); return renderEmpty(); }
    setStatus(null);
    await refreshMeetings();
    if (res?.ids?.length) openMeeting(res.ids[res.ids.length - 1]);
    return;
  }

  const f = picked[0];
  const defTitle = stripExt(f.name);
  state.activeId = null;
  renderMeetingList();
  view.innerHTML = `
    <div style="max-width:520px;">
      <h1 style="font-size:22px;font-weight:700;margin-bottom:4px;">Import recording</h1>
      <p style="color:var(--muted);font-size:13px;margin-bottom:20px;">${esc(f.name)} → transcribed as a single-speaker transcript.</p>
      <div class="field"><label>Title</label><input type="text" id="impTitle" value="${esc(defTitle)}" /></div>
      <button class="btn primary" id="impGo">Transcribe</button>
    </div>`;
  $('#impGo').addEventListener('click', async () => {
    $('#impGo').disabled = true;
    const title = $('#impTitle').value.trim() || defTitle;
    setStatus('Importing & transcribing…');
    let res;
    try { res = await J.importRun({ files: [{ path: f.path, title }], insights: wantInsights }); }
    catch (e) { setStatus(null); alert('Import failed:\n\n' + e.message); return renderEmpty(); }
    setStatus(null);
    await refreshMeetings();
    if (res?.ids?.[0]) openMeeting(res.ids[0]);
  });
}

async function openMeeting(id) {
  state.activeId = id;
  renderMeetingList();
  let data;
  try {
    data = await J.getMeeting(id);
  } catch (err) {
    return alert(err.message);
  }
  const { meeting, transcript, insights } = data;
  const labels = state.settings?.labels || { me: 'Me', participants: 'Participants' };
  renderDetail(meeting, transcript, insights, labels, 'transcript');
}

function renderDetail(meeting, transcript, insights, labels, tab) {
  const hasInsights = !!insights.trim();
  view.innerHTML = `
    <div class="detail-head">
      <div class="title-row">
        <h1>${esc(meeting.title)}</h1>
        <button class="icon-btn" id="renameBtn" title="Rename meeting">✎</button>
        ${meeting.hasAudio ? '<button class="icon-btn" id="delAudioBtn" title="Delete audio (keeps transcript)">🗑</button>' : ''}
      </div>
      <div class="detail-meta">
        <span>📅 ${esc(meeting.date)}</span>
        <span>⏱ ${fmtDur(meeting.durationSec)}</span>
        <span>${meeting.hasTranscript ? '📝 transcribed' : '⚠ not transcribed'}</span>
        <span>${meeting.hasAudio ? '🎵 audio kept' : '🎵 audio deleted'}</span>
      </div>
    </div>
    <div class="tabs">
      <div class="tab ${tab === 'transcript' ? 'active' : ''}" data-tab="transcript">Transcript</div>
      <div class="tab ${tab === 'insights' ? 'active' : ''}" data-tab="insights">Insights</div>
    </div>
    <div id="tabContent"></div>`;
  view.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
    view.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
    paintTab(t.dataset.tab, meeting, transcript, insights, labels);
  }));
  $('#renameBtn')?.addEventListener('click', () => startRename(meeting));
  $('#delAudioBtn')?.addEventListener('click', async () => {
    if (!confirm(`Delete the audio recording for “${meeting.title}”?\n\nThis frees disk space and keeps the transcript, but you won't be able to re-transcribe this meeting.`)) return;
    setStatus('Deleting audio…');
    await J.deleteAudio(meeting.id).catch((e) => alert(e.message));
    setStatus(null);
    await refreshMeetings();
    openMeeting(meeting.id);
  });
  paintTab(tab, meeting, transcript, insights, labels);
}

function startRename(meeting) {
  const head = document.querySelector('.detail-head');
  head.innerHTML = `<div class="rename-edit">
    <input id="renameInput" type="text" value="${esc(meeting.title)}" />
    <div class="actions"><button class="btn primary" id="renameSave">Save</button><button class="btn" id="renameCancel">Cancel</button></div>
  </div>`;
  const input = $('#renameInput');
  input.focus(); input.select();
  const save = async () => {
    const t = input.value.trim();
    if (!t) return;
    try { await J.renameMeeting(meeting.id, t); } catch (e) { return alert(e.message); }
    await refreshMeetings();
    openMeeting(meeting.id);
  };
  $('#renameSave').addEventListener('click', save);
  $('#renameCancel').addEventListener('click', () => openMeeting(meeting.id));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') openMeeting(meeting.id);
  });
}

function paintTab(tab, meeting, transcript, insights, labels) {
  const el = $('#tabContent');
  if (tab === 'transcript') {
    el.innerHTML = transcript.trim() ? `<div class="md">${renderMarkdown(transcript, labels)}</div>`
      : `<div class="insights-empty"><p>No transcript for this meeting.</p></div>`;
    return;
  }
  // insights tab
  if (insights.trim()) {
    el.innerHTML = `<div style="margin-bottom:12px;"><button class="btn" id="regen">↻ Regenerate</button></div><div class="md">${renderMarkdown(insights, labels)}</div>`;
  } else {
    const ready = !!(state.settings?.groq?.apiKey);
    el.innerHTML = `<div class="insights-empty">
      <p>No insights yet.</p>
      ${ready ? '' : '<p style="font-size:13px;">Add your Groq API key in <strong>Settings</strong> to enable insights.</p>'}
      <button class="btn primary" id="genIns" ${ready ? '' : 'disabled'}>✨ Generate insights</button>
    </div>`;
  }
  $('#genIns')?.addEventListener('click', () => doInsights(meeting.id));
  $('#regen')?.addEventListener('click', () => doInsights(meeting.id));
}

async function doInsights(id) {
  setStatus('Generating insights with Groq…');
  try {
    await J.generateInsights(id);
  } catch (err) {
    setStatus(null);
    return alert('Insights failed:\n\n' + err.message);
  }
  setStatus(null);
  await refreshMeetings();
  const data = await J.getMeeting(id);
  renderDetail(data.meeting, data.transcript, data.insights, state.settings?.labels, 'insights');
}

// ---------- settings ----------
async function openSettings() {
  state.settings = await J.getSettings();
  const s = state.settings;
  const st = state.status || {};
  const sections = s.groq?.sections || [];
  const sec = (k, label) => `<label class="check"><input type="checkbox" data-sec="${k}" ${sections.includes(k) ? 'checked' : ''}/> ${label}</label>`;
  const modelOpts = ['large-v3-turbo', 'large-v3', 'large-v2', 'medium.en', 'small.en', 'base.en', 'tiny.en']
    .map((m) => `<option value="${m}" ${s.model === m ? 'selected' : ''}>${m}</option>`).join('');
  $('#settingsBody').innerHTML = `
    <div class="section-title">Transcription</div>
    <div class="row">
      <div class="field"><label>Whisper model</label><select id="setModel">${modelOpts}</select></div>
      <div class="field"><label>Language</label><input type="text" id="setLang" value="${esc(s.language || 'auto')}" /></div>
    </div>
    <div class="row">
      <div class="field"><label>Your label</label><input type="text" id="setMe" value="${esc(s.labels?.me || 'Me')}" /></div>
      <div class="field"><label>Others label</label><input type="text" id="setOthers" value="${esc(s.labels?.participants || 'Participants')}" /></div>
    </div>
    <div class="field">
      <label>Break up long turns after (sentences)</label>
      <input type="number" id="setMaxSentences" min="1" max="50" value="${esc(s.maxSentencesPerTurn ?? 6)}" style="max-width:120px;" />
      <div class="hint">If one person talks for a while with no reply, the transcript starts a new paragraph after this many sentences instead of one long block.</div>
    </div>

    <div class="section-title">Storage</div>
    <div class="field">
      <label>Recording size cap (GB)</label>
      <input type="number" id="setCap" min="1" value="${esc(s.storage?.maxRecordingsGB ?? 20)}" />
      <div class="storage-bar"><div class="storage-fill" style="width:${st.storage ? Math.min(100, (st.storage.usedGB / (st.storage.capGB || 20)) * 100) : 0}%"></div></div>
      <div class="hint">${st.storage ? `Using ${st.storage.usedGB} GB of ${st.storage.capGB} GB. Oldest audio is cleared past the cap (transcripts kept).` : ''}</div>
      <button class="btn" id="delAllAudio" type="button" style="margin-top:10px;">🗑 Delete all recording audio</button>
      <div class="hint">Frees the most space. Transcripts &amp; insights are kept; meetings stay listed.</div>
    </div>

    <div class="section-title">System Audio</div>
    <div class="field toggle-row">
      <label style="margin:0;">Exclude an app from system-audio capture</label>
      <input type="checkbox" id="setExcludeEnabled" ${s.systemAudio?.enabled !== false ? 'checked' : ''} />
    </div>
    <div class="field">
      <input type="text" id="setExcludeProcess" value="${esc(s.systemAudio?.excludeProcess || '')}" placeholder="e.g. Spotify.exe" />
      <div class="hint">That app's sound is left out of the recording; everything else you hear is still captured. Only one app at a time. Windows 10 2004+ / Windows 11 only. Leave blank (or turn the toggle off) to capture everything.</div>
    </div>

    <div class="section-title">Live Mode (while recording)</div>
    <div class="row">
      <div class="field">
        <label>Live summary provider</label>
        <select id="setLiveProvider">
          <option value="ollama" ${(s.live?.summaryProvider ?? 'ollama') === 'ollama' ? 'selected' : ''}>Ollama (local, free)</option>
          <option value="groq" ${s.live?.summaryProvider === 'groq' ? 'selected' : ''}>Groq (cloud)</option>
          <option value="off" ${s.live?.summaryProvider === 'off' ? 'selected' : ''}>Off</option>
        </select>
      </div>
      <div class="field"><label>Summary refresh (seconds)</label><input type="number" id="setLiveInterval" min="15" value="${esc(s.live?.summaryIntervalSec ?? 45)}" /></div>
    </div>
    <div class="row">
      <div class="field"><label>Ollama model</label><input type="text" id="setOllamaModel" value="${esc(s.live?.ollama?.model || 'llama3.1:8b')}" /></div>
      <div class="field"><label>Ollama URL</label><input type="text" id="setOllamaUrl" value="${esc(s.live?.ollama?.url || 'http://127.0.0.1:11434')}" /></div>
    </div>
    <div class="field"><label>Live segment length (seconds)</label><input type="number" id="setSegSeconds" min="5" max="60" value="${esc(s.live?.segmentSeconds ?? 12)}" />
      <div class="hint">Shorter = lower latency but slightly choppier sentence breaks; longer = smoother text, a bit more delay.</div>
    </div>

    <div class="section-title">AI Insights (Groq)</div>
    <div class="field toggle-row">
      <label style="margin:0;">Auto-generate insights after each meeting</label>
      <input type="checkbox" id="setGroqEnabled" ${s.groq?.enabled ? 'checked' : ''} />
    </div>
    <div class="field">
      <label>Groq API key</label>
      <input type="password" id="setGroqKey" value="${esc(s.groq?.apiKey || '')}" placeholder="gsk_..." />
      <div class="hint">Stored locally in ~/.jamus/config.json. Get a free key at console.groq.com. Note: the transcript is sent to Groq's servers.</div>
    </div>
    <div class="field"><label>Groq model</label><input type="text" id="setGroqModel" value="${esc(s.groq?.model || 'llama-3.3-70b-versatile')}" /></div>
    <div class="field">
      <label>Insights sections</label>
      <div class="checks">
        ${sec('summary', 'Summary')} ${sec('actionItems', 'Action items')} ${sec('keyDecisions', 'Key decisions')} ${sec('topicsQuestions', 'Topics & open questions')}
      </div>
    </div>`;
  $('#delAllAudio')?.addEventListener('click', async () => {
    if (!confirm("Delete the audio (.wav) for ALL meetings?\n\nFrees the most space. Transcripts and insights are kept and meetings stay listed, but you won't be able to re-transcribe any of them.")) return;
    const r = await J.deleteAllAudio().catch((e) => { alert(e.message); return null; });
    if (!r) return;
    alert(`Deleted audio from ${r.count} file(s) — freed ${(r.freed / 1024 / 1024 / 1024).toFixed(2)} GB.`);
    state.status = await J.status().catch(() => state.status);
    await refreshMeetings();
    openSettings(); // re-render with updated usage
  });
  $('#settingsSaved').textContent = '';
  $('#settingsModal').classList.remove('hidden');
}

async function saveSettings() {
  const sections = [...document.querySelectorAll('[data-sec]')].filter((c) => c.checked).map((c) => c.dataset.sec);
  const partial = {
    model: $('#setModel').value,
    language: $('#setLang').value.trim() || 'auto',
    labels: { me: $('#setMe').value.trim() || 'Me', participants: $('#setOthers').value.trim() || 'Participants' },
    maxSentencesPerTurn: Number($('#setMaxSentences').value) || 6,
    storage: { maxRecordingsGB: Number($('#setCap').value) || 20 },
    systemAudio: {
      excludeProcess: $('#setExcludeProcess').value.trim() || null,
      enabled: $('#setExcludeEnabled').checked,
    },
    live: {
      summaryProvider: $('#setLiveProvider').value,
      summaryIntervalSec: Number($('#setLiveInterval').value) || 45,
      segmentSeconds: Number($('#setSegSeconds').value) || 12,
      ollama: {
        model: $('#setOllamaModel').value.trim() || 'llama3.1:8b',
        url: $('#setOllamaUrl').value.trim() || 'http://127.0.0.1:11434',
      },
    },
    groq: {
      enabled: $('#setGroqEnabled').checked,
      apiKey: $('#setGroqKey').value.trim(),
      model: $('#setGroqModel').value.trim() || 'llama-3.3-70b-versatile',
      sections,
    },
  };
  await J.saveSettings(partial);
  state.settings = await J.getSettings();
  $('#settingsSaved').textContent = 'Saved ✓';
  setTimeout(() => { $('#settingsModal').classList.add('hidden'); }, 600);
}

// ---------- wire up ----------
$('#recordBtn').addEventListener('click', () => (state.recording ? null : openRecordPanel()));
$('#importBtn').addEventListener('click', () => (state.recording ? null : openImport()));
$('#refreshBtn').addEventListener('click', refreshMeetings);
$('#settingsBtn').addEventListener('click', openSettings);
$('#themeBtn').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
applyTheme(document.documentElement.dataset.theme); // sync the toggle icon
$('#settingsClose').addEventListener('click', () => $('#settingsModal').classList.add('hidden'));
$('#settingsSave').addEventListener('click', saveSettings);

J.onStatus((msg) => setStatus(msg && msg !== 'Done.' ? msg : null));

(async function init() {
  state.settings = await J.getSettings().catch(() => null);
  state.status = await J.status().catch(() => null);
  await refreshMeetings();
  renderEmpty();
})();
