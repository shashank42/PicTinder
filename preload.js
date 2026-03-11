const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pictinder', {
  getInitialConfig: () => ipcRenderer.invoke('get-initial-config'),
  savePort: (port) => ipcRenderer.invoke('save-port', port),
  getFolders: () => ipcRenderer.invoke('get-folders'),
  addFolder: () => ipcRenderer.invoke('add-folder'),
  removeFolder: (folder) => ipcRenderer.invoke('remove-folder', folder),
  openAlbumDetail: (albumId) => ipcRenderer.invoke('open-album-detail', { albumId }),
  openDesktopFeed: (url) => ipcRenderer.invoke('open-desktop-feed', { url }),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', { url }),
  getGoogleOAuthConfig: () => ipcRenderer.invoke('get-google-oauth-config'),
  saveGoogleOAuthConfig: (config) => ipcRenderer.invoke('save-google-oauth-config', config),
  startServer: (config) => ipcRenderer.invoke('start-server', config),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  onServerLog: (cb) => {
    ipcRenderer.on('server-log', (_, message) => cb(message));
  },
});
