const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  stampImpact: phrase => ipcRenderer.send('stamp-impact', phrase),
  hideOverlay: () => ipcRenderer.send('hide-overlay'),
  requestControlState: () => ipcRenderer.send('request-control-state'),
  requestAccessibilityPermission: () => ipcRenderer.send('request-accessibility-permission'),
  saveSettings: words => ipcRenderer.send('save-settings', words),
  activateStampMode: words => ipcRenderer.send('activate-stamp-mode', words),
  onSpawnStamp: fn => ipcRenderer.on('spawn-stamp', (_event, point) => fn(point)),
  onControlState: fn => ipcRenderer.on('control-state', (_event, state) => fn(state)),
});
