require('dotenv').config();
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const Store = require('electron-store');
const { createServer } = require('./server');

app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

const store = new Store();
let mainWindow = null;
let serverInstance = null;
let currentServerPort = null;

// ---------------------------------------------------------------------------
// License configuration
// ---------------------------------------------------------------------------

const LICENSE_API_BASE = 'https://pictinder.com/api';
const LICENSE_VERIFY_INTERVAL_MS = 24 * 60 * 60 * 1000; // re-verify once per day
const SKIP_LICENSE = process.env.SKIP_LICENSE === '1';

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

// ---------------------------------------------------------------------------
// License helpers
// ---------------------------------------------------------------------------

function getMachineId() {
  const cached = store.get('machineId');
  if (cached) return cached;

  const hostname = os.hostname();
  const platform = os.platform();
  const arch = os.arch();
  const cpus = os.cpus();
  const cpuModel = cpus.length > 0 ? cpus[0].model : '';
  const nets = os.networkInterfaces();
  let mac = '';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (!net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
        mac = net.mac;
        break;
      }
    }
    if (mac) break;
  }
  const raw = `${hostname}|${platform}|${arch}|${cpuModel}|${mac}`;
  const id = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  store.set('machineId', id);
  return id;
}

function getLicense() {
  return store.get('license', null);
}

function setLicense(data) {
  store.set('license', data);
}

function clearLicense() {
  store.delete('license');
}

async function licenseApiCall(endpoint, body) {
  const { net } = require('electron');
  return new Promise((resolve, reject) => {
    const url = `${LICENSE_API_BASE}${endpoint}`;
    const postData = JSON.stringify(body);
    const request = net.request({ method: 'POST', url });
    request.setHeader('Content-Type', 'application/json');

    let responseBody = '';
    request.on('response', (response) => {
      response.on('data', (chunk) => { responseBody += chunk.toString(); });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(responseBody);
          resolve({ status: response.statusCode, data: parsed });
        } catch {
          resolve({ status: response.statusCode, data: { error: responseBody } });
        }
      });
    });
    request.on('error', (err) => reject(err));
    request.write(postData);
    request.end();
  });
}

async function activateLicense(email, licenseKey) {
  const machineId = getMachineId();
  const result = await licenseApiCall('/license/activate', { email, licenseKey, machineId });
  if (result.status === 200 && result.data.valid) {
    setLicense({ email, licenseKey, machineId, activatedAt: new Date().toISOString(), lastVerified: Date.now() });
    return { ok: true };
  }
  return { ok: false, error: result.data.error || 'Activation failed' };
}

async function verifyLicense() {
  const lic = getLicense();
  if (!lic) return { valid: false };
  try {
    const result = await licenseApiCall('/license/verify', {
      email: lic.email,
      licenseKey: lic.licenseKey,
      machineId: lic.machineId,
    });
    if (result.status === 200 && result.data.valid) {
      setLicense({ ...lic, lastVerified: Date.now() });
      return { valid: true };
    }
    return { valid: false, error: result.data.error };
  } catch {
    // Offline — trust local license if verified recently
    if (lic.lastVerified && (Date.now() - lic.lastVerified) < LICENSE_VERIFY_INTERVAL_MS * 7) {
      return { valid: true, offline: true };
    }
    return { valid: false, error: 'Unable to verify license. Check your internet connection.' };
  }
}

async function deactivateLicense() {
  const lic = getLicense();
  if (!lic) return { ok: true };
  try {
    await licenseApiCall('/license/deactivate', {
      email: lic.email,
      licenseKey: lic.licenseKey,
      machineId: lic.machineId,
    });
  } catch { /* best-effort */ }
  clearLicense();
  return { ok: true };
}

// IPC handlers for licensing
ipcMain.handle('get-license-status', () => {
  if (SKIP_LICENSE) return { licensed: true, email: 'dev@localhost', licenseKey: 'DEV-MODE' };
  const lic = getLicense();
  return { licensed: !!lic, email: lic?.email || '', licenseKey: lic?.licenseKey || '' };
});

ipcMain.handle('activate-license', async (_evt, { email, licenseKey }) => {
  return activateLicense(email, licenseKey);
});

ipcMain.handle('deactivate-license', async () => {
  return deactivateLicense();
});

ipcMain.handle('verify-license', async () => {
  if (SKIP_LICENSE) return { valid: true };
  return verifyLicense();
});

function getLocalIP() {
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

app.whenReady().then(() => {
  createWindow();

  // Background license re-verification (daily)
  setInterval(async () => {
    const lic = getLicense();
    if (!lic) return;
    const timeSince = Date.now() - (lic.lastVerified || 0);
    if (timeSince > LICENSE_VERIFY_INTERVAL_MS) {
      const result = await verifyLicense();
      if (!result.valid && !result.offline) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('license-revoked');
        }
      }
    }
  }, 60 * 60 * 1000); // check every hour whether a re-verify is due
});

app.on('window-all-closed', () => {
  if (serverInstance) serverInstance.stop().catch(() => { });
  app.quit();
});
