const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { createServer } = require('./server');

app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

const store = new Store();
let mainWindow = null;
let serverInstance = null;
let currentServerPort = null;

function getLocalIP() {
  const os = require('os');
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 760,
    minWidth: 400,
    minHeight: 500,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    backgroundColor: '#f5f5f7',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'desktop', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

function getFolders() {
  return store.get('folders', []);
}

function setFolders(folders) {
  store.set('folders', folders);
}

ipcMain.handle('get-initial-config', () => ({
  folders: getFolders(),
  port: store.get('port', 3847),
}));

ipcMain.handle('save-port', (_, port) => {
  if (port !== undefined) store.set('port', port);
});

ipcMain.handle('get-folders', () => getFolders());

ipcMain.handle('add-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths.length) return null;
  const folder = filePaths[0];
  const folders = getFolders();
  if (!folders.includes(folder)) {
    folders.push(folder);
    setFolders(folders);
  }
  if (serverInstance) serverInstance.addFolder(folder);
  return { folder, folders };
});

ipcMain.handle('remove-folder', (_, folder) => {
  const folders = getFolders().filter((f) => f !== folder);
  setFolders(folders);
  if (serverInstance) serverInstance.removeFolder(folder);
  return { folders };
});

ipcMain.handle('open-album-detail', (_, { albumId }) => {
  if (!currentServerPort) return;
  const detailWin = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 600,
    minHeight: 400,
    backgroundColor: '#111111',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  detailWin.loadURL(`http://localhost:${currentServerPort}/album-detail/?albumId=${albumId}`);
});

ipcMain.handle('start-server', async (_, { port }) => {
  if (serverInstance) return { error: 'Server already running' };
  const folders = getFolders();

  const statePath = path.join(app.getPath('userData'), 'pictinder-state.json');
  const onLog = (message) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server-log', message);
    }
  };

  const host = getLocalIP();
  const baseUrl = `http://${host}:${port}`;
  try {
    serverInstance = createServer(folders, statePath, onLog, baseUrl);
    await serverInstance.start(port);
    onLog(`Server started on ${baseUrl}`);
    currentServerPort = port;
    return { url: baseUrl, port, host };
  } catch (err) {
    serverInstance = null;
    currentServerPort = null;
    return { error: err.message || 'Failed to start server' };
  }
});

ipcMain.handle('stop-server', async () => {
  if (!serverInstance) return;
  try {
    await serverInstance.stop();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('server-log', 'Server stopped');
    }
  } finally {
    serverInstance = null;
    currentServerPort = null;
  }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (serverInstance) serverInstance.stop().catch(() => {});
  app.quit();
});
