const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const os = require('os');
const { AlbumStore, generateId } = require('./albums');
let sharp;
try { sharp = require('sharp'); } catch { sharp = null; }
const faceRec = require('./face-recognition');

const MEDIA_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif',
  '.nef', '.arw', '.sr2', '.srf', '.cr2', '.cr3', '.dng', '.raf', '.raw', '.orf', '.rw2', '.pef',
  '.mp4', '.mov', '.avi', '.webm', '.mkv',
]);

const HEARTBEAT_TIMEOUT_MS = 75000;
const RELEASE_CHECK_INTERVAL_MS = 20000;

function hasMediaExt(filePath) {
  const ext = (path.extname(filePath) || '').toLowerCase();
  return ext && MEDIA_EXT.has(ext);
}

function createServer(initialFolders, statePath, onLog, baseUrl, options = {}) {
  const app = express();
  let server = null;
  let wss = null;
  const dataDir = path.join(path.dirname(statePath), 'pictinder-data');
  const albumStore = new AlbumStore(path.join(dataDir, 'pictinder.db'));
  const cloudTokenStore = options.cloudTokenStore || {};
  const getRefreshToken = async (accountId) => {
    if (typeof cloudTokenStore.getRefreshToken === 'function') {
      return cloudTokenStore.getRefreshToken(accountId);
    }
    return null;
  };
  const setRefreshToken = async (accountId, token) => {
    if (typeof cloudTokenStore.setRefreshToken === 'function') {
      return cloudTokenStore.setRefreshToken(accountId, token);
    }
    return null;
  };
  const deleteRefreshToken = async (accountId) => {
    if (typeof cloudTokenStore.deleteRefreshToken === 'function') {
      return cloudTokenStore.deleteRefreshToken(accountId);
    }
    return null;
  };
  const getGoogleOAuthConfig = () => {
    if (typeof options.getGoogleOAuthConfig === 'function') return options.getGoogleOAuthConfig();
    return {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    };
  };

  const registeredFolders = new Set((initialFolders || []).map((f) => path.resolve(f)));

  let state = { lastIndex: 0, choices: [], order: [] };
  let currentJoinToken = generateId();
  const devices = new Map();
  let releaseInterval = null;

  const allWsClients = new Set();
  const deviceWsMap = new Map();

  // ---- State helpers (legacy) ----

  async function loadState() {
    try {
      const raw = await fs.readFile(statePath, 'utf8');
      state = JSON.parse(raw);
    } catch {
      state = { lastIndex: 0, choices: [], order: [] };
    }
  }

  async function saveState() {
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
  }

  function getOrCreateDevice(deviceId) {
    if (!deviceId) return null;
    if (!devices.has(deviceId)) {
      devices.set(deviceId, {
        deviceId,
        lastSeen: Date.now(),
        currentAlbumId: null,
        label: `Device ${devices.size + 1}`,
      });
    }
    return devices.get(deviceId);
  }

  function touchDevice(deviceId) {
    const d = getOrCreateDevice(deviceId);
    if (d) d.lastSeen = Date.now();
    return d;
  }

  function rotateJoinToken() {
    currentJoinToken = generateId();
    broadcastJoinUrlUpdate();
    return currentJoinToken;
  }

  // ---- WebSocket broadcast helpers ----

  function isDeviceOnline(deviceId) {
    const conns = deviceWsMap.get(deviceId);
    return conns ? conns.size > 0 : false;
  }

  function broadcastAll(data) {
    const msg = JSON.stringify(data);
    for (const ws of allWsClients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  function getDeviceList() {
    const now = Date.now();
    return Array.from(devices.values())
      .filter((d) => isDeviceOnline(d.deviceId) || now - d.lastSeen < HEARTBEAT_TIMEOUT_MS * 2)
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label,
        currentAlbumId: d.currentAlbumId,
        lastSeen: d.lastSeen,
        online: isDeviceOnline(d.deviceId),
      }));
  }

  function broadcastDeviceUpdate() {
    broadcastAll({ type: 'devices', devices: getDeviceList() });
  }

  function broadcastAlbumsUpdate() {
    try {
      const albums = albumStore.listDetailed();
      broadcastAll({ type: 'albums', albums });
    } catch { }
  }

  async function broadcastJoinUrlUpdate() {
    const joinUrl = baseUrl ? `${baseUrl}/phone/?token=${currentJoinToken}` : null;
    let qrDataUrl = null;
    if (joinUrl) {
      try { qrDataUrl = await QRCode.toDataURL(joinUrl, { width: 140, margin: 1 }); } catch { }
    }
    broadcastAll({ type: 'join-url', joinUrl, qrDataUrl });
  }

  function broadcastCloudUpdate() {
    try {
      const runs = albumStore.listCloudUploadRuns({ limit: 30 });
      const coverage = albumStore.getAllAlbumsCloudCoverage();
      const notifications = albumStore.listCloudNotifications({ limit: 50 });
      broadcastAll({ type: 'cloud', runs, coverage, notifications });
    } catch { }
  }

  // ---- Cloud upload / OAuth helpers ----

  const oauthStateMap = new Map();
  const runProcessing = new Set();

  function makeGoogleRedirectUri(_req) {
    const port = server ? server.address()?.port : null;
    return `http://localhost:${port || new URL(baseUrl).port}/api/cloud/google/callback`;
  }

  async function refreshGoogleAccessToken(accountId) {
    const account = albumStore.getCloudAccount(accountId);
    if (!account) throw new Error('Cloud account not found');
    const refreshToken = await getRefreshToken(accountId);
    if (!refreshToken) throw new Error('Missing refresh token');
    const cfg = getGoogleOAuthConfig();
    if (!cfg.clientId || !cfg.clientSecret) {
      throw new Error('Google OAuth client is not configured');
    }
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!tokenRes.ok) {
      albumStore.setCloudAccountStatus(accountId, 'reauth_required', `Token refresh failed (${tokenRes.status})`);
      throw new Error('Google token refresh failed');
    }
    const tokenJson = await tokenRes.json();
    albumStore.setCloudAccountStatus(accountId, 'active', null);
    return tokenJson.access_token;
  }

  async function googleApiJson(url, accessToken) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) throw new Error(`Google API error (${resp.status})`);
    return resp.json();
  }

  async function ensureAlbumFolder(accountId, albumId, accessToken) {
    const album = albumStore.getAlbumMeta(albumId);
    const albumName = album ? album.name : `Pictinder-${albumId}`;
    const targets = albumStore.listCloudAlbumTargets(albumId);
    const target = targets.find((t) => t.accountId === accountId);
    if (target && target.destinationFolderId) return target.destinationFolderId;

    // Search Google Drive for an existing Pictinder folder for this album
    const searchQuery = `appProperties has { key='pictinderAlbumId' and value='${albumId}' } and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    try {
      const searchResp = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(searchQuery)}&fields=files(id)&pageSize=1`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (searchResp.ok) {
        const searchData = await searchResp.json();
        if (searchData.files && searchData.files.length > 0) {
          const existingId = searchData.files[0].id;
          albumStore.updateCloudAlbumTargetFolder(albumId, accountId, existingId);
          if (onLog) onLog(`Reusing existing Drive folder for ${albumName}`);
          return existingId;
        }
      }
    } catch { }

    const createResp = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: albumName,
        mimeType: 'application/vnd.google-apps.folder',
        appProperties: { pictinderAlbumId: albumId },
      }),
    });
    if (!createResp.ok) {
      let detail = '';
      try { const body = await createResp.json(); detail = body?.error?.message || JSON.stringify(body); } catch { }
      throw new Error(`Failed to create Drive folder (${createResp.status}): ${detail}`);
    }
    const folder = await createResp.json();
    albumStore.updateCloudAlbumTargetFolder(albumId, accountId, folder.id);
    return folder.id;
  }

  const IMAGE_ROTATE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.tiff', '.tif']);
  const VIDEO_ROTATE_EXT = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv']);

  async function getRotatedBuffer(filePath) {
    const rotation = albumStore.getRotation(filePath);
    if (!rotation) return { buf: await fs.readFile(filePath), tmpFile: null };
    const ext = path.extname(filePath).toLowerCase();
    if (IMAGE_ROTATE_EXT.has(ext) && sharp) {
      const buf = await sharp(filePath).rotate(rotation * 90).toBuffer();
      return { buf, tmpFile: null };
    }
    if (VIDEO_ROTATE_EXT.has(ext)) {
      const tmpFile = path.join(os.tmpdir(), `pictinder_rot_${generateId()}${ext}`);
      const transposeFilters = [];
      for (let i = 0; i < rotation; i++) transposeFilters.push('transpose=1');
      await new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', [
          '-y', '-i', filePath,
          '-vf', transposeFilters.join(','),
          '-c:a', 'copy', '-map_metadata', '0', tmpFile,
        ]);
        proc.on('error', () => reject(new Error('ffmpeg not available')));
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
      });
      const buf = await fs.readFile(tmpFile);
      return { buf, tmpFile };
    }
    return { buf: await fs.readFile(filePath), tmpFile: null };
  }

  async function uploadFileToDrive({ item, run, accessToken }) {
    const folderId = await ensureAlbumFolder(item.accountId, run.albumId, accessToken);
    const stat = await fs.stat(item.path);
    const fileName = path.basename(item.path);
    const mime = 'application/octet-stream';
    const { buf: fileBuf, tmpFile } = await getRotatedBuffer(item.path);
    try {
      const boundary = `pictinder_${generateId()}`;
      const metadataPart = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: fileName, parents: [folderId] })}\r\n`,
        'utf8',
      );
      const fileHeader = Buffer.from(`--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`, 'utf8');
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
      const body = Buffer.concat([metadataPart, fileHeader, fileBuf, tail], metadataPart.length + fileHeader.length + fileBuf.length + tail.length);
      const upResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,size', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      });
      if (!upResp.ok) throw new Error(`Upload failed (${upResp.status})`);
      const json = await upResp.json();
      return { remoteFileId: json.id || null, remoteLink: json.webViewLink || null, fileSize: stat.size };
    } finally {
      if (tmpFile) fs.unlink(tmpFile).catch(() => { });
    }
  }

  async function chooseDistributeAccount(accountIds) {
    if (accountIds.length <= 1) return accountIds[0] || null;
    const accounts = accountIds.map((id) => albumStore.getCloudAccount(id)).filter(Boolean);
    const withSpace = accounts
      .map((a) => ({ id: a.id, free: (a.quotaTotal || 0) - (a.quotaUsed || 0), updatedAt: a.updatedAt || '' }))
      .sort((a, b) => (b.free - a.free) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return withSpace[0] ? withSpace[0].id : accountIds[0];
  }

  async function processRun(runId) {
    if (runProcessing.has(runId)) return;
    runProcessing.add(runId);
    try {
      let run = albumStore.getCloudUploadRun(runId);
      if (!run) return;
      if (run.status === 'cancelled' || run.status === 'completed') return;
      albumStore.resetStuckCloudUploadItems(runId);
      albumStore.setCloudRunStatus(runId, 'running', null);
      broadcastCloudUpdate();

      while (true) {
        run = albumStore.getCloudUploadRun(runId);
        if (!run) break;
        if (run.status === 'paused' || run.status === 'cancelled' || run.status === 'failed') break;

        let pending = albumStore.listPendingCloudUploadItems(runId, 1).filter((it) => it.state !== 'uploading');
        if (pending.length === 0) {
          const reset = albumStore.resetStuckCloudUploadItems(runId);
          if (reset > 0) {
            pending = albumStore.listPendingCloudUploadItems(runId, 1).filter((it) => it.state !== 'uploading');
          }
        }
        if (pending.length === 0) {
          albumStore.updateCloudRunCounters(runId);
          const latest = albumStore.getCloudUploadRun(runId);
          const status = latest && latest.failedItems > 0 ? 'failed' : 'completed';
          albumStore.setCloudRunStatus(runId, status, status === 'failed' ? 'Some items failed' : null);
          const album = albumStore.getAlbumMeta(run.albumId);
          const targets = albumStore.listCloudAlbumTargets(run.albumId);
          const driveFolderLinks = targets
            .filter((t) => t.destinationFolderId)
            .map((t) => `https://drive.google.com/drive/folders/${t.destinationFolderId}`);
          albumStore.dismissNotificationsByRunAndType(runId, 'upload_started');
          const albumName = album ? album.name : run.albumId;
          const uploaded = latest ? latest.uploadedItems : 0;
          const total = latest ? latest.totalItems : 0;
          const failed = latest ? latest.failedItems : 0;
          if (onLog) onLog(`Cloud upload ${status}: ${albumName} (${uploaded}/${total} uploaded${failed ? `, ${failed} failed` : ''})`);
          albumStore.createCloudNotification({
            albumId: run.albumId,
            runId,
            type: status === 'completed' ? 'upload_complete' : 'upload_partial',
            title: status === 'completed' ? 'Upload complete' : 'Upload partially complete',
            message: albumName,
            payload: {
              topFolders: albumStore.getAlbumTopFolders(run.albumId, 3),
              driveFolderLinks,
            },
          });
          break;
        }
        const item = pending[0];
        albumStore.setCloudUploadItemState(item.id, 'uploading', { errorMessage: null });
        broadcastCloudUpdate();
        try {
          const accessToken = await refreshGoogleAccessToken(item.accountId);
          const uploaded = await uploadFileToDrive({ item, run, accessToken });
          albumStore.setCloudUploadItemState(item.id, 'uploaded', {
            remoteFileId: uploaded.remoteFileId,
            remoteLink: uploaded.remoteLink,
            errorMessage: null,
          });
          albumStore.updateCloudRunCounters(runId);
        } catch (err) {
          const msg = err?.message || 'Upload failed';
          albumStore.setCloudUploadItemState(item.id, 'failed', { errorMessage: msg, incRetry: true });
          albumStore.updateCloudRunCounters(runId);
          if (onLog) onLog(`Cloud upload error: ${path.basename(item.path)} — ${msg}`);
        }
        broadcastCloudUpdate();
      }
    } finally {
      runProcessing.delete(runId);
      broadcastCloudUpdate();
    }
  }

  // ---- File scanning ----

  async function scanDir(dir, list = []) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return list;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await scanDir(full, list);
      } else if (e.isFile()) {
        if (hasMediaExt(full)) list.push(full);
      }
    }
    return list;
  }

  async function scanAllFolders() {
    const all = [];
    for (const folder of registeredFolders) {
      await scanDir(folder, all);
    }
    return all;
  }

  // ---- Release stale assignments ----

  function releaseDeviceAssignments(deviceId, albumId) {
    try {
      const album = albumStore.getAlbumMeta(albumId);
      if (!album || album.mode !== 'distributed') return;
      const released = albumStore.releaseAssignments(albumId, deviceId);
      if (released > 0) {
        if (onLog) onLog(`Released ${released} items from disconnected ${devices.get(deviceId)?.label || deviceId}`);
        broadcastAlbumsUpdate();
      }
    } catch { }
  }

  function releaseStaleAssignments() {
    const now = Date.now();
    for (const [deviceId, d] of devices) {
      const online = isDeviceOnline(deviceId);
      if (!online && now - d.lastSeen > HEARTBEAT_TIMEOUT_MS && d.currentAlbumId) {
        releaseDeviceAssignments(deviceId, d.currentAlbumId);
      }
    }
    broadcastDeviceUpdate();
  }

  // ---- WebSocket connection handler ----

  function handleWsConnection(ws, req) {
    allWsClients.add(ws);
    let deviceId = null;
    try {
      const url = new URL(req.url, 'http://localhost');
      deviceId = url.searchParams.get('deviceId');
    } catch { }

    if (deviceId) {
      const wasOnline = isDeviceOnline(deviceId);
      touchDevice(deviceId);
      if (!deviceWsMap.has(deviceId)) deviceWsMap.set(deviceId, new Set());
      deviceWsMap.get(deviceId).add(ws);
      if (!wasOnline && onLog) {
        onLog(`${devices.get(deviceId)?.label || deviceId} connected`);
      }
      broadcastDeviceUpdate();
    }

    (async () => {
      try {
        const deviceList = getDeviceList();
        const joinUrl = baseUrl ? `${baseUrl}/phone/?token=${currentJoinToken}` : null;
        let qrDataUrl = null;
        if (joinUrl) {
          try { qrDataUrl = await QRCode.toDataURL(joinUrl, { width: 140, margin: 1 }); } catch { }
        }
        const albums = albumStore.listDetailed();
        ws.send(JSON.stringify({ type: 'init', devices: deviceList, albums, joinUrl, qrDataUrl }));
      } catch { }
    })();

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping' && deviceId) {
          touchDevice(deviceId);
          if (msg.albumId) {
            const dev = devices.get(deviceId);
            if (dev) dev.currentAlbumId = msg.albumId;
          }
        }
      } catch { }
    });

    ws.on('close', () => {
      allWsClients.delete(ws);
      if (deviceId) {
        const conns = deviceWsMap.get(deviceId);
        if (conns) {
          conns.delete(ws);
          if (conns.size === 0) deviceWsMap.delete(deviceId);
        }
        if (!isDeviceOnline(deviceId) && onLog) {
          onLog(`${devices.get(deviceId)?.label || deviceId} disconnected`);
        }
        broadcastDeviceUpdate();
      }
    });

    ws.on('error', () => { });
  }

  // ---- Express middleware ----

  function asyncHandler(fn) {
    return (req, res, next) => fn(req, res, next).catch(next);
  }

  app.use(express.json());
  app.use(cookieParser());
  app.use('/phone', express.static(path.join(__dirname, '..', 'phone')));
  app.use('/album-detail', express.static(path.join(__dirname, '..', 'album-detail')));

  app.get('/', (_, res) => res.redirect('/phone/'));

  app.get('/api/config', (_, res) => {
    res.json({
      folders: Array.from(registeredFolders),
      hasFolders: registeredFolders.size > 0,
      baseUrl: baseUrl || '',
    });
  });

  app.get('/api/whoami', (req, res) => {
    res.json({ deviceId: req.cookies?.deviceId || null });
  });

  // ---- Folder management ----

  app.get('/api/folders', (_, res) => {
    res.json({ folders: Array.from(registeredFolders) });
  });

  app.post('/api/folders', (req, res) => {
    const { folder } = req.body || {};
    if (!folder) return res.status(400).json({ error: 'Need folder path' });
    const resolved = path.resolve(folder);
    const isNew = !registeredFolders.has(resolved);
    registeredFolders.add(resolved);
    if (onLog) onLog(`Folder added: ${resolved}`);
    res.json({ folders: Array.from(registeredFolders) });
    if (isNew) {
      setTimeout(() => startFaceScan(resolved), 2000);
    }
  });

  app.delete('/api/folders', (req, res) => {
    const { folder } = req.body || {};
    if (!folder) return res.status(400).json({ error: 'Need folder path' });
    const resolved = path.resolve(folder);
    registeredFolders.delete(resolved);
    if (onLog) onLog(`Folder removed: ${resolved}`);
    res.json({ folders: Array.from(registeredFolders) });
  });

  // ---- Join / QR ----

  app.get('/api/join/url', (_, res) => {
    const joinUrl = baseUrl ? `${baseUrl}/phone/?token=${currentJoinToken}` : null;
    res.json({ joinUrl, token: currentJoinToken });
  });

  app.post('/api/join/consume', (req, res) => {
    const { token } = req.body || {};
    if (!token || token !== currentJoinToken) {
      return res.status(400).json({ error: 'Invalid or already used token' });
    }
    const deviceId = generateId();
    rotateJoinToken();
    getOrCreateDevice(deviceId);
    res.cookie('deviceId', deviceId, { maxAge: 365 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax' });
    const albums = albumStore.listDetailed();
    if (onLog) onLog(`Device joined: ${devices.get(deviceId).label}`);
    broadcastDeviceUpdate();
    res.json({ deviceId, albums });
  });

  // ---- Albums ----

  app.get('/api/albums', (_, res) => {
    const albums = albumStore.listDetailed();
    res.json({ albums });
  });

  app.post('/api/albums', asyncHandler(async (req, res) => {
    const deviceId = req.cookies?.deviceId;
    const { name, mode } = req.body || {};
    if (!name || !['shared', 'distributed'].includes(mode)) {
      return res.status(400).json({ error: 'Need name and mode (shared|distributed)' });
    }
    if (registeredFolders.size === 0) {
      return res.status(400).json({ error: 'No folders registered' });
    }
    if (deviceId) touchDevice(deviceId);
    const mediaPaths = await scanAllFolders();
    const album = albumStore.createAlbum(name, mode);
    albumStore.insertItems(album.id, mediaPaths);
    if (mode === 'shared' && deviceId) {
      albumStore.initSharedProgress(album.id, deviceId);
    }
    if (deviceId) {
      const dev = devices.get(deviceId);
      if (dev) dev.currentAlbumId = album.id;
    }
    if (onLog) onLog(`Album created: ${name} (${mode}, ${mediaPaths.length} items)`);
    broadcastDeviceUpdate();
    broadcastAlbumsUpdate();
    res.json({ albumId: album.id });
  }));

  app.post('/api/albums/:id/join', (req, res) => {
    const deviceId = req.cookies?.deviceId;
    if (!deviceId) return res.status(401).json({ error: 'Not joined' });
    const albumId = req.params.id;
    const album = albumStore.getAlbumMeta(albumId);
    if (!album) return res.status(404).json({ error: 'Album not found' });
    touchDevice(deviceId);
    const dev = devices.get(deviceId);
    if (dev) dev.currentAlbumId = album.id;
    if (album.mode === 'shared') {
      albumStore.initSharedProgress(albumId, deviceId);
    }
    if (onLog) onLog(`${dev?.label || deviceId} joined album: ${album.name}`);
    broadcastDeviceUpdate();
    res.json({ ok: true });
  });

  app.get('/api/albums/:id/state', (req, res) => {
    const deviceId = req.cookies?.deviceId;
    if (!deviceId) return res.status(401).json({ error: 'Not joined' });
    const albumId = req.params.id;
    const album = albumStore.getAlbumMeta(albumId);
    if (!album) return res.status(404).json({ error: 'Album not found' });
    touchDevice(deviceId);
    const totalItems = albumStore.getItemCount(albumId);
    if (album.mode === 'shared') {
      const progress = albumStore.getSharedProgress(albumId, deviceId);
      return res.json({ mode: 'shared', totalItems, lastIndex: progress.lastIndex });
    }
    const counts = albumStore.getCounts(albumId);
    res.json({ mode: 'distributed', totalItems, totalSwiped: counts.selected + counts.discarded });
  });

  app.get('/api/albums/:id/feed-filter-options', (req, res) => {
    const albumId = req.params.id;
    const album = albumStore.getAlbumMeta(albumId);
    if (!album) return res.status(404).json({ error: 'Album not found' });
    const roots = Array.from(registeredFolders).map((f) => f.replace(/\\/g, '/'));
    const paths = albumStore.getAlbumPaths(albumId);
    const imageExts = new Set([
      '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif',
      '.nef', '.arw', '.sr2', '.srf', '.cr2', '.cr3', '.dng', '.raf', '.raw', '.orf', '.rw2', '.pef',
    ]);
    const videoExts = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv']);
    const folderSet = new Set();
    const hasImage = { value: false };
    const hasVideo = { value: false };
    for (const p of paths) {
      const ext = (path.extname(p) || '').toLowerCase();
      if (imageExts.has(ext)) hasImage.value = true;
      if (videoExts.has(ext)) hasVideo.value = true;
      const norm = p.replace(/\\/g, '/');
      for (const root of roots) {
        const r = root.replace(/\\/g, '/');
        if (!norm.startsWith(r + '/') && norm !== r) continue;
        const rel = norm.slice(r.length).replace(/^\//, '');
        const parts = rel.split('/').filter(Boolean);
        if (parts.length <= 1) continue;
        const dirParts = parts.slice(0, -1);
        for (let i = 1; i <= dirParts.length; i++) {
          folderSet.add(dirParts.slice(0, i).join('/'));
        }
      }
    }
    const fileTypes = [];
    if (hasImage.value) fileTypes.push({ id: 'image', label: 'Images' });
    if (hasVideo.value) fileTypes.push({ id: 'video', label: 'Videos' });
    const folderPaths = Array.from(folderSet).sort();
    res.json({ fileTypes, folderPaths });
  });

  app.get('/api/albums/:id/shared/batch', (req, res) => {
    const albumId = req.params.id;
    const deviceId = req.cookies?.deviceId || '';
    const from = Math.max(0, parseInt(req.query.from, 10) || 0);
    const count = Math.min(1000, Math.max(1, parseInt(req.query.count, 10) || 200));
    const fileTypesParam = req.query.fileTypes;
    const folderPathsParam = req.query.folderPaths;
    const identitiesParam = req.query.identities;
    const fileTypes = fileTypesParam ? fileTypesParam.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const folderPaths = folderPathsParam ? folderPathsParam.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const identities = identitiesParam ? identitiesParam.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const roots = Array.from(registeredFolders).map((f) => f.replace(/\\/g, '/'));
    const album = albumStore.getAlbumMeta(albumId);
    const isShared = album && album.mode === 'shared';
    let deviceLabels = {};
    if (isShared) {
      const deviceIds = albumStore.getSharedDevices(albumId);
      deviceIds.forEach((id, i) => { deviceLabels[id] = `D${i + 1}`; });
    }
    const dedup = req.query.dedup !== '0';
    if (fileTypes.length === 0 && folderPaths.length === 0 && identities.length === 0 && !dedup) {
      const items = albumStore.getSharedBatch(albumId, from, count, deviceId);
      res.json({ items, totalFiltered: null, deviceLabels });
      // Pre-generate previews for look-ahead items
      const lookAhead = albumStore.getLookAheadPaths(albumId, { fileTypes, folderPaths, identities, dedup }, roots, items.length > 0 ? items[items.length - 1].path : null, PREVIEW_LOOKAHEAD);
      preGeneratePreviews(lookAhead);
      return;
    }
    const { items, totalFiltered } = albumStore.getSharedBatchFiltered(
      albumId, from, count,
      { fileTypes, folderPaths, identities, dedup },
      roots,
      deviceId,
    );
    res.json({ items, totalFiltered, deviceLabels });
    // Pre-generate previews for look-ahead items
    const lookAhead = albumStore.getLookAheadPaths(albumId, { fileTypes, folderPaths, identities, dedup }, roots, items.length > 0 ? items[items.length - 1].path : null, PREVIEW_LOOKAHEAD);
    preGeneratePreviews(lookAhead);
  });

  app.get('/api/albums/:id/next', (req, res) => {
    const deviceId = req.cookies?.deviceId;
    if (!deviceId) return res.status(401).json({ error: 'Not joined' });
    const albumId = req.params.id;
    const album = albumStore.getAlbumMeta(albumId);
    if (!album || album.mode !== 'distributed') {
      return res.status(400).json({ error: 'Not a distributed album' });
    }
    touchDevice(deviceId);
    const fileTypesParam = req.query.fileTypes;
    const folderPathsParam = req.query.folderPaths;
    const fileTypes = fileTypesParam ? fileTypesParam.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const folderPaths = folderPathsParam ? folderPathsParam.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const dedup = req.query.dedup !== '0';
    const roots = Array.from(registeredFolders).map((f) => f.replace(/\\/g, '/'));
    const result = albumStore.assignNextUnassignedFiltered(
      albumId, deviceId,
      { fileTypes, folderPaths, dedup },
      roots,
    );
    res.json(result);
    // Pre-generate previews for the next N items in the filtered list
    if (result.path) {
      const lookAhead = albumStore.getLookAheadPaths(albumId, { fileTypes, folderPaths, dedup }, roots, result.path, PREVIEW_LOOKAHEAD);
      preGeneratePreviews(lookAhead);
    }
  });

  app.post('/api/albums/:id/release-assignments', (req, res) => {
    const deviceId = req.cookies?.deviceId;
    if (!deviceId) return res.status(401).json({ error: 'Not joined' });
    const albumId = req.params.id;
    const album = albumStore.getAlbumMeta(albumId);
    if (!album || album.mode !== 'distributed') {
      return res.status(400).json({ error: 'Not a distributed album' });
    }
    touchDevice(deviceId);
    const released = albumStore.releaseAssignments(albumId, deviceId);
    if (onLog && released > 0) onLog(`Released ${released} item(s) for device`);
    broadcastAlbumsUpdate();
    res.json({ ok: true, released });
  });

  app.post('/api/albums/:id/swipe', (req, res) => {
    const deviceId = req.cookies?.deviceId;
    if (!deviceId) return res.status(401).json({ error: 'Not joined' });
    const { path: itemPath, direction, lastIndex: newLastIndex } = req.body || {};
    if (!itemPath || !['left', 'right'].includes(direction)) {
      return res.status(400).json({ error: 'Need path and direction (left|right)' });
    }
    const albumId = req.params.id;
    const album = albumStore.getAlbumMeta(albumId);
    if (!album) return res.status(404).json({ error: 'Album not found' });
    touchDevice(deviceId);
    const filename = path.basename(itemPath);

    if (album.mode === 'shared') {
      albumStore.swipeShared(albumId, itemPath, direction, deviceId);
      if (typeof newLastIndex === 'number') {
        albumStore.updateSharedProgress(albumId, deviceId, newLastIndex);
      }
      if (onLog) onLog(`${direction === 'right' ? 'Selected' : 'Skipped'}: ${filename}`);
      broadcastAlbumsUpdate();
      return res.json({ ok: true });
    }

    const result = albumStore.swipeDistributed(albumId, itemPath, direction, deviceId);
    if (result.ok) {
      if (onLog) onLog(`${direction === 'right' ? 'Selected' : 'Skipped'}: ${filename}`);
      broadcastAlbumsUpdate();
    }
    res.json(result);
  });

  app.post('/api/albums/:id/toggle', (req, res) => {
    const deviceId = req.cookies?.deviceId;
    if (!deviceId) return res.status(401).json({ error: 'Not joined' });
    const { path: itemPath } = req.body || {};
    if (!itemPath) return res.status(400).json({ error: 'Need path' });
    const albumId = req.params.id;
    const album = albumStore.getAlbumMeta(albumId);
    if (!album) return res.status(404).json({ error: 'Album not found' });
    touchDevice(deviceId);

    let result;
    if (album.mode === 'shared') {
      result = albumStore.toggleShared(albumId, itemPath, deviceId);
    } else {
      result = albumStore.toggleDistributed(albumId, itemPath, deviceId);
    }
    if (result.ok) {
      const filename = path.basename(itemPath);
      if (onLog) onLog(`${result.selected ? 'Selected' : 'Deselected'}: ${filename}`);
      broadcastAlbumsUpdate();
    }
    res.json(result);
  });

  app.post('/api/albums/:id/reject', (req, res) => {
    const deviceId = req.cookies?.deviceId;
    if (!deviceId) return res.status(401).json({ error: 'Not joined' });
    const { path: itemPath } = req.body || {};
    if (!itemPath) return res.status(400).json({ error: 'Need path' });
    const albumId = req.params.id;
    const album = albumStore.getAlbumMeta(albumId);
    if (!album) return res.status(404).json({ error: 'Album not found' });
    touchDevice(deviceId);

    const result = albumStore.rejectItem(albumId, itemPath, deviceId);
    if (result.ok) {
      const filename = path.basename(itemPath);
      if (onLog) onLog(`Rejected: ${filename}`);
      broadcastAlbumsUpdate();
    }
    res.json(result);
  });

  app.post('/api/albums/:id/undo', (req, res) => {
    const deviceId = req.cookies?.deviceId;
    if (!deviceId) return res.status(401).json({ error: 'Not joined' });
    const { path: itemPath } = req.body || {};
    if (!itemPath) return res.status(400).json({ error: 'Need path' });
    const albumId = req.params.id;
    const album = albumStore.getAlbumMeta(albumId);
    if (!album) return res.status(404).json({ error: 'Album not found' });
    touchDevice(deviceId);
    const filename = path.basename(itemPath);

    let result;
    if (album.mode === 'shared') {
      result = albumStore.undoShared(albumId, itemPath, deviceId);
    } else {
      result = albumStore.undoDistributed(albumId, itemPath, deviceId);
    }

    if (result.ok) {
      if (onLog) onLog(`Undo: ${filename}`);
      broadcastAlbumsUpdate();
    }
    res.json(result);
  });

  app.delete('/api/albums/:id', (req, res) => {
    const albumId = req.params.id;
    const album = albumStore.getAlbumMeta(albumId);
    if (!album) return res.status(404).json({ error: 'Album not found' });
    albumStore.deleteAlbum(albumId);
    if (onLog) onLog(`Album deleted: ${album.name}`);
    broadcastAlbumsUpdate();
    res.json({ ok: true });
  });

  // ---- Album detail / reclassify ----

  app.get('/api/albums/:id/items', (req, res) => {
    const albumId = req.params.id;
    const album = albumStore.getAlbumMeta(albumId);
    if (!album) return res.status(404).json({ error: 'Album not found' });

    const filter = req.query.filter || 'all';
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));

    const includeVotes = album.mode === 'shared';
    const dedup = req.query.dedup !== '0';
    const result = albumStore.getItems(albumId, { filter, offset, limit, includeVotes, dedup });
    const response = { album: { id: album.id, name: album.name, mode: album.mode }, ...result };
    if (includeVotes) {
      const deviceIds = albumStore.getSharedDevices(albumId);
      response.devices = deviceIds.map((id, i) => ({
        id,
        label: `Device ${i + 1}`,
        short: `D${i + 1}`,
      }));
    }
    res.json(response);
  });

  app.post('/api/albums/:id/reclassify', (req, res) => {
    const albumId = req.params.id;
    const { path: itemPath, status } = req.body || {};
    if (!itemPath || !['selected', 'discarded'].includes(status)) {
      return res.status(400).json({ error: 'Need path and status (selected|discarded)' });
    }
    const album = albumStore.getAlbumMeta(albumId);
    if (!album) return res.status(404).json({ error: 'Album not found' });
    albumStore.reclassify(albumId, itemPath, status);
    const filename = path.basename(itemPath);
    if (onLog) onLog(`Reclassified: ${filename} → ${status}`);
    broadcastAlbumsUpdate();
    res.json({ ok: true });
  });

  // ---- Rotation ----

  app.post('/api/albums/:id/rotate', (req, res) => {
    const albumId = req.params.id;
    const { path: itemPath, rotation } = req.body || {};
    if (!itemPath || rotation == null) {
      return res.status(400).json({ error: 'Need path and rotation' });
    }
    const album = albumStore.getAlbumMeta(albumId);
    if (!album) return res.status(404).json({ error: 'Album not found' });
    const r = albumStore.setRotation(itemPath, parseInt(rotation, 10) || 0);
    res.json({ ok: true, rotation: r });
  });

  app.get('/api/albums/:id/rotation', (req, res) => {
    const albumId = req.params.id;
    const itemPath = req.query.path;
    if (!itemPath) return res.status(400).json({ error: 'Need path' });
    const r = albumStore.getRotation(itemPath);
    res.json({ rotation: r });
  });

  // ---- Face Recognition ----

  const faceThumbnailDir = path.join(dataDir, 'face-thumbnails');
  let faceScanState = { scanning: false, total: 0, processed: 0, found: 0, skipped: 0, error: null, folder: null };
  const CLUSTER_INTERVAL = 1000;
  const SCAN_CONCURRENCY = 4;

  async function runClustering(knownIdentities, label, occurrenceIds) {
    let unidentified;
    if (occurrenceIds && occurrenceIds.length > 0) {
      unidentified = [];
      for (const id of occurrenceIds) {
        const occ = albumStore.getOccurrence(id);
        if (occ && !occ.identityId) {
          unidentified.push({ id: occ.id, descriptor: occ.descriptor });
        }
      }
    } else {
      const allOccurrences = albumStore.getAllDescriptors();
      unidentified = allOccurrences.filter(o => !o.identityId);
    }
    if (unidentified.length === 0) return 0;

    console.log(`[faces] ${label}: clustering ${unidentified.length} unidentified faces…`);
    const clusters = await faceRec.clusterFaces(unidentified);
    console.log(`[faces] ${label}: ${clusters.length} clusters formed`);

    let newIdentities = 0;
    for (const cluster of clusters) {
      if (cluster.length < 1) continue;
      let bestOcc = null;
      let bestScore = -1;
      for (const occId of cluster) {
        const occ = albumStore.getOccurrence(occId);
        if (occ && occ.score > bestScore) {
          bestScore = occ.score;
          bestOcc = occ;
        }
      }
      if (!bestOcc) continue;

      const thumbFilename = bestOcc.id + '.jpg';
      const thumbPath = path.join(faceThumbnailDir, thumbFilename);
      await faceRec.cropFaceThumbnail(
        bestOcc.itemPath,
        { x: bestOcc.bboxX, y: bestOcc.bboxY, width: bestOcc.bboxW, height: bestOcc.bboxH },
        thumbPath,
      );

      const descBuf = Buffer.from(bestOcc.descriptor.buffer, bestOcc.descriptor.byteOffset, bestOcc.descriptor.byteLength);
      const identity = albumStore.createIdentity('', descBuf, thumbPath);
      albumStore.setOccurrencesIdentity(cluster, identity.id);

      knownIdentities.push({ id: identity.id, name: '', descriptor: bestOcc.descriptor });
      newIdentities++;
    }
    return newIdentities;
  }

  /**
   * Start a background face scan. Resumes from where it left off using
   * face_scanned_paths. Can target a single folder or all registered folders.
   * Returns immediately — work is done asynchronously.
   */
  function startFaceScan(folder) {
    const scanKey = folder || '__all__';

    if (faceScanState.scanning) return false;

    faceScanState = { scanning: true, total: 0, processed: 0, found: 0, skipped: 0, error: null, folder: scanKey };

    const YIELD_MS = 50;
    const yieldToEventLoop = () => new Promise(resolve => setTimeout(resolve, YIELD_MS));

    const log = (msg) => {
      console.log(msg);
      if (onLog) onLog(msg);
    };

    (async () => {
      try {
        log(`[faces] Starting face scan${folder ? ` for: ${folder}` : ' for all folders'}…`);

        let t0 = Date.now();
        const ok = await faceRec.initModels();
        if (!ok) {
          faceScanState.error = 'Failed to load face recognition models';
          faceScanState.scanning = false;
          log('[faces] ' + faceScanState.error);
          return;
        }
        console.log(`[faces] initModels: ${Date.now() - t0}ms`);

        const backendLabel = faceRec.isGpuAccelerated() ? 'GPU' : 'CPU';
        await yieldToEventLoop();

        t0 = Date.now();
        let allMedia;
        if (folder) {
          allMedia = [];
          await scanDir(folder, allMedia);
        } else {
          allMedia = await scanAllFolders();
        }
        const imagePaths = allMedia.filter(p => faceRec.isImageFile(p));
        faceScanState.total = imagePaths.length;
        console.log(`[faces] scanDir: ${Date.now() - t0}ms, ${imagePaths.length} images`);
        await yieldToEventLoop();

        t0 = Date.now();
        const { exactPaths: scannedExact, stems: scannedStems, count: scannedCount } = albumStore.getScannedPathSets();
        console.log(`[faces] loaded scanned-path sets: ${scannedCount} entries, ${Date.now() - t0}ms`);

        const toScan = [];
        for (const imgPath of imagePaths) {
          if (scannedExact.has(imgPath) || scannedStems.has(imgPath.replace(/\.[^./\\]+$/, ''))) {
            faceScanState.processed++;
            faceScanState.skipped++;
          } else {
            toScan.push(imgPath);
          }
        }
        console.log(`[faces] skip-check: ${Date.now() - t0}ms total, ${faceScanState.skipped} skipped, ${toScan.length} to scan`);
        await yieldToEventLoop();

        log(`[faces] ${imagePaths.length} images total, ${faceScanState.skipped} already scanned, ${toScan.length} to process (${backendLabel})`);

        t0 = Date.now();
        const knownIdentities = albumStore.getAllIdentityDescriptors();
        console.log(`[faces] loaded ${knownIdentities.length} identity descriptors: ${Date.now() - t0}ms`);
        await yieldToEventLoop();

        let newOccurrenceIds = [];
        let lastReportAt = faceScanState.processed;

        for (const imgPath of toScan) {
          const imgT0 = Date.now();
          try {
            const faces = await faceRec.detectFaces(imgPath);
            // Clean up any stale occurrences before inserting (prevents doubles on re-scan)
            albumStore.db.prepare('DELETE FROM face_occurrences WHERE item_path = ?').run(imgPath);
            albumStore.markFaceScanned(imgPath, faces.length, faceRec.getSettings());

            if (faces.length > 0) {
              for (const face of faces) {
                const match = faceRec.findBestMatch(face.embedding, knownIdentities);
                const identityId = match ? match.identity.id : null;
                const occId = albumStore.insertFaceOccurrence(imgPath, face.embedding, face.box, face.score, identityId);
                if (!identityId) newOccurrenceIds.push(occId);
                faceScanState.found++;
              }
            }
          } catch (err) {
            console.warn('[faces] Error scanning', imgPath, err.message);
          }
          faceScanState.processed++;

          const imgMs = Date.now() - imgT0;
          if (imgMs > 2000) console.log(`[faces] SLOW image (${imgMs}ms): ${path.basename(imgPath)}`);

          await yieldToEventLoop();

          if (faceScanState.processed - lastReportAt >= 50) {
            lastReportAt = faceScanState.processed;
            const pct = faceScanState.total > 0 ? Math.round((faceScanState.processed / faceScanState.total) * 100) : 0;
            log(`[faces] ${pct}% — ${faceScanState.processed}/${faceScanState.total} (${faceScanState.found} faces, ${faceScanState.skipped} skipped)`);
          }

          if (newOccurrenceIds.length >= CLUSTER_INTERVAL) {
            const clT0 = Date.now();
            await yieldToEventLoop();
            await runClustering(knownIdentities, `Interim clustering at ${faceScanState.processed}/${faceScanState.total}`, newOccurrenceIds);
            console.log(`[faces] interim clustering (${newOccurrenceIds.length} faces): ${Date.now() - clT0}ms`);
            newOccurrenceIds = [];
          }
        }

        log('[faces] Running final full clustering (all unidentified)…');
        await yieldToEventLoop();
        t0 = Date.now();
        await runClustering(knownIdentities, 'Final clustering', null);
        console.log(`[faces] final clustering: ${Date.now() - t0}ms`);

        faceScanState.scanning = false;
        const stats = albumStore.getFaceStats();
        log(`[faces] Scan complete: ${stats.totalOccurrences} faces, ${stats.totalIdentities} identities, ${stats.unidentified} unidentified`);

      } catch (err) {
        faceScanState.error = err.message;
        faceScanState.scanning = false;
        log('[faces] Scan error: ' + err.message);
        console.error('[faces] Scan error stack:', err);
      }
    })();

    return true;
  }

  app.post('/api/faces/scan', asyncHandler(async (req, res) => {
    const { folder } = req.body || {};

    if (faceScanState.scanning) {
      return res.json({ ok: false, error: 'Scan already in progress', status: faceScanState });
    }

    const started = startFaceScan(folder || null);
    res.json({ ok: started, status: faceScanState });
  }));

  app.post('/api/faces/scan-item', asyncHandler(async (req, res) => {
    let { path: itemPath } = req.body || {};
    console.log(`[faces] scan-item request: path=${itemPath || '(empty)'}`);
    if (!itemPath) return res.status(400).json({ error: 'Need path' });

    const ok = await faceRec.initModels();
    if (!ok) { console.log('[faces] scan-item: models not loaded'); return res.status(500).json({ error: 'Models not loaded' }); }

    try {
      let scanPath = itemPath;
      if (!faceRec.isImageFile(itemPath)) {
        const stem = itemPath.replace(/\.[^./\\]+$/, '');
        const dir = path.dirname(itemPath);
        const companionExts = ['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif', '.tif', '.tiff'];
        let found = false;
        for (const ext of companionExts) {
          const candidate = path.join(dir, path.basename(stem) + ext);
          try {
            await fs.access(candidate);
            scanPath = candidate;
            found = true;
            console.log(`[faces] scan-item: "${path.basename(itemPath)}" is not scannable, using companion "${path.basename(scanPath)}"`);
            break;
          } catch { }
        }
        if (!found) {
          console.log(`[faces] scan-item: not an image file and no companion found — ${itemPath}`);
          return res.status(400).json({ error: 'Not an image file and no companion found' });
        }
      }

      const stemForCleanup = itemPath.replace(/\.[^./\\]+$/, '');
      const likePattern = stemForCleanup.replace(/%/g, '\\%').replace(/_/g, '\\_') + '.%';
      const deleted = albumStore.db.prepare(
        "DELETE FROM face_occurrences WHERE item_path = ? OR item_path LIKE ? ESCAPE '\\'"
      ).run(scanPath, likePattern);
      console.log(`[faces] scan-item: cleared ${deleted.changes} old occurrences for stem "${path.basename(stemForCleanup)}"`);


      const t0 = Date.now();
      const settings = faceRec.getSettings();
      console.log(`[faces] scan-item: ${path.basename(scanPath)} (inputSize=${settings.inputSize}, minConf=${settings.minConfidence}, threshold=${settings.distanceThreshold})`);
      const faces = await faceRec.detectFaces(scanPath);
      console.log(`[faces] scan-item: detected ${faces.length} faces in ${Date.now() - t0}ms`);
      if (faces.length > 0) {
        faces.forEach((f, i) => console.log(`[faces]   face ${i}: score=${f.score.toFixed(3)}, box=${JSON.stringify(f.box)}`));
      }

      let found = 0;
      if (faces.length > 0) {
        const knownIdentities = albumStore.getAllIdentityDescriptors();
        for (const face of faces) {
          const match = faceRec.findBestMatch(face.embedding, knownIdentities);
          const identityId = match ? match.identity.id : null;
          const matchInfo = match ? `matched "${match.identity.name}" (dist=${match.distance.toFixed(3)})` : 'no match';
          console.log(`[faces]   → ${matchInfo}`);
          albumStore.insertFaceOccurrence(scanPath, face.embedding, face.box, face.score, identityId);
          found++;
        }
      }

      albumStore.markFaceScanned(scanPath, faces.length, faceRec.getSettings());
      console.log(`[faces] scan-item: done — ${found} faces stored for ${path.basename(scanPath)}`);
      if (onLog) onLog(`[faces] Rescanned ${path.basename(scanPath)}: ${found} faces found`);
      res.json({ ok: true, found });
    } catch (err) {
      if (onLog) onLog(`[faces] Error rescanning ${path.basename(itemPath)}: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  }));

  app.get('/api/faces/scan/status', (_req, res) => {
    const stats = albumStore.getFaceStats();
    stats.scannedPaths = albumStore.getFaceScannedCount();
    const pct = faceScanState.total > 0 ? Math.round((faceScanState.processed / faceScanState.total) * 100) : (faceScanState.scanning ? 0 : 100);
    res.json({ ...faceScanState, percent: pct, stats });
  });

  app.post('/api/faces/reset', (_req, res) => {
    if (faceScanState.scanning) {
      return res.status(409).json({ error: 'Cannot reset while a scan is in progress' });
    }
    albumStore.clearAllFaceData();
    if (onLog) onLog('[faces] All face data wiped (identities + occurrences)');
    res.json({ ok: true });
  });

  app.post('/api/rotations/reset', (_req, res) => {
    albumStore.clearAllRotations();
    if (onLog) onLog('[rotations] All rotation data cleared');
    res.json({ ok: true });
  });

  // Quick check: is this path face-scanned?
  app.get('/api/faces/check', (req, res) => {
    const itemPath = req.query.path;
    if (!itemPath) return res.status(400).json({ error: 'Need path' });
    const scanned = albumStore.hasScannedFaces(itemPath);
    res.json({ scanned });
  });

  app.get('/api/faces/identities', (_req, res) => {
    const identities = albumStore.listIdentities().map(ident => ({
      id: ident.id,
      name: ident.name,
      occurrenceCount: ident.occurrenceCount,
      thumbnailUrl: ident.thumbnailPath ? `/api/faces/thumbnail/${ident.id}` : null,
      createdAt: ident.createdAt,
      updatedAt: ident.updatedAt
    }));
    res.json({ identities });
  });

  app.put('/api/faces/identities/:id', (req, res) => {
    const { name } = req.body || {};
    if (name === undefined) return res.status(400).json({ error: 'Need name' });
    const identity = albumStore.getIdentity(req.params.id);
    if (!identity) return res.status(404).json({ error: 'Identity not found' });
    albumStore.updateIdentity(req.params.id, { name });
    if (onLog) onLog(`[faces] Renamed identity to: ${name}`);
    res.json({ ok: true, id: req.params.id, name });
  });

  app.post('/api/faces/identities/merge', (req, res) => {
    const { keepId, removeId } = req.body || {};
    if (!keepId || !removeId) return res.status(400).json({ error: 'Need keepId and removeId' });
    const keep = albumStore.getIdentity(keepId);
    const remove = albumStore.getIdentity(removeId);
    if (!keep || !remove) return res.status(404).json({ error: 'Identity not found' });
    albumStore.mergeIdentities(keepId, removeId);
    if (onLog) onLog(`[faces] Merged identity "${remove.name || removeId}" into "${keep.name || keepId}"`);
    res.json({ ok: true });
  });

  app.delete('/api/faces/identities/:id', (req, res) => {
    const identity = albumStore.getIdentity(req.params.id);
    if (!identity) return res.status(404).json({ error: 'Identity not found' });
    albumStore.deleteIdentity(req.params.id);
    if (onLog) onLog(`[faces] Deleted identity: ${identity.name || req.params.id}`);
    res.json({ ok: true });
  });

  app.post('/api/faces/occurrences/:id/unassign', (req, res) => {
    const occ = albumStore.getOccurrence(req.params.id);
    if (!occ) return res.status(404).json({ error: 'Occurrence not found' });
    albumStore.setOccurrenceIdentity(req.params.id, null);
    if (onLog) onLog(`[faces] Unassigned occurrence ${req.params.id} from identity`);
    res.json({ ok: true });
  });

  app.post('/api/faces/occurrences/:id/reassign', (req, res) => {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Need name' });
    const occ = albumStore.getOccurrence(req.params.id);
    if (!occ) return res.status(404).json({ error: 'Occurrence not found' });

    const allIdentities = albumStore.listIdentities();
    let existingIdentity = allIdentities.find(i => i.name.toLowerCase() === name.toLowerCase());
    let identityId;

    if (existingIdentity) {
      identityId = existingIdentity.id;
    } else {
      const descBuf = Buffer.from(occ.descriptor.buffer, occ.descriptor.byteOffset, occ.descriptor.byteLength);
      const thumbFilename = req.params.id + '.jpg';
      const thumbPath = path.join(faceThumbnailDir, thumbFilename);
      faceRec.cropFaceThumbnail(
        occ.itemPath,
        { x: occ.bboxX, y: occ.bboxY, width: occ.bboxW, height: occ.bboxH },
        thumbPath,
      ).catch(() => { });
      const identity = albumStore.createIdentity(name, descBuf, thumbPath);
      identityId = identity.id;
    }

    albumStore.setOccurrenceIdentity(req.params.id, identityId);
    if (onLog) onLog(`[faces] Reassigned face to "${name}"`);
    res.json({ ok: true, identityId, name });
  });

  app.post('/api/faces/identify', (req, res) => {
    const { occurrenceId, name } = req.body || {};
    if (!occurrenceId || !name) return res.status(400).json({ error: 'Need occurrenceId and name' });

    const occurrence = albumStore.getOccurrence(occurrenceId);
    if (!occurrence) return res.status(404).json({ error: 'Occurrence not found' });

    // Check if there's already an identity with this name
    const allIdentities = albumStore.listIdentities();
    let existingIdentity = allIdentities.find(i => i.name.toLowerCase() === name.toLowerCase());
    let identityId;

    if (existingIdentity) {
      identityId = existingIdentity.id;
    } else {
      // Create a new identity
      const descBuf = Buffer.from(occurrence.descriptor.buffer, occurrence.descriptor.byteOffset, occurrence.descriptor.byteLength);

      // Generate thumbnail
      const thumbFilename = occurrenceId + '.jpg';
      const thumbPath = path.join(faceThumbnailDir, thumbFilename);
      faceRec.cropFaceThumbnail(
        occurrence.itemPath,
        { x: occurrence.bboxX, y: occurrence.bboxY, width: occurrence.bboxW, height: occurrence.bboxH },
        thumbPath,
      ).catch(() => { });

      const identity = albumStore.createIdentity(name, descBuf, thumbPath);
      identityId = identity.id;
    }

    // Assign this occurrence to the identity
    albumStore.setOccurrenceIdentity(occurrenceId, identityId);

    // Also find other unidentified occurrences that are close to this descriptor and assign them too
    const allOccurrences = albumStore.getAllDescriptors();
    const similarUnidentified = allOccurrences.filter(o =>
      !o.identityId && o.id !== occurrenceId &&
      faceRec.faceDistance(occurrence.descriptor, o.descriptor) <= faceRec.DEFAULT_DISTANCE_THRESHOLD
    );
    if (similarUnidentified.length > 0) {
      albumStore.setOccurrencesIdentity(similarUnidentified.map(o => o.id), identityId);
      if (onLog) onLog(`[faces] Named "${name}" — also matched ${similarUnidentified.length} similar faces`);
    } else {
      if (onLog) onLog(`[faces] Named "${name}"`);
    }

    res.json({ ok: true, identityId, autoMatched: similarUnidentified.length });
  });

  app.get('/api/faces/item', asyncHandler(async (req, res) => {
    const itemPath = req.query.path;
    if (!itemPath) return res.status(400).json({ error: 'Need path' });
    const faces = albumStore.getItemFaces(itemPath);

    // Count ALL occurrences across all extensions for this stem (detect duplication)
    const stem = itemPath.replace(/\.[^./\\]+$/, '');
    const likeP = stem.replace(/%/g, '\\%').replace(/_/g, '\\_') + '.%';
    const rawAll = albumStore.db.prepare(
      "SELECT item_path, COUNT(*) as cnt FROM face_occurrences WHERE item_path = ? OR item_path LIKE ? ESCAPE '\\' GROUP BY item_path"
    ).all(itemPath, likeP);
    console.log(`[faces] getItemFaces("${path.basename(itemPath)}"): returned=${faces.length}, db-groups=${JSON.stringify(rawAll.map(r => `${path.basename(r.item_path)}:${r.cnt}`))}`);
    if (faces.length > 0) {
      // Read original image metadata so the client can map bbox coords correctly.
      // The bbox was stored relative to the EXIF-rotated original image.
      try {
        const sourcePath = faces[0].itemPath; // Might be JPG companion via stem match
        const meta = await sharp(sourcePath).rotate().metadata();
        const origW = meta.width || 0;
        const origH = meta.height || 0;
        for (const f of faces) {
          f.origW = origW;
          f.origH = origH;
        }
      } catch { /* keep faces without dimensions if metadata read fails */ }

      // Include user rotation (0-3, each unit = 90° CW)
      // Fetch rotation specifically for the companion file where the face was detected,
      // because ARW files might have manual user rotations that the JPG natively doesn't need!
      const userRotation = faces[0].itemPath ? (albumStore.getRotation(faces[0].itemPath) || 0) : 0;
      for (const f of faces) {
        f.userRotation = userRotation;
      }
    }

    res.json({ faces });
  }));

  app.get('/api/faces/crop/:id', asyncHandler(async (req, res) => {
    // Get face occurrence details
    const faceRow = albumStore.db.prepare(
      'SELECT item_path as itemPath, bbox_x as bboxX, bbox_y as bboxY, bbox_w as bboxW, bbox_h as bboxH FROM face_occurrences WHERE id = ?'
    ).get(req.params.id);

    if (!faceRow) return res.status(404).send('Face not found');

    const cacheKey = `face_crop_${req.params.id}`;
    let thumbPath = path.join(os.tmpdir(), `${cacheKey}.jpg`);

    try {
      await fs.access(thumbPath);
      return res.type('image/jpeg').sendFile(thumbPath);
    } catch {
      // Need to generate it.
      try {
        const { cropFaceThumbnail } = require('./face-recognition');
        // cropFaceThumbnail handles the geometry and padding automatically
        const ok = await cropFaceThumbnail(faceRow.itemPath, {
          x: faceRow.bboxX, y: faceRow.bboxY, width: faceRow.bboxW, height: faceRow.bboxH
        }, thumbPath, 150);

        if (ok) {
          return res.type('image/jpeg').sendFile(thumbPath);
        } else {
          return res.status(500).send('Failed to crop face');
        }
      } catch (err) {
        console.error('Error generating face crop:', err);
        return res.status(500).send('Error cropping face');
      }
    }
  }));

  app.get('/api/faces/thumbnail/:id', asyncHandler(async (req, res) => {
    const identity = albumStore.getIdentity(req.params.id);
    if (!identity || !identity.thumbnailPath) {
      return res.status(404).json({ error: 'Thumbnail not found' });
    }
    try {
      await fs.access(identity.thumbnailPath);
      res.type('image/jpeg').sendFile(identity.thumbnailPath);
    } catch {
      return res.status(404).json({ error: 'Thumbnail file missing' });
    }
  }));

  app.get('/api/faces/stats', (_req, res) => {
    const stats = albumStore.getFaceStats();
    res.json(stats);
  });

  app.get('/api/faces/settings', (req, res) => {
    const itemPath = req.query.path;
    if (itemPath) {
      const stored = albumStore.getScanSettings(itemPath);
      if (stored && stored.input_size != null) {
        return res.json({
          inputSize: stored.input_size,
          minConfidence: stored.min_confidence,
          distanceThreshold: stored.distance_threshold,
        });
      }
    }
    res.json(faceRec.getSettings());
  });

  app.put('/api/faces/settings', (req, res) => {
    const { distanceThreshold, minConfidence, inputSize } = req.body || {};
    faceRec.updateSettings({ distanceThreshold, minConfidence, inputSize });
    res.json(faceRec.getSettings());
  });

  // ---- Cloud: accounts, OAuth, uploads, coverage, notifications ----

  app.get('/api/cloud/config', (_req, res) => {
    const cfg = getGoogleOAuthConfig();
    res.json({ googleConfigured: !!(cfg.clientId && cfg.clientSecret) });
  });

  app.get('/api/cloud/accounts', (req, res) => {
    const search = String(req.query.search || '');
    const status = String(req.query.status || '');
    const sort = String(req.query.sort || 'updated');
    const accounts = albumStore.listCloudAccounts({ search, status, sort });
    res.json({ accounts });
  });

  app.post('/api/cloud/accounts/google/start', (req, res) => {
    const cfg = getGoogleOAuthConfig();
    if (!cfg.clientId || !cfg.clientSecret) {
      return res.status(400).json({ error: 'Google OAuth client is not configured' });
    }
    const redirectUri = makeGoogleRedirectUri(req);
    const state = generateId();
    oauthStateMap.set(state, { createdAt: Date.now() });
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
      ].join(' '),
      state,
    });
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    res.json({ authUrl });
  });

  app.get('/api/cloud/google/callback', asyncHandler(async (req, res) => {
    const { code, state, error } = req.query || {};
    if (error) {
      return res.status(400).send(`<html><body><h3>Google sign-in failed</h3><p>${String(error)}</p></body></html>`);
    }
    if (!code || !state || !oauthStateMap.has(String(state))) {
      return res.status(400).send('<html><body><h3>Invalid OAuth callback</h3></body></html>');
    }
    oauthStateMap.delete(String(state));
    const cfg = getGoogleOAuthConfig();
    const redirectUri = makeGoogleRedirectUri(req);
    const body = new URLSearchParams({
      code: String(code),
      client_id: cfg.clientId || '',
      client_secret: cfg.clientSecret || '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!tokenResp.ok) {
      return res.status(400).send('<html><body><h3>Failed to obtain Google token</h3></body></html>');
    }
    const tokenJson = await tokenResp.json();
    const accessToken = tokenJson.access_token;
    const refreshToken = tokenJson.refresh_token;
    if (!accessToken) {
      return res.status(400).send('<html><body><h3>Google access token missing</h3></body></html>');
    }
    const userInfo = await googleApiJson('https://www.googleapis.com/oauth2/v2/userinfo', accessToken);
    const accountId = albumStore.upsertCloudAccount({
      provider: 'google_drive',
      accountId: String(userInfo.id || userInfo.email || generateId()),
      email: String(userInfo.email || 'unknown@gmail.com'),
      displayName: String(userInfo.name || userInfo.email || ''),
      status: 'active',
    });
    if (refreshToken) await setRefreshToken(accountId, refreshToken);
    albumStore.setCloudAccountStatus(accountId, 'active', null);

    try {
      const about = await googleApiJson('https://www.googleapis.com/drive/v3/about?fields=storageQuota', accessToken);
      const q = about.storageQuota || {};
      albumStore.setCloudAccountQuota(
        accountId,
        q.limit != null ? Number(q.limit) : null,
        q.usage != null ? Number(q.usage) : null,
      );
    } catch { }
    if (onLog) onLog(`Google account connected: ${userInfo.email || userInfo.id}`);
    broadcastCloudUpdate();
    return res.send('<html><body><h3>Google account connected</h3><script>window.close();</script></body></html>');
  }));

  app.delete('/api/cloud/accounts/:id', asyncHandler(async (req, res) => {
    const accountId = req.params.id;
    const account = albumStore.getCloudAccount(accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    albumStore.deleteCloudAccount(accountId);
    await deleteRefreshToken(accountId);
    broadcastCloudUpdate();
    res.json({ ok: true });
  }));

  app.get('/api/cloud/albums/:id/coverage', (req, res) => {
    const albumId = req.params.id;
    const album = albumStore.getAlbumMeta(albumId);
    if (!album) return res.status(404).json({ error: 'Album not found' });
    const coverage = albumStore.getAlbumCloudCoverage(albumId);
    res.json({ albumId, coverage });
  });

  app.get('/api/cloud/coverage-summary', (_req, res) => {
    const coverage = albumStore.getAllAlbumsCloudCoverage();
    res.json({ coverage });
  });

  app.get('/api/cloud/uploaded-albums', (_req, res) => {
    const rows = albumStore.listUploadedAlbums();
    const albumMap = new Map();
    for (const r of rows) {
      if (!albumMap.has(r.id)) {
        const coverage = albumStore.getAlbumCloudCoverage(r.id);
        const topFolders = albumStore.getAlbumTopFolders(r.id, 5);
        albumMap.set(r.id, {
          id: r.id, name: r.name, mode: r.mode,
          topFolders,
          uploaded: coverage.fullyBackedUp,
          total: coverage.total,
          driveLinks: [],
        });
      }
      const entry = albumMap.get(r.id);
      entry.driveLinks.push({
        folderId: r.folderId,
        url: `https://drive.google.com/drive/folders/${r.folderId}`,
        account: r.accountEmail,
      });
    }
    res.json({ albums: Array.from(albumMap.values()) });
  });

  app.get('/api/cloud/albums/:id/items', (req, res) => {
    const albumId = req.params.id;
    const album = albumStore.getAlbumMeta(albumId);
    if (!album) return res.status(404).json({ error: 'Album not found' });
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const items = albumStore.getCloudUploadItemsByAlbum(albumId, { offset, limit });
    res.json({ items });
  });

  app.post('/api/cloud/uploads/start', asyncHandler(async (req, res) => {
    const { albumId, mode, mediaScope, accountIds } = req.body || {};
    if (!albumId || !['duplicate', 'distribute'].includes(mode) || !['all', 'selected'].includes(mediaScope)) {
      return res.status(400).json({ error: 'Need albumId, mode (duplicate|distribute), mediaScope (all|selected)' });
    }
    if (!Array.isArray(accountIds) || accountIds.length === 0) {
      return res.status(400).json({ error: 'Need at least one cloud account' });
    }
    const album = albumStore.getAlbumMeta(albumId);
    if (!album) return res.status(404).json({ error: 'Album not found' });
    for (const accId of accountIds) {
      if (!albumStore.getCloudAccount(accId)) {
        return res.status(400).json({ error: `Unknown account: ${accId}` });
      }
    }

    albumStore.setCloudAlbumTargets(albumId, accountIds, mode, mediaScope);
    const runId = albumStore.createCloudUploadRun({ albumId, mode, mediaScope, targetAccountIds: accountIds });
    const paths = albumStore.getAlbumMediaPaths(albumId, mediaScope);
    const items = [];
    if (mode === 'duplicate') {
      for (const p of paths) {
        for (const accId of accountIds) items.push({ path: p, accountId: accId });
      }
    } else {
      for (let i = 0; i < paths.length; i++) {
        const accId = await chooseDistributeAccount(accountIds) || accountIds[i % accountIds.length];
        items.push({ path: paths[i], accountId: accId });
      }
    }
    albumStore.enqueueCloudUploadItems(runId, albumId, items);
    if (onLog) onLog(`Cloud upload started: ${album.name} (${mode}, ${items.length} queued copies)`);
    albumStore.createCloudNotification({
      albumId,
      runId,
      type: 'upload_started',
      title: 'Upload started',
      message: album.name,
      payload: { topFolders: albumStore.getAlbumTopFolders(albumId, 3) },
    });
    processRun(runId).catch(() => { });
    broadcastCloudUpdate();
    res.json({ ok: true, runId, queuedItems: items.length });
  }));

  app.get('/api/cloud/uploads/runs', (req, res) => {
    const status = String(req.query.status || '');
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const runs = albumStore.listCloudUploadRuns({ status, limit });
    res.json({ runs });
  });

  app.get('/api/cloud/uploads/runs/:id', (req, res) => {
    const run = albumStore.getCloudUploadRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const coverage = albumStore.getAlbumCloudCoverage(run.albumId);
    res.json({ run, coverage });
  });

  app.post('/api/cloud/uploads/runs/:id/pause', (req, res) => {
    const run = albumStore.getCloudUploadRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    albumStore.setCloudRunStatus(run.id, 'paused', null);
    albumStore.createCloudNotification({
      albumId: run.albumId,
      runId: run.id,
      type: 'upload_paused',
      title: 'Upload paused',
      message: run.albumId,
      payload: { topFolders: albumStore.getAlbumTopFolders(run.albumId, 3) },
    });
    broadcastCloudUpdate();
    res.json({ ok: true });
  });

  app.post('/api/cloud/uploads/runs/:id/resume', (req, res) => {
    const run = albumStore.getCloudUploadRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    albumStore.setCloudRunStatus(run.id, 'queued', null);
    processRun(run.id).catch(() => { });
    broadcastCloudUpdate();
    res.json({ ok: true });
  });

  app.post('/api/cloud/uploads/runs/:id/cancel', (req, res) => {
    const run = albumStore.getCloudUploadRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    albumStore.setCloudRunStatus(run.id, 'cancelled', null);
    albumStore.createCloudNotification({
      albumId: run.albumId,
      runId: run.id,
      type: 'upload_cancelled',
      title: 'Upload cancelled',
      message: run.albumId,
      payload: { topFolders: albumStore.getAlbumTopFolders(run.albumId, 3) },
    });
    broadcastCloudUpdate();
    res.json({ ok: true });
  });

  app.post('/api/cloud/uploads/runs/:id/retry-failed', (req, res) => {
    const run = albumStore.getCloudUploadRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    const items = albumStore.listPendingCloudUploadItems(run.id, 500);
    for (const it of items) {
      if (it.state === 'failed') albumStore.setCloudUploadItemState(it.id, 'queued', { errorMessage: null });
    }
    albumStore.setCloudRunStatus(run.id, 'queued', null);
    processRun(run.id).catch(() => { });
    broadcastCloudUpdate();
    res.json({ ok: true });
  });

  app.get('/api/cloud/notifications', (req, res) => {
    const includeDismissed = req.query.includeDismissed === '1';
    const notifications = albumStore.listCloudNotifications({ includeDismissed, limit: 200 });
    res.json({ notifications });
  });

  app.post('/api/cloud/notifications/:id/action', (req, res) => {
    const { action, snoozeMinutes } = req.body || {};
    if (!['open', 'dismiss', 'snooze'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }
    let snoozeUntil = null;
    if (action === 'snooze') {
      const min = Math.max(5, Math.min(24 * 60, parseInt(snoozeMinutes, 10) || 120));
      snoozeUntil = new Date(Date.now() + min * 60 * 1000).toISOString();
    }
    albumStore.updateCloudNotificationState(req.params.id, action, snoozeUntil);
    broadcastCloudUpdate();
    res.json({ ok: true });
  });

  app.get('/api/cloud/resume-candidates', (req, res) => {
    const runs = albumStore.listCloudUploadRuns({ limit: 200 }).filter((r) => ['queued', 'running', 'paused', 'failed'].includes(r.status));
    const grouped = runs.map((r) => ({
      runId: r.id,
      albumId: r.albumId,
      albumName: r.albumName,
      status: r.status,
      uploadedItems: r.uploadedItems,
      totalItems: r.totalItems,
      failedItems: r.failedItems,
      topFolders: albumStore.getAlbumTopFolders(r.albumId, 3),
    }));
    res.json({ runs: grouped });
  });

  // ---- File actions (reveal / open) ----

  app.post('/api/file/reveal', (req, res) => {
    const { path: filePath } = req.body || {};
    if (!filePath || !path.isAbsolute(filePath)) {
      return res.status(400).json({ error: 'Need absolute file path' });
    }
    const { exec } = require('child_process');
    if (process.platform === 'darwin') {
      exec(`open -R "${filePath}"`);
    } else if (process.platform === 'win32') {
      exec(`explorer /select,"${filePath}"`);
    }
    if (onLog) onLog(`Revealed: ${path.basename(filePath)}`);
    res.json({ ok: true });
  });

  app.post('/api/file/open', (req, res) => {
    const { path: filePath } = req.body || {};
    if (!filePath || !path.isAbsolute(filePath)) {
      return res.status(400).json({ error: 'Need absolute file path' });
    }
    const { exec } = require('child_process');
    if (process.platform === 'darwin') {
      exec(`open "${filePath}"`);
    } else if (process.platform === 'win32') {
      exec(`start "" "${filePath}"`);
    }
    if (onLog) onLog(`Opened: ${path.basename(filePath)}`);
    res.json({ ok: true });
  });

  // ---- Cache management ----

  async function getDirSize(dir) {
    let total = 0;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isFile()) {
          const stat = await fs.stat(full);
          total += stat.size;
        }
      }
    } catch { }
    return total;
  }

  app.get('/api/cache/stats', asyncHandler(async (_, res) => {
    const [previews, thumbs, transcoded] = await Promise.all([
      getDirSize(previewDir),
      getDirSize(thumbDir),
      getDirSize(transcodeDir),
    ]);
    res.json({ previews, thumbs, transcoded, total: previews + thumbs + transcoded });
  }));

  app.post('/api/cache/clear', asyncHandler(async (_, res) => {
    for (const dir of [previewDir, thumbDir, transcodeDir]) {
      try { await fs.rm(dir, { recursive: true, force: true }); } catch { }
    }
    if (onLog) onLog('Cache cleared');
    res.json({ ok: true });
  }));

  // ---- Heartbeat / Devices ----

  app.post('/api/heartbeat', (req, res) => {
    const deviceId = req.cookies?.deviceId;
    if (!deviceId) return res.status(401).json({ error: 'Not joined' });
    const { albumId } = req.body || {};
    const d = touchDevice(deviceId);
    if (albumId) d.currentAlbumId = albumId;
    res.json({ ok: true });
  });

  app.get('/api/devices', (_, res) => {
    res.json({ devices: getDeviceList() });
  });

  // ---- Legacy ----

  app.get('/api/list', asyncHandler(async (req, res) => {
    if (registeredFolders.size === 0) return res.status(400).json({ error: 'No folders registered' });
    const ip = req.ip || req.connection?.remoteAddress || '';
    if (onLog && ip && ip !== '::1' && ip !== '127.0.0.1') onLog(`Phone connected — ${ip}`);
    const absPaths = await scanAllFolders();
    state.order = absPaths;
    await saveState();
    res.json({ paths: absPaths, lastIndex: state.lastIndex, choices: state.choices });
  }));

  // ---- RAW image conversion ----

  const RAW_EXT = new Set([
    '.nef', '.arw', '.sr2', '.srf', '.cr2', '.cr3',
    '.dng', '.raf', '.raw', '.orf', '.rw2', '.pef', '.heic', '.heif',
  ]);
  const convertingInProgress = new Map();
  const previewDir = path.join(dataDir, 'previews');

  function getPreviewPath(absPath) {
    const hash = crypto.createHash('md5').update(absPath).digest('hex');
    return path.join(previewDir, `${hash}.jpg`);
  }

  function readExifOrientation(filePath) {
    return new Promise((resolve) => {
      const proc = spawn('exiftool', ['-n', '-Orientation', '-s', '-s', '-s', filePath]);
      let out = '';
      proc.stdout.on('data', (d) => { out += d; });
      proc.stderr.on('data', () => { });
      proc.on('error', () => resolve(1));
      proc.on('close', () => {
        const val = parseInt(out.trim(), 10);
        resolve(Number.isFinite(val) ? val : 1);
      });
    });
  }

  async function applyExifRotation(srcPath, destPath, originalPath) {
    if (!sharp) {
      await fs.rename(srcPath, destPath);
      return;
    }
    let pipeline = sharp(srcPath);
    if (originalPath) {
      const orient = await readExifOrientation(originalPath);
      // EXIF orientation → sharp transforms
      // 2: flip horizontal, 3: 180°, 4: flip vertical
      // 5: transpose (flip H + 270° CW), 6: 90° CW, 7: transverse (flip H + 90° CW), 8: 270° CW
      if (orient === 2) pipeline = pipeline.flop();
      else if (orient === 3) pipeline = pipeline.rotate(180);
      else if (orient === 4) pipeline = pipeline.flip();
      else if (orient === 5) pipeline = pipeline.flop().rotate(270);
      else if (orient === 6) pipeline = pipeline.rotate(90);
      else if (orient === 7) pipeline = pipeline.flop().rotate(90);
      else if (orient === 8) pipeline = pipeline.rotate(270);
    } else {
      pipeline = pipeline.rotate();
    }
    await pipeline.jpeg({ quality: 85 }).toFile(destPath);
    if (srcPath !== destPath) {
      try { await fs.unlink(srcPath); } catch { }
    }
  }

  async function ensurePreview(absPath) {
    const cached = getPreviewPath(absPath);
    try {
      await fs.access(cached);
      return cached;
    } catch { }

    if (convertingInProgress.has(absPath)) {
      return convertingInProgress.get(absPath);
    }

    await fs.mkdir(previewDir, { recursive: true });

    const promise = new Promise((resolve, reject) => {
      const tmpPath = cached.replace(/\.jpg$/, '.tmp.jpg');

      // Try fast embedded JPEG extraction first (exiftool), fall back to sips/ffmpeg
      const exifProc = spawn('exiftool', ['-b', '-PreviewImage', absPath]);
      const writeStream = fsSync.createWriteStream(tmpPath);
      let gotData = false;
      exifProc.stdout.on('data', () => { gotData = true; });
      exifProc.stdout.pipe(writeStream);
      exifProc.stderr.on('data', () => { });

      exifProc.on('close', async (code) => {
        writeStream.end();
        if (code === 0 && gotData) {
          try {
            const stat = await fs.stat(tmpPath);
            if (stat.size > 1000) {
              await applyExifRotation(tmpPath, cached, absPath);
              return resolve(cached);
            }
          } catch { }
        }
        // Fallback: full decode via sips (macOS) or ffmpeg
        try { await fs.unlink(tmpPath); } catch { }
        let proc;
        if (process.platform === 'darwin') {
          proc = spawn('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', absPath, '--out', tmpPath]);
        } else {
          proc = spawn('ffmpeg', ['-i', absPath, '-vframes', '1', '-q:v', '2', '-y', tmpPath],
            { stdio: ['ignore', 'ignore', 'ignore'] });
        }
        proc.on('close', async (code2) => {
          if (code2 === 0) {
            try { await applyExifRotation(tmpPath, cached, absPath); resolve(cached); }
            catch (err) { reject(err); }
          } else {
            try { await fs.unlink(tmpPath); } catch { }
            reject(new Error(`Preview conversion failed`));
          }
        });
        proc.on('error', reject);
      });

      exifProc.on('error', () => {
        writeStream.end();
        // exiftool not installed — fall back directly
        let proc;
        if (process.platform === 'darwin') {
          proc = spawn('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', absPath, '--out', tmpPath]);
        } else {
          proc = spawn('ffmpeg', ['-i', absPath, '-vframes', '1', '-q:v', '2', '-y', tmpPath],
            { stdio: ['ignore', 'ignore', 'ignore'] });
        }
        proc.on('close', async (code2) => {
          if (code2 === 0) {
            try { await fs.rename(tmpPath, cached); resolve(cached); }
            catch (err) { reject(err); }
          } else {
            try { await fs.unlink(tmpPath); } catch { }
            reject(new Error(`Preview conversion failed`));
          }
        });
        proc.on('error', reject);
      });
    });

    convertingInProgress.set(absPath, promise);
    promise.finally(() => convertingInProgress.delete(absPath));
    return promise;
  }

  // ---- Background preview pre-generation ----

  const PREVIEW_LOOKAHEAD = 20;
  const preGenQueued = new Set();
  let preGenActive = false;

  function preGeneratePreviews(mediaPaths) {
    if (!mediaPaths || mediaPaths.length === 0) return;
    const newPaths = mediaPaths.filter(p =>
      RAW_EXT.has(path.extname(p).toLowerCase()) && !preGenQueued.has(p)
    );
    if (newPaths.length === 0) return;
    for (const p of newPaths) preGenQueued.add(p);
    if (preGenActive) return; // already processing the queue
    preGenActive = true;
    console.log(`[PREVIEW] queued ${newPaths.length} RAW previews for background generation`);
    (async () => {
      while (preGenQueued.size > 0) {
        const p = preGenQueued.values().next().value;
        preGenQueued.delete(p);
        try {
          await ensurePreview(p);
        } catch { }
      }
      preGenActive = false;
    })();
  }

  // ---- Video thumbnails ----

  const ALL_VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv']);
  const thumbsInProgress = new Map();
  const thumbDir = path.join(dataDir, 'thumbs');

  function getThumbPath(absPath) {
    const hash = crypto.createHash('md5').update(absPath).digest('hex');
    return path.join(thumbDir, `${hash}.jpg`);
  }

  function ensureThumb(absPath) {
    // Check in-progress map FIRST (sync) to prevent races
    if (thumbsInProgress.has(absPath)) {
      return thumbsInProgress.get(absPath);
    }

    const cached = getThumbPath(absPath);
    const tryExtract = (seekSec) => new Promise((resolve, reject) => {
      const tmpPath = cached.replace(/\.jpg$/, '.tmp.jpg');
      const proc = spawn('ffmpeg', [
        '-ss', String(seekSec),
        '-i', absPath,
        '-frames:v', '1',
        '-vf', 'scale=320:-2',
        '-q:v', '4',
        '-y', tmpPath,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });

      let stderrBuf = '';
      proc.stderr.on('data', (d) => { stderrBuf += d.toString().slice(-500); });

      proc.on('close', async (code) => {
        if (code === 0) {
          try {
            const stat = await fs.stat(tmpPath);
            if (stat.size > 500) {
              await fs.rename(tmpPath, cached);
              return resolve(cached);
            }
          } catch { }
        }
        try { await fs.unlink(tmpPath); } catch { }
        reject(new Error(`Thumb failed (code ${code}): ${stderrBuf.slice(-200)}`));
      });
      proc.on('error', reject);
    });

    const promise = (async () => {
      try {
        await fs.access(cached);
        return cached;
      } catch { }

      await fs.mkdir(thumbDir, { recursive: true });
      return tryExtract(1).catch(() => tryExtract(0));
    })();

    thumbsInProgress.set(absPath, promise);
    promise.catch(() => { }).finally(() => thumbsInProgress.delete(absPath));
    return promise;
  }

  // ---- Video transcoding for browser-incompatible codecs ----

  const VIDEO_TRANSCODE_EXT = new Set(['.mov', '.avi', '.mkv']);
  const transcodingInProgress = new Map();
  const transcodeDir = path.join(dataDir, 'transcoded');

  function getTranscodePath(absPath) {
    const hash = crypto.createHash('md5').update(absPath).digest('hex');
    return path.join(transcodeDir, `${hash}.mp4`);
  }

  function ensureTranscoded(absPath) {
    // Check in-progress map FIRST (sync) to prevent races
    if (transcodingInProgress.has(absPath)) {
      return transcodingInProgress.get(absPath);
    }

    const cached = getTranscodePath(absPath);
    const promise = (async () => {
      try {
        await fs.access(cached);
        return cached;
      } catch { }

      await fs.mkdir(transcodeDir, { recursive: true });

      if (onLog) onLog(`Transcoding: ${path.basename(absPath)}`);
      return new Promise((resolve, reject) => {
        const tmpPath = cached + '.tmp.mp4';
        const proc = spawn('ffmpeg', [
          '-i', absPath,
          '-map', '0:v:0', '-map', '0:a:0?',
          '-write_tmcd', '0',
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '28',
          '-vf', 'scale=-2:720',
          '-video_track_timescale', '90000',
          '-c:a', 'aac', '-b:a', '96k',
          '-movflags', '+faststart',
          '-y', tmpPath,
        ], { stdio: ['ignore', 'ignore', 'ignore'] });

        proc.on('close', async (code) => {
          if (code === 0) {
            try {
              await fs.rename(tmpPath, cached);
              if (onLog) onLog(`Transcoded: ${path.basename(absPath)}`);
              resolve(cached);
            } catch (err) { reject(err); }
          } else {
            try { await fs.unlink(tmpPath); } catch { }
            reject(new Error(`Transcode failed (code ${code})`));
          }
        });
        proc.on('error', reject);
      });
    })();

    transcodingInProgress.set(absPath, promise);
    promise.finally(() => transcodingInProgress.delete(absPath));
    return promise;
  }

  app.get('/api/media', asyncHandler(async (req, res) => {
    const absPath = req.query.path;
    if (!absPath) return res.status(400).send('Missing path');
    if (!path.isAbsolute(absPath)) return res.status(400).send('Path must be absolute');
    if (!hasMediaExt(absPath)) return res.status(403).send('Not a media file');
    try {
      await fs.access(absPath);
    } catch {
      return res.status(404).send('Not found');
    }

    const ext = path.extname(absPath).toLowerCase();

    if (req.query.thumb === '1' && ALL_VIDEO_EXT.has(ext)) {
      try {
        const thumbPath = await ensureThumb(absPath);
        res.setHeader('Content-Type', 'image/jpeg');
        return res.sendFile(thumbPath);
      } catch (err) {
        console.error(`[THUMB] Failed for ${path.basename(absPath)}:`, err?.message || err);
        return res.status(415).send('Cannot generate thumbnail');
      }
    }

    if (RAW_EXT.has(ext)) {
      try {
        const jpegPath = await ensurePreview(absPath);
        res.setHeader('Content-Type', 'image/jpeg');
        return res.sendFile(jpegPath);
      } catch {
        return res.status(415).send('Cannot convert this RAW format');
      }
    }

    if (VIDEO_TRANSCODE_EXT.has(ext)) {
      try {
        const mp4Path = await ensureTranscoded(absPath);
        res.setHeader('Content-Type', 'video/mp4');
        return res.sendFile(mp4Path);
      } catch {
        return res.sendFile(absPath);
      }
    }

    res.sendFile(absPath);
  }));

  app.get('/api/media/meta', asyncHandler(async (req, res) => {
    const absPath = req.query.path;
    if (!absPath) return res.status(400).json({ error: 'Missing path' });
    if (!path.isAbsolute(absPath)) return res.status(400).json({ error: 'Path must be absolute' });
    if (!hasMediaExt(absPath)) return res.status(403).json({ error: 'Not a media file' });
    try {
      await fs.access(absPath);
    } catch {
      return res.status(404).json({ error: 'Not found' });
    }

    const meta = await readMediaMeta(absPath);
    meta.rotation = albumStore.getRotation(absPath);
    res.json(meta);
  }));

  async function readMediaMeta(absPath) {
    const ext = path.extname(absPath).toLowerCase();
    const out = {
      date: null,
      location: null,
      camera: null,
      fileType: null,
      dimensions: null,
      duration: null,
    };
    out.fileType = ext.replace(/^\./, '').toUpperCase();

    return new Promise((resolve) => {
      const proc = spawn('exiftool', ['-json', '-n', '-q', absPath], { encoding: 'utf8' });
      let stdout = '';
      proc.stdout.on('data', (ch) => { stdout += ch; });
      proc.stderr.on('data', () => { });
      proc.on('error', () => resolve(out));
      proc.on('close', (code) => {
        if (code !== 0) return resolve(out);
        try {
          const arr = JSON.parse(stdout);
          const raw = Array.isArray(arr) && arr[0] ? arr[0] : {};
          const get = (...keys) => {
            for (const k of keys) {
              const v = raw[k];
              if (v != null && String(v).trim() !== '') return String(v).trim();
            }
            return null;
          };

          const dateStr = get('DateTimeOriginal', 'CreateDate', 'ModifyDate', 'FileModifyDate');
          if (dateStr) {
            try {
              const normalized = dateStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
              const d = new Date(normalized);
              if (!Number.isNaN(d.getTime())) {
                const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                let hrs = d.getHours();
                const ampm = hrs >= 12 ? 'PM' : 'AM';
                hrs = hrs % 12 || 12;
                const mins = String(d.getMinutes()).padStart(2, '0');
                out.date = `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]}, ${hrs}:${mins} ${ampm}`;
              }
            } catch { }
          }
          const lat = raw.GPSLatitude;
          const lon = raw.GPSLongitude;
          if (lat != null && lon != null) {
            const la = Number(lat);
            const lo = Number(lon);
            if (!Number.isNaN(la) && !Number.isNaN(lo)) {
              out.location = `${la.toFixed(4)}°, ${lo.toFixed(4)}°`;
            }
          }
          const make = get('Make');
          const model = get('Model');
          if (make || model) out.camera = [make, model].filter(Boolean).join(' ');

          const w = raw.ImageWidth != null ? Number(raw.ImageWidth) : null;
          const h = raw.ImageHeight != null ? Number(raw.ImageHeight) : null;
          const vw = raw.VideoFrameWidth != null ? Number(raw.VideoFrameWidth) : null;
          const vh = raw.VideoFrameHeight != null ? Number(raw.VideoFrameHeight) : null;
          const width = w ?? vw;
          const height = h ?? vh;
          if (width != null && height != null && !Number.isNaN(width) && !Number.isNaN(height)) {
            out.dimensions = `${Math.round(width)}×${Math.round(height)}`;
          }
          const dur = raw.Duration != null ? raw.Duration : raw.MediaDuration;
          if (dur != null) {
            const sec = typeof dur === 'number' ? dur : parseFloat(String(dur).replace(',', '.'));
            if (!Number.isNaN(sec) && sec > 0) {
              const m = Math.floor(sec / 60);
              const s = Math.floor(sec % 60);
              out.duration = m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
            }
          }
        } catch { }
        resolve(out);
      });
    });
  }

  app.post('/api/swipe', asyncHandler(async (req, res) => {
    const { path: itemPath, direction } = req.body || {};
    if (!itemPath || !['left', 'right'].includes(direction)) {
      return res.status(400).json({ error: 'Need path and direction (left|right)' });
    }
    const filename = path.basename(itemPath);
    state.choices.push({ path: itemPath, direction, at: new Date().toISOString() });
    const idx = state.order.indexOf(itemPath);
    if (idx !== -1) state.lastIndex = Math.max(state.lastIndex, idx + 1);
    await saveState();
    if (onLog) onLog(`${direction === 'right' ? 'Selected' : 'Skipped'}: ${filename}`);
    res.json({ ok: true });
  }));

  // ---- Error handler ----

  app.use((err, _req, res, _next) => {
    console.error('[server error]', err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return {
    getJoinUrl: () => (baseUrl ? `${baseUrl}/phone/?token=${currentJoinToken}` : null),
    addFolder(folder) {
      const resolved = path.resolve(folder);
      const isNew = !registeredFolders.has(resolved);
      registeredFolders.add(resolved);
      if (onLog) onLog(`Folder added: ${resolved}`);
      if (isNew) {
        setTimeout(() => startFaceScan(resolved), 2000);
      }
    },
    removeFolder(folder) {
      const resolved = path.resolve(folder);
      registeredFolders.delete(resolved);
      if (onLog) onLog(`Folder removed: ${resolved}`);
    },
    getFolders() {
      return Array.from(registeredFolders);
    },
    async start(port) {
      await loadState();
      releaseInterval = setInterval(releaseStaleAssignments, RELEASE_CHECK_INTERVAL_MS);
      return new Promise((resolve, reject) => {
        server = app.listen(port, '0.0.0.0', () => {
          wss = new WebSocketServer({ server });
          wss.on('connection', handleWsConnection);
          try {
            const resumable = albumStore.listCloudUploadRuns({ limit: 100 })
              .filter((r) => ['queued', 'running'].includes(r.status));
            for (const r of resumable) {
              albumStore.resetStuckCloudUploadItems(r.id);
              processRun(r.id).catch(() => { });
            }
            broadcastCloudUpdate();
          } catch { }
          // Auto-start face scan for all registered folders on startup
          if (registeredFolders.size > 0) {
            setTimeout(() => startFaceScan(null), 3000);
          }
          resolve();
        });
        server.on('error', reject);
      });
    },
    async stop() {
      if (releaseInterval) {
        clearInterval(releaseInterval);
        releaseInterval = null;
      }
      if (wss) {
        for (const ws of allWsClients) ws.close();
        allWsClients.clear();
        deviceWsMap.clear();
        wss.close();
        wss = null;
      }
      albumStore.close();
      if (server) {
        return new Promise((resolve) => {
          server.close(() => resolve());
        });
      }
    },
  };
}

module.exports = { createServer };
