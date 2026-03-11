require('dotenv').config();
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { createServer } = require('./server');

app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

const store = new Store();
let mainWindow = null;
let serverInstance = null;
let currentServerPort = null;

function getCloudTokenMap() {
  return store.get('cloudTokens', {});
}

function setCloudTokenMap(map) {
  store.set('cloudTokens', map || {});
}

function encryptToken(raw) {
  if (!raw) return '';
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(raw).toString('base64');
  }
  return Buffer.from(raw, 'utf8').toString('base64');
}

function decryptToken(enc) {
  if (!enc) return null;
  try {
    const buf = Buffer.from(enc, 'base64');
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buf);
    }
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

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
  const iconPath = path.join(__dirname, 'build', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 480,
    height: 760,
    minWidth: 400,
    minHeight: 500,
    icon: iconPath,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : {}),
    backgroundColor: '#f5f5f7',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.platform === 'darwin') {
    try {
      if (!app.isPackaged) {
        app.dock.setIcon(iconPath);
      }
    } catch (err) {
      console.warn('Failed to set dock icon:', err);
    }
  }

  mainWindow.loadFile(path.join(__dirname, 'desktop', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.on('did-fail-load', () => mainWindow.show());
  setTimeout(() => { if (mainWindow && !mainWindow.isVisible()) mainWindow.show(); }, 5000);
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

ipcMain.handle('open-desktop-feed', (_, { url }) => {
  if (!url || typeof url !== 'string') return { ok: false };
  const { screen } = require('electron');
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const feedWin = new BrowserWindow({
    width,
    height,
    minWidth: 600,
    minHeight: 500,
    backgroundColor: '#111111',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  feedWin.loadURL(url);
  return { ok: true };
});

ipcMain.handle('open-external-url', async (_evt, { url }) => {
  if (!url || typeof url !== 'string') return { ok: false };
  await shell.openExternal(url);
  return { ok: true };
});

function getBundledOAuthConfig() {
  const bundledId = process.env.GOOGLE_CLIENT_ID || '';
  const bundledSecret = process.env.GOOGLE_CLIENT_SECRET || '';
  return { clientId: bundledId, clientSecret: bundledSecret };
}

function getEffectiveOAuthConfig() {
  const user = store.get('googleOAuth', {});
  const bundled = getBundledOAuthConfig();
  return {
    clientId: user.clientId || bundled.clientId || '',
    clientSecret: user.clientSecret || bundled.clientSecret || '',
  };
}

ipcMain.handle('get-google-oauth-config', () => {
  const eff = getEffectiveOAuthConfig();
  const bundled = getBundledOAuthConfig();
  const hasBundled = !!(bundled.clientId && bundled.clientSecret);
  return { clientId: eff.clientId || '', hasClientSecret: !!eff.clientSecret, hasBundled };
});

ipcMain.handle('save-google-oauth-config', (_evt, { clientId, clientSecret }) => {
  const next = {
    clientId: String(clientId || '').trim(),
    clientSecret: String(clientSecret || '').trim(),
  };
  store.set('googleOAuth', next);
  return { ok: true };
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
    serverInstance = createServer(folders, statePath, onLog, baseUrl, {
      getGoogleOAuthConfig: () => getEffectiveOAuthConfig(),
      cloudTokenStore: {
        getRefreshToken(accountId) {
          const all = getCloudTokenMap();
          return decryptToken(all[accountId] || '');
        },
        setRefreshToken(accountId, token) {
          const all = getCloudTokenMap();
          all[accountId] = encryptToken(String(token || ''));
          setCloudTokenMap(all);
        },
        deleteRefreshToken(accountId) {
          const all = getCloudTokenMap();
          delete all[accountId];
          setCloudTokenMap(all);
        },
      },
    });
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
  if (serverInstance) serverInstance.stop().catch(() => { });
  app.quit();
});
