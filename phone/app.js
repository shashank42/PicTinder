const VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv']);
const base = '';
const WS_PING_INTERVAL_MS = 25000;
const HEARTBEAT_INTERVAL_MS = 25000;
const SHARED_BUFFER_SIZE = 500;
const SHARED_LOW_WATER = 50;

let albumId = null;
let mode = 'shared';
let paths = [];
let currentIndex = 0;
let heartbeatTimer = null;
let swiping = false;
let currentDistributedPath = null;

let totalItems = 0;
let pathsOffset = 0;
let bufferFetching = false;

let myDeviceId = null;
let ws = null;
let wsPingTimer = null;
let wsReconnectTimer = null;
let wsConnected = false;

let swipeHistory = [];

function getParams() {
  const p = new URLSearchParams(window.location.search);
  return { token: p.get('token'), albumId: p.get('albumId') };
}

function getMediaUrl(mediaPath) {
  return `${base}/api/media?path=${encodeURIComponent(mediaPath)}`;
}

function isVideo(p) {
  const ext = p.substring(p.lastIndexOf('.')).toLowerCase();
  return VIDEO_EXT.has(ext);
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function showScreen(id) {
  document.querySelectorAll('.screen, #loading, #empty, #app').forEach((el) => el.classList.add('hidden'));
  const el = document.getElementById(id);
  if (el) el.classList.remove('hidden');
}

function showLoading() { showScreen('loading'); }
function showJoinScreen() { showScreen('joinScreen'); }
function showCreateScreen() { showScreen('createScreen'); }
function showJoinListScreen() { showScreen('joinListScreen'); }
function showApp() { showScreen('app'); }

function showEmpty(msg) {
  showScreen('empty');
  document.getElementById('empty').textContent = msg || 'No media in this folder.';
}

// ---- Connection status ----

function updateStatus(connected) {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  if (dot) dot.className = `status-dot ${connected ? 'on' : 'off'}`;
  if (text) text.textContent = connected ? 'Connected' : 'Reconnecting…';
}

// ---- WebSocket ----

async function resolveDeviceId() {
  const stored = localStorage.getItem('pictinder_deviceId');
  if (stored) { myDeviceId = stored; return; }
  try {
    const res = await fetch(`${base}/api/whoami`, { credentials: 'include' });
    const data = await res.json();
    if (data.deviceId) {
      myDeviceId = data.deviceId;
      localStorage.setItem('pictinder_deviceId', myDeviceId);
    }
  } catch {}
}

function connectWs() {
  if (!myDeviceId) return;
  if (ws) { ws.close(); ws = null; }
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  try {
    ws = new WebSocket(`${proto}//${location.host}?deviceId=${myDeviceId}`);
  } catch { return; }

  ws.onopen = () => {
    wsConnected = true;
    updateStatus(true);
    if (albumId) {
      ws.send(JSON.stringify({ type: 'ping', albumId }));
    }
  };

  ws.onmessage = () => {};

  ws.onclose = () => {
    wsConnected = false;
    updateStatus(false);
    ws = null;
    wsReconnectTimer = setTimeout(connectWs, 2000);
  };

  ws.onerror = () => {};

  if (wsPingTimer) clearInterval(wsPingTimer);
  wsPingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping', albumId }));
    }
  }, WS_PING_INTERVAL_MS);
}

// ---- Album explorer ----

async function openAlbumExplorer() {
  const overlay = document.getElementById('albumExplorer');
  overlay.classList.remove('hidden');
  const listEl = document.getElementById('explorerAlbumList');
  listEl.innerHTML = '<div class="explorer-empty">Loading…</div>';

  try {
    const res = await fetch(`${base}/api/albums`, { credentials: 'include' });
    const data = await res.json();
    const albums = data.albums || [];
    listEl.innerHTML = '';
    if (albums.length === 0) {
      listEl.innerHTML = '<div class="explorer-empty">No albums yet.</div>';
    } else {
      albums.forEach((a) => {
        const item = document.createElement('div');
        item.className = `explorer-album-item ${a.id === albumId ? 'active' : ''}`;
        const modeLabel = a.mode === 'distributed' ? 'Distributed' : 'Shared';
        item.innerHTML =
          `<div class="explorer-album-top"><div class="explorer-album-name">${escapeHtml(a.name)}</div>` +
          `<button class="explorer-detail-btn" title="View details">` +
          `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/></svg></button></div>` +
          `<div class="explorer-album-meta"><span class="explorer-album-mode">${modeLabel}</span><span class="explorer-album-count">${a.swipedCount || 0} / ${a.totalItems || 0}</span></div>` +
          `<button type="button" class="explorer-delete-btn" title="Delete album">Delete</button>`;
        const detailBtn = item.querySelector('.explorer-detail-btn');
        const deleteBtn = item.querySelector('.explorer-delete-btn');
        detailBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          window.location.href = `/album-detail/?albumId=${a.id}`;
        });
        deleteBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete album "${a.name}"?\n\nThis removes all swipe data. No files on disk are deleted.`)) return;
          try {
            const delRes = await fetch(`${base}/api/albums/${a.id}`, { method: 'DELETE', credentials: 'include' });
            if (!delRes.ok) throw new Error('Failed');
            if (a.id === albumId) {
              closeAlbumExplorer();
              window.location.search = '';
              window.location.reload();
            } else {
              await openAlbumExplorer();
            }
          } catch {
            // keep list as is
          }
        });
        if (a.id !== albumId) {
          item.onclick = () => {
            fetch(`${base}/api/albums/${a.id}/join`, { method: 'POST', credentials: 'include' }).catch(() => {});
            window.location.search = `?albumId=${a.id}`;
          };
        }
        listEl.appendChild(item);
      });
    }
  } catch {
    listEl.innerHTML = '<div class="explorer-empty">Failed to load albums.</div>';
  }
}

function closeAlbumExplorer() {
  document.getElementById('albumExplorer').classList.add('hidden');
}

// ---- Media helpers ----

function getBufferedPath(index) {
  const localIdx = index - pathsOffset;
  return (localIdx >= 0 && localIdx < paths.length) ? paths[localIdx] : null;
}

function preloadNext(count = 10) {
  let loaded = 0;
  const base = currentIndex - pathsOffset;
  for (let i = 1; loaded < count; i++) {
    const idx = base + i;
    if (idx >= paths.length) break;
    const p = paths[idx];
    if (isVideo(p)) continue;
    const img = new Image();
    img.src = getMediaUrl(p);
    loaded++;
  }
}

async function ensureSharedBuffer() {
  if (bufferFetching) return;
  const localIdx = currentIndex - pathsOffset;
  if (localIdx >= 0 && paths.length - localIdx > SHARED_LOW_WATER) return;
  bufferFetching = true;
  try {
    const fetchFrom = pathsOffset + paths.length;
    const res = await fetch(`${base}/api/albums/${albumId}/shared/batch?from=${fetchFrom}&count=${SHARED_BUFFER_SIZE}`, { credentials: 'include' });
    const data = await res.json();
    if (data.items && data.items.length > 0) {
      for (const item of data.items) {
        paths.push(item.path);
      }
    }
  } catch {} finally {
    bufferFetching = false;
  }
  trimSharedBuffer();
}

function trimSharedBuffer() {
  const localIdx = currentIndex - pathsOffset;
  const trimCount = localIdx - 20;
  if (trimCount > 0) {
    paths.splice(0, trimCount);
    pathsOffset += trimCount;
  }
}

function setCurrentMedia(p) {
  const imgEl = document.getElementById('currentImg');
  const videoEl = document.getElementById('currentVideo');
  imgEl.src = '';
  imgEl.alt = p;
  videoEl.src = '';
  videoEl.pause();
  videoEl.classList.add('hidden');
  imgEl.classList.remove('hidden');
  const url = getMediaUrl(p);
  if (isVideo(p)) {
    imgEl.classList.add('hidden');
    videoEl.classList.remove('hidden');
    videoEl.src = url;
    videoEl.load();
    videoEl.play().catch(() => {});
  } else {
    imgEl.src = url;
  }
  setMetaOverlays(null, p);
  fetchMediaMeta(p).then((meta) => setMetaOverlays(meta, p));
}

function pathFilename(p) {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}
function pathDir(p) {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(0, idx + 1) : '';
}

function setMetaOverlays(meta, mediaPath) {
  const pathEl = document.getElementById('metaOverlayPath');
  const filenameEl = document.getElementById('metaOverlayFilename');
  const left = document.getElementById('metaOverlayLeft');
  const right = document.getElementById('metaOverlayRight');
  if (!pathEl || !filenameEl || !left || !right) return;
  pathEl.textContent = mediaPath ? pathDir(mediaPath) : '';
  filenameEl.textContent = mediaPath ? pathFilename(mediaPath) : '';
  if (!meta) {
    left.textContent = '';
    right.textContent = '';
    return;
  }
  left.textContent = [meta.date, meta.location].filter(Boolean).join(' · ') || '';
  right.textContent = [meta.camera, meta.fileType, meta.dimensions, meta.duration].filter(Boolean).join(' · ') || '';
}

async function fetchMediaMeta(mediaPath) {
  try {
    const res = await fetch(`${base}/api/media/meta?path=${encodeURIComponent(mediaPath)}`, { credentials: 'include' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function discardCurrent() {
  const imgEl = document.getElementById('currentImg');
  const videoEl = document.getElementById('currentVideo');
  imgEl.src = '';
  videoEl.src = '';
  videoEl.pause();
  videoEl.load();
}

function updateProgress(text) {
  const total = totalItems || paths.length;
  document.getElementById('progressText').textContent =
    text || `${currentIndex + 1} / ${total}`;
}

function updateUndoBtn() {
  const btn = document.getElementById('undoBtn');
  if (btn) btn.classList.toggle('hidden', swipeHistory.length === 0);
}

async function doUndo() {
  if (swiping || swipeHistory.length === 0) return;
  const last = swipeHistory.pop();
  updateUndoBtn();

  try {
    const res = await fetch(`${base}/api/albums/${albumId}/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ path: last.path }),
    });
    const data = await res.json();
    if (!data.ok) return;
  } catch { return; }

  if (mode === 'shared') {
    currentIndex--;
    if (typeof last.newLastIndex === 'number') {
      currentIndex = Math.max(0, last.newLastIndex);
    }
    await ensureSharedBuffer();
    const p = getBufferedPath(currentIndex);
    if (p) {
      setCurrentMedia(p);
      preloadNext(10);
      updateProgress();
    }
  } else {
    currentDistributedPath = last.path;
    setCurrentMedia(last.path);
    updateProgress('Swiping…');
  }
}

function getCurrentMediaPath() {
  if (mode === 'shared') return getBufferedPath(currentIndex);
  return currentDistributedPath;
}

function shareFilename(originalName, mime) {
  const base = originalName.replace(/\.[^.]+$/, '');
  const extMap = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm',
  };
  return base + (extMap[mime] || '.bin');
}

async function doShare() {
  const mediaPath = getCurrentMediaPath();
  if (!mediaPath) return;

  const url = getMediaUrl(mediaPath);
  const origName = mediaPath.split('/').pop();

  const shareBtn = document.getElementById('shareBtn');
  try {
    shareBtn.textContent = 'Loading…';
    shareBtn.disabled = true;

    const res = await fetch(url);
    const mime = res.headers.get('content-type') || 'application/octet-stream';
    const blob = await res.blob();
    const filename = shareFilename(origName, mime);
    const file = new File([blob], filename, { type: mime });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
    } else if (navigator.share) {
      await navigator.share({ title: filename, text: filename });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  } catch (e) {
    if (e.name !== 'AbortError') console.warn('Share failed:', e);
  } finally {
    shareBtn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/>' +
      '<polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> Share';
    shareBtn.disabled = false;
  }
}

async function doSave() {
  const mediaPath = getCurrentMediaPath();
  if (!mediaPath) return;

  const url = getMediaUrl(mediaPath);
  const origName = mediaPath.split('/').pop();
  const saveBtn = document.getElementById('saveBtn');

  try {
    saveBtn.textContent = 'Saving…';
    saveBtn.disabled = true;

    const res = await fetch(url);
    const mime = res.headers.get('content-type') || 'application/octet-stream';
    const blob = await res.blob();
    const filename = shareFilename(origName, mime);

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch {
    // silent fail
  } finally {
    saveBtn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>' +
      '<polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Save';
    saveBtn.disabled = false;
  }
}

function sendHttpHeartbeat() {
  if (!albumId) return;
  fetch(`${base}/api/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ albumId }),
  }).catch(() => {});
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (!albumId) return;
  heartbeatTimer = setInterval(() => {
    if (!wsConnected) sendHttpHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
}

function animateCard(cls, cb) {
  if (swiping) return;
  swiping = true;
  const card = document.getElementById('currentCard');
  card.classList.add(cls);
  setTimeout(() => {
    card.classList.remove(cls);
    swiping = false;
    cb();
  }, 260);
}

function setupInput(onSwipe) {
  const card = document.getElementById('currentCard');
  let startX = 0, startY = 0;
  card.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
  }, { passive: true });
  card.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      onSwipe(dx > 0 ? 'right' : 'left');
    }
  }, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') onSwipe('left');
    if (e.key === 'ArrowRight') onSwipe('right');
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); doUndo(); }
  });
}

// ---- Shared mode ----

function doSwipeShared(direction) {
  const itemPath = getBufferedPath(currentIndex);
  if (!itemPath || swiping) return;
  if (currentIndex >= totalItems) return;

  const cls = direction === 'left' ? 'swipe-left' : 'swipe-right';
  swipeHistory.push({ path: itemPath, direction, newLastIndex: currentIndex });
  updateUndoBtn();
  fetch(`${base}/api/albums/${albumId}/swipe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ path: itemPath, direction, lastIndex: currentIndex + 1 }),
  }).catch(() => {});

  animateCard(cls, async () => {
    discardCurrent();
    currentIndex++;
    if (currentIndex >= totalItems) {
      updateProgress('All done!');
      return;
    }
    await ensureSharedBuffer();
    const nextPath = getBufferedPath(currentIndex);
    if (nextPath) {
      setCurrentMedia(nextPath);
      preloadNext(10);
      updateProgress();
    } else {
      updateProgress('Loading…');
      await ensureSharedBuffer();
      const p = getBufferedPath(currentIndex);
      if (p) {
        setCurrentMedia(p);
        preloadNext(10);
        updateProgress();
      } else {
        updateProgress('All done!');
      }
    }
  });
}

// ---- Distributed mode ----

async function fetchNextDistributed() {
  try {
    const res = await fetch(`${base}/api/albums/${albumId}/next`, { credentials: 'include' });
    return await res.json();
  } catch {
    return { error: 'Network error' };
  }
}

function showNextDistributed() {
  discardCurrent();
  currentDistributedPath = null;
  fetchNextDistributed().then((data) => {
    if (data.error) {
      updateProgress('Error loading next item');
      return;
    }
    if (data.done) {
      updateProgress('All done!');
      return;
    }
    if (data.waiting) {
      updateProgress('Waiting for items…');
      setTimeout(showNextDistributed, 3000);
      return;
    }
    currentDistributedPath = data.path;
    setCurrentMedia(data.path);
    updateProgress('Swiping…');
  });
}

function doSwipeDistributed(direction) {
  if (!currentDistributedPath || swiping) return;
  const itemPath = currentDistributedPath;
  swipeHistory.push({ path: itemPath, direction });
  updateUndoBtn();
  const cls = direction === 'left' ? 'swipe-left' : 'swipe-right';
  const swipePromise = fetch(`${base}/api/albums/${albumId}/swipe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ path: itemPath, direction }),
  }).then((r) => r.json()).catch(() => ({}));
  animateCard(cls, async () => {
    const result = await swipePromise;
    if (result && result.alreadySwipedByOther) {
      discardCurrent();
      currentDistributedPath = null;
      const card = document.getElementById('currentCard');
      card.classList.add('swipe-up');
      setTimeout(() => {
        card.classList.remove('swipe-up');
        showNextDistributed();
      }, 300);
      return;
    }
    showNextDistributed();
  });
}

// ---- Album view ----

async function runAlbumView() {
  showLoading();
  await resolveDeviceId();
  connectWs();

  let data;
  try {
    const res = await fetch(`${base}/api/albums/${albumId}/state`, { credentials: 'include' });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load album');
  } catch (err) {
    showEmpty(err.message || 'Failed to load album');
    return;
  }
  mode = data.mode || 'shared';
  totalItems = data.totalItems || 0;
  startHeartbeat();

  if (totalItems === 0) {
    showEmpty('No media in this album.');
    return;
  }

  showApp();

  if (mode === 'shared') {
    currentIndex = Math.min(Math.max(0, data.lastIndex || 0), totalItems - 1);
    pathsOffset = currentIndex;
    paths = [];
    try {
      const batchRes = await fetch(`${base}/api/albums/${albumId}/shared/batch?from=${currentIndex}&count=${SHARED_BUFFER_SIZE}`, { credentials: 'include' });
      const batchData = await batchRes.json();
      paths = (batchData.items || []).map((i) => i.path);
    } catch {
      showEmpty('Failed to load media items.');
      return;
    }
    if (paths.length === 0) {
      showEmpty('No media in this album.');
      return;
    }
    setCurrentMedia(paths[0]);
    preloadNext(10);
    updateProgress();
    setupInput(doSwipeShared);
  } else {
    currentDistributedPath = null;
    setupInput(doSwipeDistributed);
    showNextDistributed();
  }
}

// ---- Join flow ----

async function runJoinFlow() {
  const { token } = getParams();
  if (!token) { runLegacyFlow(); return; }
  showLoading();
  let consumeData;
  try {
    const consumeRes = await fetch(`${base}/api/join/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token }),
    });
    consumeData = await consumeRes.json();
    if (!consumeRes.ok) throw new Error(consumeData.error || 'Invalid link');
  } catch (err) {
    showEmpty(err.message || 'Invalid link');
    return;
  }

  if (consumeData.deviceId) {
    myDeviceId = consumeData.deviceId;
    localStorage.setItem('pictinder_deviceId', myDeviceId);
    connectWs();
  }

  window.history.replaceState({}, '', window.location.pathname);
  showJoinScreen();

  document.getElementById('btnCreateAlbum').onclick = () => showCreateScreen();

  document.getElementById('btnJoinAlbum').onclick = async () => {
    let albums = [];
    try {
      const listRes = await fetch(`${base}/api/albums`, { credentials: 'include' });
      const listData = await listRes.json();
      albums = listData.albums || [];
    } catch {}
    const listEl = document.getElementById('albumList');
    listEl.innerHTML = '';
    if (albums.length === 0) {
      listEl.innerHTML = '<p style="color:#888">No albums yet. Create one first.</p>';
    } else {
      albums.forEach((a) => {
        const div = document.createElement('div');
        div.className = 'album-item';
        div.innerHTML = `<div>${escapeHtml(a.name)}</div><div class="album-mode">${a.mode === 'distributed' ? 'Distributed' : 'Shared'}</div>`;
        div.onclick = async () => {
          try {
            await fetch(`${base}/api/albums/${a.id}/join`, {
              method: 'POST',
              credentials: 'include',
            });
          } catch {}
          albumId = a.id;
          window.location.search = `?albumId=${a.id}`;
        };
        listEl.appendChild(div);
      });
    }
    showJoinListScreen();
  };

  document.getElementById('btnCreateSubmit').onclick = async () => {
    const name = document.getElementById('albumName').value.trim();
    const modeRadio = document.querySelector('input[name="mode"]:checked');
    const albumMode = modeRadio ? modeRadio.value : 'shared';
    if (!name) return;
    try {
      const createRes = await fetch(`${base}/api/albums`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name, mode: albumMode }),
      });
      const createData = await createRes.json();
      if (!createRes.ok) throw new Error(createData.error || 'Failed to create');
      albumId = createData.albumId;
      window.location.search = `?albumId=${albumId}`;
    } catch (err) {
      alert(err.message || 'Failed to create album');
    }
  };
}

// ---- Legacy (no album) ----

function doSwipeLegacy(direction) {
  if (currentIndex >= paths.length || swiping) return;
  const itemPath = paths[currentIndex];
  const cls = direction === 'left' ? 'swipe-left' : 'swipe-right';
  fetch(`${base}/api/swipe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: itemPath, direction }),
  }).catch(() => {});
  animateCard(cls, () => {
    discardCurrent();
    currentIndex++;
    if (currentIndex >= paths.length) {
      updateProgress('All done!');
      return;
    }
    setCurrentMedia(paths[currentIndex]);
    preloadNext(10);
    updateProgress();
  });
}

async function runLegacyFlow() {
  showLoading();
  try {
    const res = await fetch(`${base}/api/list`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load');
    paths = data.paths || [];
    currentIndex = Math.min(Math.max(0, data.lastIndex || 0), Math.max(paths.length - 1, 0));
  } catch (err) {
    showEmpty(err.message || 'Could not load media.');
    return;
  }
  if (paths.length === 0) {
    showEmpty();
    return;
  }
  showApp();
  setCurrentMedia(paths[currentIndex]);
  preloadNext(10);
  updateProgress();
  setupInput(doSwipeLegacy);
}

// ---- Init ----

async function init() {
  const { token, albumId: aid } = getParams();

  const undoBtn = document.getElementById('undoBtn');
  if (undoBtn) undoBtn.addEventListener('click', doUndo);

  const shareBtn = document.getElementById('shareBtn');
  if (shareBtn) shareBtn.addEventListener('click', doShare);

  const saveBtn = document.getElementById('saveBtn');
  if (saveBtn) saveBtn.addEventListener('click', doSave);

  const explorerBtn = document.getElementById('albumExplorerBtn');
  if (explorerBtn) explorerBtn.addEventListener('click', openAlbumExplorer);
  const closeBtn = document.getElementById('closeExplorer');
  if (closeBtn) closeBtn.addEventListener('click', closeAlbumExplorer);
  const backdrop = document.getElementById('explorerBackdrop');
  if (backdrop) backdrop.addEventListener('click', closeAlbumExplorer);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (myDeviceId && !wsConnected) {
      if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
      connectWs();
    }
    if (!wsConnected) sendHttpHeartbeat();
  });

  if (aid) {
    albumId = aid;
    await runAlbumView();
    return;
  }
  if (token) {
    await runJoinFlow();
    return;
  }
  await runLegacyFlow();
}

init();
