const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onShowAuth:  (callback) => ipcRenderer.on('show-auth',  (_event)      => callback()),
  onShowError: (callback) => ipcRenderer.on('show-error', (_event, msg) => callback(msg)),
});
