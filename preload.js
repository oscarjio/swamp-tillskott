const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('swamp', {
  platform: process.platform,
  authStatus: () => ipcRenderer.invoke('auth:status'),
  login: (email, password, remember) => ipcRenderer.invoke('auth:login', { email, password, remember }),
  portalLogin: () => ipcRenderer.invoke('auth:portal'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  get: (path, opts) => ipcRenderer.invoke('api:get', path, opts),
  series: (dev, key, from, to) => ipcRenderer.invoke('api:series', dev, key, from, to),
  clearCache: () => ipcRenderer.invoke('api:clearCache'),
  openPortal: url => ipcRenderer.invoke('app:openPortal', url),
  version: () => ipcRenderer.invoke('app:version'),
  onAuthExpired: cb => ipcRenderer.on('auth:expired', cb),
  onRefresh: cb => ipcRenderer.on('app:refresh', cb),
});
