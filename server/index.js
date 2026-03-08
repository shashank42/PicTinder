const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const { AlbumStore, generateId } = require('./albums');

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

function createServer(initialFolders, statePath, onLog, baseUrl) {
  const app = express();
  let server = null;
  let wss = null;
  const dataDir = path.join(path.dirname(statePath), 'pictinder-data');
  const albumStore = new AlbumStore(path.join(dataDir, 'pictinder.db'));

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
    } catch {}
  }

  async function broadcastJoinUrlUpdate() {
    const joinUrl = baseUrl ? `${baseUrl}/phone/?token=${currentJoinToken}` : null;
    let qrDataUrl = null;
    if (joinUrl) {
      try { qrDataUrl = await QRCode.toDataURL(joinUrl, { width: 140, margin: 1 }); } catch {}
    }
    broadcastAll({ type: 'join-url', joinUrl, qrDataUrl });
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
    } catch {}
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
    } catch {}

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
          try { qrDataUrl = await QRCode.toDataURL(joinUrl, { width: 140, margin: 1 }); } catch {}
        }
        const albums = albumStore.listDetailed();
        ws.send(JSON.stringify({ type: 'init', devices: deviceList, albums, joinUrl, qrDataUrl }));
      } catch {}
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
      } catch {}
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

    ws.on('error', () => {});
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
    registeredFolders.add(resolved);
    if (onLog) onLog(`Folder added: ${resolved}`);
    res.json({ folders: Array.from(registeredFolders) });
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
    if (!deviceId) return res.status(401).json({ error: 'Not joined' });
    const { name, mode } = req.body || {};
    if (!name || !['shared', 'distributed'].includes(mode)) {
      return res.status(400).json({ error: 'Need name and mode (shared|distributed)' });
    }
    if (registeredFolders.size === 0) {
      return res.status(400).json({ error: 'No folders registered' });
    }
    touchDevice(deviceId);
    const mediaPaths = await scanAllFolders();
    const album = albumStore.createAlbum(name, mode);
    albumStore.insertItems(album.id, mediaPaths);
    if (mode === 'shared') {
      albumStore.initSharedProgress(album.id, deviceId);
    }
    const dev = devices.get(deviceId);
    if (dev) dev.currentAlbumId = album.id;
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

  app.get('/api/albums/:id/shared/batch', (req, res) => {
    const albumId = req.params.id;
    const from = Math.max(0, parseInt(req.query.from, 10) || 0);
    const count = Math.min(1000, Math.max(1, parseInt(req.query.count, 10) || 200));
    const items = albumStore.getSharedBatch(albumId, from, count);
    res.json({ items });
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
    const result = albumStore.assignNextUnassigned(albumId, deviceId);
    res.json(result);
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
    const result = albumStore.getItems(albumId, { filter, offset, limit, includeVotes });
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
    } catch {}
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
      try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
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

  async function ensurePreview(absPath) {
    const cached = getPreviewPath(absPath);
    try {
      await fs.access(cached);
      return cached;
    } catch {}

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
      exifProc.stderr.on('data', () => {});

      exifProc.on('close', async (code) => {
        writeStream.end();
        if (code === 0 && gotData) {
          try {
            const stat = await fs.stat(tmpPath);
            if (stat.size > 1000) {
              await fs.rename(tmpPath, cached);
              return resolve(cached);
            }
          } catch {}
        }
        // Fallback: full decode via sips (macOS) or ffmpeg
        try { await fs.unlink(tmpPath); } catch {}
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
            try { await fs.unlink(tmpPath); } catch {}
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
            try { await fs.unlink(tmpPath); } catch {}
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

  // ---- Video thumbnails ----

  const ALL_VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv']);
  const thumbsInProgress = new Map();
  const thumbDir = path.join(dataDir, 'thumbs');

  function getThumbPath(absPath) {
    const hash = crypto.createHash('md5').update(absPath).digest('hex');
    return path.join(thumbDir, `${hash}.jpg`);
  }

  async function ensureThumb(absPath) {
    const cached = getThumbPath(absPath);
    try {
      await fs.access(cached);
      return cached;
    } catch {}

    if (thumbsInProgress.has(absPath)) {
      return thumbsInProgress.get(absPath);
    }

    await fs.mkdir(thumbDir, { recursive: true });

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
          } catch {}
        }
        try { await fs.unlink(tmpPath); } catch {}
        reject(new Error(`Thumb failed (code ${code}): ${stderrBuf.slice(-200)}`));
      });
      proc.on('error', reject);
    });

    const promise = tryExtract(1).catch(() => tryExtract(0));

    thumbsInProgress.set(absPath, promise);
    promise.catch(() => {}).finally(() => thumbsInProgress.delete(absPath));
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

  async function ensureTranscoded(absPath) {
    const cached = getTranscodePath(absPath);
    try {
      await fs.access(cached);
      return cached;
    } catch {}

    if (transcodingInProgress.has(absPath)) {
      return transcodingInProgress.get(absPath);
    }

    await fs.mkdir(transcodeDir, { recursive: true });

    const promise = new Promise((resolve, reject) => {
      const tmpPath = cached + '.tmp.mp4';
      if (onLog) onLog(`Transcoding: ${path.basename(absPath)}`);
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
          try { await fs.unlink(tmpPath); } catch {}
          reject(new Error(`Transcode failed (code ${code})`));
        }
      });
      proc.on('error', reject);
    });

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
      } catch {
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
      proc.stderr.on('data', () => {});
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
              const d = new Date(dateStr.replace(/:(\d{2})$/, ' $1'));
              if (!Number.isNaN(d.getTime())) out.date = d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
            } catch {}
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
        } catch {}
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
      registeredFolders.add(resolved);
      if (onLog) onLog(`Folder added: ${resolved}`);
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
