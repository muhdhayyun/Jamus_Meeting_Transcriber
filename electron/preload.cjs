const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jamus', {
  status: () => ipcRenderer.invoke('app:status'),
  listDevices: () => ipcRenderer.invoke('devices:list'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),

  listMeetings: () => ipcRenderer.invoke('meetings:list'),
  getMeeting: (id) => ipcRenderer.invoke('meeting:get', id),
  openTranscripts: () => ipcRenderer.invoke('open:transcripts'),

  startRecording: (opts) => ipcRenderer.invoke('record:start', opts),
  stopRecording: (opts) => ipcRenderer.invoke('record:stop', opts),
  cancelRecording: () => ipcRenderer.invoke('record:cancel'),

  generateInsights: (id) => ipcRenderer.invoke('insights:generate', id),

  onStatus: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on('status', handler);
    return () => ipcRenderer.removeListener('status', handler);
  },
});
