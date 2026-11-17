const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  status: () => ipcRenderer.invoke('status'),
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),
  getModels: () => ipcRenderer.invoke('get-models'),
  setPriority: (order) => ipcRenderer.invoke('set-priority', order),
  addProvider: (opts) => ipcRenderer.invoke('add-provider', opts),
  removeModel: (key, delProvider) => ipcRenderer.invoke('remove-model', key, delProvider),
  minimize: () => ipcRenderer.invoke('minimize'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setAutoStart: (enabled) => ipcRenderer.invoke('set-autostart', enabled),
  setPowerSave: (enabled) => ipcRenderer.invoke('set-powersave', enabled),
  getUsage: () => ipcRenderer.invoke('get-usage'),
  getQrcode: () => ipcRenderer.invoke('get-qrcode'),
  cancelQrcode: () => ipcRenderer.invoke('cancel-qrcode'),
  onLog: (cb) => ipcRenderer.on('log', (e, s) => cb(s)),
});
