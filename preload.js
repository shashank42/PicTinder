const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pictinder', {
  getInitialConfig: () => ipcRenderer.invoke('get-initial-config'),
  savePort: (port) => ipcRenderer.invoke('save-port', port),
  getFolders: () => ipcRenderer.invoke('get-folders'),
  addFolder: () => ipcRenderer.invoke('add-folder'),
  removeFolder: (folder) => ipcRenderer.invoke('remove-folder', folder),
  openAlbumDetail: (albumId) => ipcRenderer.invoke('open-album-detail', { albumId }),
  startServer: (config) => ipcRenderer.invoke('start-server', config),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  onServerLog: (cb) => {
    ipcRenderer.on('server-log', (_, message) => cb(message));
  },
});
