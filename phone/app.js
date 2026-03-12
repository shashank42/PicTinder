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
let feedFilter = { fileTypes: [], folderPaths: [], dedup: true };
let totalFiltered = null;

let myDeviceId = null;
let ws = null;
let wsPingTimer = null;
let wsReconnectTimer = null;
let wsConnected = false;

let swipeHistory = [];
let currentRotation = 0;
let itemRotations = {};

function getParams() {
  const p = new URLSearchParams(window.location.search);
  return { token: p.get('token'), albumId: p.get('albumId') };
}

const FILTER_STORAGE_KEY = 'pictinder_feed_filter';

function loadFeedFilter() {
  if (!albumId) return { fileTypes: [], folderPaths: [], dedup: true };
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return { fileTypes: [], folderPaths: [], dedup: true };
    const all = JSON.parse(raw);
    const saved = all[albumId];
    if (!saved || typeof saved !== 'object') return { fileTypes: [], folderPaths: [], dedup: true };
    return {
      fileTypes: saved.fileTypes || [],
      folderPaths: saved.folderPaths || [],
      dedup: saved.dedup !== false,
    };
  } catch {
    return { fileTypes: [], folderPaths: [], dedup: true };
  }
}

function saveFeedFilter(filter) {
  if (!albumId) return;
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY) || '{}';
    const all = JSON.parse(raw);
    all[albumId] = { fileTypes: filter.fileTypes || [], folderPaths: filter.folderPaths || [], dedup: filter.dedup !== false };
    localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(all));
  } catch { }
}

function hasActiveFilter() {
  return (feedFilter.fileTypes && feedFilter.fileTypes.length > 0) ||
    (feedFilter.folderPaths && feedFilter.folderPaths.length > 0);
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
  } catch { }
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

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'autoRotation' && msg.albumId === albumId && msg.path && msg.rotation != null) {
        itemRotations[msg.path] = msg.rotation;
        autoRotatedItems.add(msg.path);
        if (getCurrentMediaPath() === msg.path) {
          currentRotation = msg.rotation;
          applyTransform();
          updateAutoRotBadge(msg.path);
        }
      }
    } catch { }
  };

  ws.onclose = () => {
    wsConnected = false;
    updateStatus(false);
    ws = null;
    wsReconnectTimer = setTimeout(connectWs, 2000);
  };

  ws.onerror = () => { };

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
            fetch(`${base}/api/albums/${a.id}/join`, { method: 'POST', credentials: 'include' }).catch(() => { });
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

// ---- Identity Manager ----

async function openIdentityManager() {
  const overlay = document.getElementById('identityManagerOverlay');
  overlay.classList.remove('hidden');
  const listEl = document.getElementById('identityList');
  listEl.innerHTML = '<span class="explorer-empty">Loading identities…</span>';
  try {
    const res = await fetch(`${base}/api/faces/identities`, { credentials: 'include' });
    const data = await res.json();
    listEl.innerHTML = '';
    const identities = data.identities || [];
    if (identities.length === 0) {
      listEl.innerHTML = '<div class="explorer-empty">No known people yet.</div>';
      return;
    }
    identities.forEach(ident => {
      const item = document.createElement('div');
      item.className = 'identity-item';

      const thumb = document.createElement('img');
      thumb.className = 'identity-thumb';
      thumb.src = ident.thumbnailUrl ? `${base}${ident.thumbnailUrl}` : 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
      item.appendChild(thumb);

      const info = document.createElement('div');
      info.className = 'identity-info';
      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.className = 'identity-name';
      nameInput.value = ident.name || '';
      nameInput.placeholder = 'Unnamed';
      info.appendChild(nameInput);
      item.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'identity-actions';

      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'identity-action-btn';
      saveBtn.title = 'Save Name';
      saveBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>';
      saveBtn.addEventListener('click', async () => {
        const newName = nameInput.value.trim();
        if (!newName) return;
        try {
          await fetch(`${base}/api/faces/identities/${ident.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ name: newName }),
          });
          nameInput.blur();
          cachedKnownIdentities = null; // force reload for suggestions later
        } catch { }
      });
      actions.appendChild(saveBtn);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'identity-action-btn danger';
      delBtn.title = 'Delete Identity';
      delBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Delete identity "${ident.name || ident.id}"? All faces will become unknown again.`)) return;
        try {
          await fetch(`${base}/api/faces/identities/${ident.id}`, { method: 'DELETE', credentials: 'include' });
          item.remove();
          cachedKnownIdentities = null;
        } catch { }
      });
      actions.appendChild(delBtn);

      item.appendChild(actions);
      listEl.appendChild(item);
    });
  } catch {
    listEl.innerHTML = '<div class="explorer-empty">Failed to load people.</div>';
  }
}

function closeIdentityManager() {
  document.getElementById('identityManagerOverlay').classList.add('hidden');
}

// ---- Filter overlay ----

function updateFilterBadge() {
  const badge = document.getElementById('filterBadge');
  if (!badge) return;
  const n = (feedFilter.fileTypes && feedFilter.fileTypes.length) +
    (feedFilter.folderPaths && feedFilter.folderPaths.length) +
    (feedFilter.identities && feedFilter.identities.length || 0);
  if (n > 0) {
    badge.textContent = String(n);
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

async function openFilterOverlay() {
  const overlay = document.getElementById('filterOverlay');
  overlay.classList.remove('hidden');
  const fileTypesEl = document.getElementById('filterFileTypes');
  const folderPathsEl = document.getElementById('filterFolderPaths');
  const identitiesEl = document.getElementById('filterIdentities');
  const folderSearchEl = document.getElementById('filterFolderSearch');
  const dedupEl = document.getElementById('filterDedup');
  if (dedupEl) dedupEl.checked = feedFilter.dedup !== false;
  fileTypesEl.innerHTML = '<span class="explorer-empty">Loading…</span>';
  folderPathsEl.innerHTML = '';
  if (identitiesEl) identitiesEl.innerHTML = '<span class="explorer-empty">Loading…</span>';

  try {
    // Load identities filter options
    if (identitiesEl) {
      const idRes = await fetch(`${base}/api/faces/identities`, { credentials: 'include' });
      const idData = await idRes.json();
      identitiesEl.innerHTML = '';
      (idData.identities || []).forEach((ident) => {
        if (!ident.name) return; // Only list named folks in filter
        const label = document.createElement('label');
        const checked = feedFilter.identities && feedFilter.identities.includes(ident.id);
        label.innerHTML = `<input type="checkbox" data-identity-id="${escapeHtml(ident.id)}" ${checked ? 'checked' : ''} /> <img src="${base}${ident.thumbnailUrl}" class="identity-thumb" style="width:20px;height:20px;display:inline-block;vertical-align:middle;margin:0 4px;" /> ${escapeHtml(ident.name)}`;
        identitiesEl.appendChild(label);
      });
      if (!identitiesEl.hasChildNodes()) identitiesEl.innerHTML = '<span class="explorer-empty" style="font-size:12px;margin-bottom:8px;display:block;">No named people found.</span>';
    }

    const res = await fetch(`${base}/api/albums/${albumId}/feed-filter-options`, { credentials: 'include' });
    const data = await res.json();
    fileTypesEl.innerHTML = '';
    (data.fileTypes || []).forEach((ft) => {
      const label = document.createElement('label');
      const checked = feedFilter.fileTypes && feedFilter.fileTypes.includes(ft.id);
      label.innerHTML = `<input type="checkbox" data-file-type="${escapeHtml(ft.id)}" ${checked ? 'checked' : ''} /> ${escapeHtml(ft.label)}`;
      fileTypesEl.appendChild(label);
    });
    const allFolders = (data.folderPaths || []).slice().sort();
    folderPathsEl.innerHTML = '';
    function renderFolders(search) {
      folderPathsEl.innerHTML = '';
      const q = (search || '').toLowerCase().trim();
      const list = q
        ? allFolders.filter((f) => f.toLowerCase().includes(q))
        : allFolders;
      list.forEach((fp) => {
        const depth = (fp.match(/\//g) || []).length;
        const indent = depth * 14;
        const label = document.createElement('label');
        label.className = 'filter-folder-row';
        label.style.paddingLeft = `${8 + indent}px`;
        const checked = feedFilter.folderPaths && feedFilter.folderPaths.includes(fp);
        label.innerHTML = `<input type="checkbox" data-folder-path="${escapeHtml(fp)}" ${checked ? 'checked' : ''} /> <span class="filter-folder-path">${escapeHtml(fp)}</span>`;
        label.querySelector('input').addEventListener('change', (e) => {
          const prefix = fp + '/';
          folderPathsEl.querySelectorAll('input[data-folder-path]').forEach((cb) => {
            if (cb.dataset.folderPath.startsWith(prefix)) cb.checked = e.target.checked;
          });
        });
        folderPathsEl.appendChild(label);
      });
      if (list.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'explorer-empty';
        empty.textContent = q ? 'No folders match your search.' : 'No subfolders in this album.';
        folderPathsEl.appendChild(empty);
      }
    }
    renderFolders('');
    if (folderSearchEl) {
      folderSearchEl.value = '';
      folderSearchEl.oninput = () => renderFolders(folderSearchEl.value);
    }
  } catch {
    fileTypesEl.innerHTML = '<span class="explorer-empty">Failed to load options.</span>';
  }
}

function closeFilterOverlay() {
  document.getElementById('filterOverlay').classList.add('hidden');
}

function getFilterSelectionFromOverlay() {
  const fileTypes = [];
  document.querySelectorAll('#filterFileTypes input:checked').forEach((el) => {
    const v = el.dataset.fileType;
    if (v) fileTypes.push(v);
  });
  const folderPaths = [];
  document.querySelectorAll('#filterFolderPaths input:checked').forEach((el) => {
    const v = el.dataset.folderPath;
    if (v) folderPaths.push(v);
  });
  const identities = [];
  document.querySelectorAll('#filterIdentities input:checked').forEach((el) => {
    const v = el.dataset.identityId;
    if (v) identities.push(v);
  });
  const dedupEl = document.getElementById('filterDedup');
  const dedup = dedupEl ? dedupEl.checked : true;
  return { fileTypes, folderPaths, identities, dedup };
}

function applyFilterAndReload() {
  feedFilter = getFilterSelectionFromOverlay();
  saveFeedFilter(feedFilter);
  updateFilterBadge();
  closeFilterOverlay();
  totalFiltered = null;
  if (mode === 'shared') {
    currentIndex = 0;
    pathsOffset = 0;
    paths = [];
    (async () => {
      try {
        const url = buildBatchQuery(0, SHARED_BUFFER_SIZE);
        const res = await fetch(url, { credentials: 'include' });
        const data = await res.json();
        if (data.totalFiltered != null) totalFiltered = data.totalFiltered;
        storeItemRotations(data.items || []);
        paths = (data.items || []).map((i) => i.path);
      } catch { }
      if (paths.length === 0) {
        updateProgress(hasActiveFilter() ? 'No media matches filter.' : '0 / 0');
        return;
      }
      setCurrentMedia(paths[0]);
      preloadNext(10);
      updateProgress();
    })();
    return;
  }
  if (mode === 'distributed') {
    (async () => {
      try {
        await fetch(`${base}/api/albums/${albumId}/release-assignments`, { method: 'POST', credentials: 'include' });
      } catch { }
      discardCurrent();
      currentDistributedPath = null;
      distributedHistory = [];
      distributedHistoryIdx = -1;
      navigateNext();
    })();
  }
}

function clearFilterAndReload() {
  feedFilter = { fileTypes: [], folderPaths: [], dedup: true };
  saveFeedFilter(feedFilter);
  updateFilterBadge();
  closeFilterOverlay();
  totalFiltered = null;
  window.location.reload();
}

// ---- Media helpers ----

function storeItemRotations(items) {
  for (const item of items) {
    if (item.rotation) itemRotations[item.path] = item.rotation;
  }
}

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

function buildBatchQuery(from, count) {
  const params = new URLSearchParams({ from: String(from), count: String(count) });
  if (feedFilter.fileTypes && feedFilter.fileTypes.length > 0) {
    params.set('fileTypes', feedFilter.fileTypes.join(','));
  }
  if (feedFilter.folderPaths && feedFilter.folderPaths.length > 0) {
    params.set('folderPaths', feedFilter.folderPaths.join(','));
  }
  if (feedFilter.identities && feedFilter.identities.length > 0) {
    params.set('identities', feedFilter.identities.join(','));
  }
  if (feedFilter.dedup === false) params.set('dedup', '0');
  return `${base}/api/albums/${albumId}/shared/batch?${params.toString()}`;
}

async function ensureSharedBuffer() {
  if (bufferFetching) return;
  const localIdx = currentIndex - pathsOffset;
  if (localIdx >= 0 && paths.length - localIdx > SHARED_LOW_WATER) return;
  bufferFetching = true;
  try {
    const fetchFrom = pathsOffset + paths.length;
    const url = buildBatchQuery(fetchFrom, SHARED_BUFFER_SIZE);
    const res = await fetch(url, { credentials: 'include' });
    const data = await res.json();
    if (data.totalFiltered != null) totalFiltered = data.totalFiltered;
    if (data.items && data.items.length > 0) {
      storeItemStatuses(data.items, data.deviceLabels);
      for (const item of data.items) {
        paths.push(item.path);
        if (item.rotation) itemRotations[item.path] = item.rotation;
      }
    }
  } catch { } finally {
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

let zoomScale = 1;
let zoomTx = 0;
let zoomTy = 0;

function applyTransform() {
  const imgEl = document.getElementById('currentImg');
  const videoEl = document.getElementById('currentVideo');
  const deg = currentRotation * 90;
  const isOddRotation = (((currentRotation % 4) + 4) % 4) % 2 === 1;
  let t = '';
  if (zoomScale !== 1 || zoomTx !== 0 || zoomTy !== 0) {
    t += `translate(${zoomTx}px, ${zoomTy}px) scale(${zoomScale}) `;
  }
  if (deg) t += `rotate(${deg}deg) `;
  t = t.trim() || 'none';
  imgEl.style.transform = t;
  videoEl.style.transform = t;
  // When rotated 90/270, swap element dimensions so object-fit: contain
  // works correctly in the rotated coordinate space
  const wrap = document.querySelector('.media-wrap');
  if (isOddRotation && wrap) {
    const w = wrap.clientWidth + 'px';
    const h = wrap.clientHeight + 'px';
    imgEl.style.width = h;
    imgEl.style.height = w;
    videoEl.style.width = h;
    videoEl.style.height = w;
  } else {
    imgEl.style.width = '';
    imgEl.style.height = '';
    videoEl.style.width = '';
    videoEl.style.height = '';
  }
}

function applyRotation(deg) {
  applyTransform();
}

function resetZoom(animate) {
  zoomScale = 1;
  zoomTx = 0;
  zoomTy = 0;
  const imgEl = document.getElementById('currentImg');
  const videoEl = document.getElementById('currentVideo');
  if (animate) {
    imgEl.style.transition = 'transform 0.2s ease';
    videoEl.style.transition = 'transform 0.2s ease';
    applyTransform();
    setTimeout(() => { imgEl.style.transition = ''; videoEl.style.transition = ''; }, 220);
  } else {
    applyTransform();
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
  zoomScale = 1; zoomTx = 0; zoomTy = 0;
  currentRotation = itemRotations[p] || 0;
  // Apply rotation instantly (no CSS transition) so it doesn't animate on scroll
  imgEl.style.transition = 'none';
  videoEl.style.transition = 'none';
  applyTransform();
  // Force reflow then restore transitions
  imgEl.offsetHeight;
  imgEl.style.transition = '';
  videoEl.style.transition = '';
  const url = getMediaUrl(p);
  if (isVideo(p)) {
    imgEl.classList.add('hidden');
    videoEl.classList.remove('hidden');
    videoEl.src = url;
    videoEl.load();
    videoEl.play().catch(() => { });
  } else {
    imgEl.src = url;
  }
  setMetaOverlays(null, p);
  // Check for unknown faces after a short delay to avoid blocking media display
  setTimeout(() => checkForUnknownFaces(p), 500);
  fetchMediaMeta(p).then((meta) => {
    if (meta && meta.rotation != null) {
      // Normalize both to 0-3 for comparison to avoid animating -1 → 3
      const normalizedCurrent = ((currentRotation % 4) + 4) % 4;
      const normalizedMeta = ((meta.rotation % 4) + 4) % 4;
      if (normalizedMeta !== normalizedCurrent) {
        currentRotation = meta.rotation;
        itemRotations[p] = meta.rotation;
        applyRotation(currentRotation * 90);
      }
    }
    setMetaOverlays(meta, p);
  });
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
  const createdEl = document.getElementById('metaOverlayCreated');
  if (!pathEl || !filenameEl || !left || !right) return;
  pathEl.textContent = mediaPath ? pathDir(mediaPath) : '';
  filenameEl.textContent = mediaPath ? pathFilename(mediaPath) : '';
  if (createdEl) createdEl.textContent = meta && meta.date ? meta.date : '';

  if (!meta) {
    // Initial reset — clear face UI so checkForUnknownFaces can repopulate
    const identitiesEl = document.getElementById('metaOverlayIdentities');
    if (identitiesEl) identitiesEl.innerHTML = '';
    const mainRect = document.getElementById('mainFaceRect');
    if (mainRect) mainRect.classList.add('hidden');
    clearAllFaceRects();
    const faceCountEl = document.getElementById('faceCountBadge');
    if (faceCountEl) faceCountEl.classList.add('hidden');
    allRectsVisible = false;

    left.textContent = '';
    right.textContent = '';
    return;
  }
  left.textContent = [meta.location].filter(Boolean).join(' · ') || '';
  right.textContent = [meta.camera, meta.fileType, meta.dimensions, meta.duration].filter(Boolean).join(' · ') || '';
}

async function fetchMediaMeta(mediaPath) {
  try {
    let url = `${base}/api/media/meta?path=${encodeURIComponent(mediaPath)}`;
    if (albumId) url += `&albumId=${encodeURIComponent(albumId)}`;
    const res = await fetch(url, { credentials: 'include' });
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
  const total = (totalFiltered != null ? totalFiltered : totalItems) || paths.length;
  document.getElementById('progressText').textContent =
    text || `${currentIndex + 1} / ${total}`;
}

function updateUndoBtn() {
  const btn = document.getElementById('undoBtn');
  if (btn) btn.classList.toggle('hidden', swipeHistory.length === 0);
}

async function doUndo() {
  if (swiping || swipeHistory.length === 0) return;
  const last = swipeHistory[swipeHistory.length - 1];

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

  swipeHistory.pop();
  updateUndoBtn();

  if (mode === 'shared') {
    currentIndex--;
    if (typeof last.newLastIndex === 'number') {
      currentIndex = Math.max(0, last.newLastIndex);
    }
    if (currentIndex < pathsOffset) {
      try {
        const url = buildBatchQuery(currentIndex, SHARED_BUFFER_SIZE);
        const res = await fetch(url, { credentials: 'include' });
        const data = await res.json();
        if (data.items && data.items.length > 0) {
          storeItemRotations(data.items || []);
          paths = (data.items || []).map((i) => i.path);
          pathsOffset = currentIndex;
          if (data.totalFiltered != null) totalFiltered = data.totalFiltered;
        }
      } catch { }
    } else {
      await ensureSharedBuffer();
    }
    const p = getBufferedPath(currentIndex);
    if (p) {
      itemStatuses[p] = 'unswiped';
      setCurrentMedia(p);
      updateSelectionIndicator(p);
      preloadNext(10);
      updateProgress();
    }
  } else {
    currentDistributedPath = last.path;
    itemStatuses[last.path] = 'unswiped';
    setCurrentMedia(last.path);
    updateSelectionIndicator(last.path);
    updateProgress();
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

async function doRotate() {
  const mediaPath = getCurrentMediaPath();
  if (!mediaPath || !albumId) return;
  // Decrement to rotate anti-clockwise (CSS will animate the shortest path)
  currentRotation = currentRotation - 1;
  itemRotations[mediaPath] = currentRotation;
  applyRotation(currentRotation * 90);
  try {
    // Normalize to 0-3 range for server storage
    const normalized = ((currentRotation % 4) + 4) % 4;
    await fetch(`${base}/api/albums/${albumId}/rotate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ path: mediaPath, rotation: normalized }),
    });
  } catch { }
}

async function doReveal() {
  const mediaPath = getCurrentMediaPath();
  if (!mediaPath) return;
  try {
    await fetch(`${base}/api/file/reveal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ path: mediaPath }),
    });
  } catch { }
}

async function doOpen() {
  const mediaPath = getCurrentMediaPath();
  if (!mediaPath) return;
  try {
    await fetch(`${base}/api/file/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ path: mediaPath }),
    });
  } catch { }
}

function sendHttpHeartbeat() {
  if (!albumId) return;
  fetch(`${base}/api/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ albumId }),
  }).catch(() => { });
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (!albumId) return;
  heartbeatTimer = setInterval(() => {
    if (!wsConnected) sendHttpHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
}

let itemStatuses = {};
let itemVotes = {};
let deviceLabels = {};
let autoRotatedItems = new Set();
let distributedHistory = [];
let distributedHistoryIdx = -1;
let inputSetup = false;

function updateSelectionIndicator(itemPath) {
  const badge = document.getElementById('selectionBadge');
  if (!badge) return;
  const status = itemStatuses[itemPath];
  if (status === 'selected') {
    badge.textContent = '❤️';
    badge.className = 'selection-badge badge-heart';
  } else if (status === 'discarded') {
    badge.textContent = '✗';
    badge.className = 'selection-badge badge-reject';
  } else {
    badge.className = 'selection-badge hidden';
  }
  updateVotesBar(itemPath);
  updateAutoRotBadge(itemPath);
}

function updateAutoRotBadge(itemPath) {
  const el = document.getElementById('autoRotBadge');
  if (!el) return;
  if (autoRotatedItems.has(itemPath)) {
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function updateVotesBar(itemPath) {
  const bar = document.getElementById('votesBar');
  if (!bar) return;
  const votes = itemVotes[itemPath];
  if (!votes || votes.length === 0 || mode !== 'shared') {
    bar.className = 'votes-bar hidden';
    bar.innerHTML = '';
    return;
  }
  const otherVotes = votes.filter(v => v.deviceId !== myDeviceId);
  if (otherVotes.length === 0) {
    bar.className = 'votes-bar hidden';
    bar.innerHTML = '';
    return;
  }
  bar.className = 'votes-bar';
  bar.innerHTML = otherVotes.map(v => {
    const label = deviceLabels[v.deviceId] || v.deviceId.slice(0, 4);
    const isYes = v.direction === 'right';
    const icon = isYes ? '❤️' : '✗';
    const cls = isYes ? 'vote-pip vote-pip-yes' : 'vote-pip vote-pip-no';
    return `<div class="${cls}">${icon} ${escapeHtml(label)}</div>`;
  }).join('');
}

async function toggleSelection() {
  const currentPath = mode === 'shared'
    ? getBufferedPath(currentIndex)
    : currentDistributedPath;
  if (!currentPath) return;

  try {
    const res = await fetch(`${base}/api/albums/${albumId}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ path: currentPath }),
    });
    const data = await res.json();
    if (data.ok) {
      itemStatuses[currentPath] = data.selected ? 'selected' : 'unswiped';
      if (mode === 'shared' && myDeviceId) {
        const votes = itemVotes[currentPath] || [];
        const filtered = votes.filter(v => v.deviceId !== myDeviceId);
        if (data.selected) {
          filtered.push({ deviceId: myDeviceId, direction: 'right' });
        }
        itemVotes[currentPath] = filtered;
      }
      updateSelectionIndicator(currentPath);
      flashToggle(data.selected);
    }
  } catch { }
}

async function rejectItem() {
  const currentPath = mode === 'shared'
    ? getBufferedPath(currentIndex)
    : currentDistributedPath;
  if (!currentPath || !albumId) return;

  try {
    const res = await fetch(`${base}/api/albums/${albumId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ path: currentPath }),
    });
    const data = await res.json();
    if (data.ok) {
      itemStatuses[currentPath] = 'discarded';
      updateSelectionIndicator(currentPath);
      flashReject();
    }
  } catch { }
}

function flashReject() {
  const flash = document.getElementById('toggleFlash');
  if (!flash) return;
  flash.innerHTML = '<span class="flash-icon flash-cross">✗</span>';
  flash.classList.remove('hidden');
  setTimeout(() => flash.classList.add('hidden'), 1000);
}

function flashToggle(selected) {
  const flash = document.getElementById('toggleFlash');
  if (!flash) return;
  if (selected) {
    flash.innerHTML = '<span class="flash-icon flash-heart">❤️</span>';
  } else {
    flash.innerHTML = '<span class="flash-icon flash-cross">↩</span>';
  }
  flash.classList.remove('hidden');
  setTimeout(() => flash.classList.add('hidden'), 1000);
}

const DISTRIBUTED_PREFETCH_COUNT = 3;
let distributedPreFetchRunning = false;

async function distributedPreFetch() {
  if (distributedPreFetchRunning) return;
  const buffered = distributedHistory.length - 1 - distributedHistoryIdx;
  if (buffered >= DISTRIBUTED_PREFETCH_COUNT) return;
  distributedPreFetchRunning = true;
  try {
    const needed = DISTRIBUTED_PREFETCH_COUNT - buffered;
    for (let i = 0; i < needed; i++) {
      const data = await fetchNextDistributed();
      if (data.error || data.done || data.waiting) break;
      distributedHistory.push(data.path);
      if (data.rotation) itemRotations[data.path] = data.rotation;
      itemStatuses[data.path] = 'unswiped';
      // Warm the browser image cache
      if (!isVideo(data.path)) {
        const img = new Image();
        img.src = getMediaUrl(data.path);
      }
    }
  } catch { } finally {
    distributedPreFetchRunning = false;
  }
}

async function navigateNext() {
  if (mode === 'shared') {
    const total = (totalFiltered != null ? totalFiltered : totalItems) || paths.length;
    if (currentIndex >= total - 1) return;
    currentIndex++;
    await ensureSharedBuffer();
    const p = getBufferedPath(currentIndex);
    if (p) {
      setCurrentMedia(p);
      updateSelectionIndicator(p);
      preloadNext(10);
      updateProgress();
    }
  } else {
    if (distributedHistoryIdx < distributedHistory.length - 1) {
      distributedHistoryIdx++;
      const p = distributedHistory[distributedHistoryIdx];
      currentDistributedPath = p;
      setCurrentMedia(p);
      updateSelectionIndicator(p);
      updateProgress();
    } else {
      const data = await fetchNextDistributed();
      if (data.error) { updateProgress('Error'); return; }
      if (data.done) { updateProgress('All done!'); return; }
      if (data.waiting) { updateProgress('Waiting…'); setTimeout(() => navigateNext(), 3000); return; }
      distributedHistory.push(data.path);
      distributedHistoryIdx = distributedHistory.length - 1;
      currentDistributedPath = data.path;
      if (data.rotation) itemRotations[data.path] = data.rotation;
      itemStatuses[data.path] = 'unswiped';
      setCurrentMedia(data.path);
      updateSelectionIndicator(data.path);
      updateProgress();
      // Pre-fetch next items in background for instant navigation
      distributedPreFetch();
    }
  }
}

function navigatePrev() {
  if (mode === 'shared') {
    if (currentIndex <= 0) return;
    currentIndex--;
    const p = getBufferedPath(currentIndex);
    if (p) {
      setCurrentMedia(p);
      updateSelectionIndicator(p);
      updateProgress();
    }
  } else {
    if (distributedHistoryIdx > 0) {
      distributedHistoryIdx--;
      const p = distributedHistory[distributedHistoryIdx];
      currentDistributedPath = p;
      setCurrentMedia(p);
      updateSelectionIndicator(p);
      updateProgress();
    }
  }
}

function setupInput() {
  if (inputSetup) return;
  inputSetup = true;
  const card = document.getElementById('currentCard');

  let startX = 0, startY = 0, lastTapTime = 0;
  let touchFingerMax = 0;
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  let panStartTx = 0, panStartTy = 0;
  let pinchMidX = 0, pinchMidY = 0;

  function fingerDist(t) {
    const dx = t[0].clientX - t[1].clientX;
    const dy = t[0].clientY - t[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function clampTranslation() {
    if (zoomScale <= 1) { zoomTx = 0; zoomTy = 0; return; }
    const wrap = document.querySelector('.media-wrap');
    if (!wrap) return;
    const maxTx = (wrap.clientWidth * (zoomScale - 1)) / 2;
    const maxTy = (wrap.clientHeight * (zoomScale - 1)) / 2;
    zoomTx = Math.max(-maxTx, Math.min(maxTx, zoomTx));
    zoomTy = Math.max(-maxTy, Math.min(maxTy, zoomTy));
  }

  card.addEventListener('touchstart', (e) => {
    if (e.target.closest('.face-scan-badge, .face-settings-popover, .face-count-badge, .identity-chip, .chip-popover')) return;
    const tc = e.touches.length;
    touchFingerMax = Math.max(touchFingerMax, tc);
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    if (tc >= 2) {
      pinchStartDist = fingerDist(e.touches);
      pinchStartScale = zoomScale;
      pinchMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      pinchMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      panStartTx = zoomTx;
      panStartTy = zoomTy;
    } else if (zoomScale > 1) {
      panStartTx = zoomTx;
      panStartTy = zoomTy;
    }
  }, { passive: true });

  card.addEventListener('touchmove', (e) => {
    if (e.target.closest('.face-scan-badge, .face-settings-popover, .face-count-badge, .identity-chip, .chip-popover')) return;
    const tc = e.touches.length;
    touchFingerMax = Math.max(touchFingerMax, tc);

    if (tc >= 2 && pinchStartDist > 0) {
      e.preventDefault();
      const newDist = fingerDist(e.touches);
      const ratio = newDist / pinchStartDist;
      zoomScale = Math.max(1, Math.min(5, pinchStartScale * ratio));
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      zoomTx = panStartTx + (midX - pinchMidX);
      zoomTy = panStartTy + (midY - pinchMidY);
      clampTranslation();
      applyTransform();
      return;
    }

    if (tc === 1 && zoomScale > 1) {
      e.preventDefault();
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      zoomTx = panStartTx + dx;
      zoomTy = panStartTy + dy;
      clampTranslation();
      applyTransform();
    }
  }, { passive: false });

  card.addEventListener('touchend', (e) => {
    if (e.target.closest('.face-scan-badge, .face-settings-popover, .face-count-badge, .identity-chip, .chip-popover')) return;
    if (e.touches.length > 0) return;

    const wasPinch = touchFingerMax >= 2;
    touchFingerMax = 0;
    pinchStartDist = 0;

    if (zoomScale <= 1.05) {
      resetZoom(true);
    }

    if (wasPinch || zoomScale > 1) return;

    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (Math.abs(dy) > 80 && Math.abs(dy) > Math.abs(dx)) {
      if (dy > 0) {
        rejectItem();
      } else {
        toggleSelection();
      }
      lastTapTime = 0;
      return;
    }

    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) navigateNext();
      else navigatePrev();
      lastTapTime = 0;
      return;
    }

    if (dist < 20) {
      const now = Date.now();
      if (now - lastTapTime < 300) {
        toggleSelection();
        lastTapTime = 0;
      } else {
        lastTapTime = now;
      }
    }
  }, { passive: true });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') navigatePrev();
    if (e.key === 'ArrowRight') navigateNext();
    if (e.key === 'ArrowUp' || e.key === 'Enter') { e.preventDefault(); toggleSelection(); }
    if (e.key === 'ArrowDown' || e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); rejectItem(); }
    if (e.key === 'Escape' && zoomScale > 1) { resetZoom(true); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') { e.preventDefault(); doUndo(); }
  });
}

// ---- Distributed mode ----

async function fetchNextDistributed() {
  try {
    const params = new URLSearchParams();
    if (feedFilter.fileTypes && feedFilter.fileTypes.length > 0) params.set('fileTypes', feedFilter.fileTypes.join(','));
    if (feedFilter.folderPaths && feedFilter.folderPaths.length > 0) params.set('folderPaths', feedFilter.folderPaths.join(','));
    if (feedFilter.dedup === false) params.set('dedup', '0');
    const qs = params.toString();
    const url = qs ? `${base}/api/albums/${albumId}/next?${qs}` : `${base}/api/albums/${albumId}/next`;
    const res = await fetch(url, { credentials: 'include' });
    return await res.json();
  } catch {
    return { error: 'Network error' };
  }
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

  feedFilter = loadFeedFilter();
  totalFiltered = null;
  updateFilterBadge();

  let loadedItems = [];
  if (mode === 'shared') {
    currentIndex = 0;
    pathsOffset = 0;
    paths = [];
    try {
      const url = buildBatchQuery(0, SHARED_BUFFER_SIZE);
      const batchRes = await fetch(url, { credentials: 'include' });
      const batchData = await batchRes.json();
      if (batchData.totalFiltered != null) totalFiltered = batchData.totalFiltered;
      loadedItems = batchData.items || [];
      if (batchData.deviceLabels) Object.assign(deviceLabels, batchData.deviceLabels);
      storeItemRotations(loadedItems);
      paths = loadedItems.map((i) => i.path);
    } catch {
      showEmpty('Failed to load media items.');
      return;
    }
    if (paths.length === 0) {
      showEmpty(hasActiveFilter() ? 'No media matches your filter.' : 'No media in this album.');
      return;
    }
    storeItemStatuses(loadedItems, null);
    setCurrentMedia(paths[0]);
    updateSelectionIndicator(paths[0]);
    preloadNext(10);
    updateProgress();
    setupInput();
  } else {
    distributedHistory = [];
    distributedHistoryIdx = -1;
    currentDistributedPath = null;
    setupInput();
    navigateNext();
  }
}

function storeItemStatuses(items, batchDeviceLabels) {
  if (batchDeviceLabels) {
    Object.assign(deviceLabels, batchDeviceLabels);
  }
  for (const item of items) {
    if (item.myChoice === 'right') {
      itemStatuses[item.path] = 'selected';
    } else if (item.status && item.status !== 'unswiped') {
      itemStatuses[item.path] = item.status;
    }
    if (item.votes) {
      itemVotes[item.path] = item.votes;
    }
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
    } catch { }
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
          } catch { }
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
  setupInput();
}

// ---- Face Prompt (unknown face identification) ----

let facePromptQueue = [];
let facePromptActive = false;
let facePromptSkippedOccurrences = new Set();
let facePromptsMuted = false;
let cachedKnownIdentities = null;

function getCurrentMediaPath() {
  if (mode === 'shared') {
    return getBufferedPath(currentIndex);
  }
  return currentDistributedPath || (distributedHistory.length > 0 ? distributedHistory[distributedHistoryIdx] : null);
}

async function checkForUnknownFaces(mediaPath) {
  if (!mediaPath || facePromptActive) return;
  // Update scan status indicator
  updateFaceScanBadge(mediaPath);
  try {
    const res = await fetch(`${base}/api/faces/item?path=${encodeURIComponent(mediaPath)}`, { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();

    // Show face chips (named + unnamed "?" chips) and count badge
    displayFaceChips(data.faces || []);
    updateFaceCountBadge(data.faces || []);

    const unknownFaces = (data.faces || []).filter(f =>
      (!f.identityId || !f.identityName?.trim()) && !facePromptSkippedOccurrences.has(f.id)
    );
    if (unknownFaces.length > 0 && !facePromptsMuted) {
      facePromptQueue = unknownFaces;
      showNextFacePrompt();
    }
  } catch { }
}

let mainRectHideTimeout = null;
let currentItemFaces = [];
let allRectsVisible = false;

function updateFaceCountBadge(faces) {
  currentItemFaces = faces || [];
  const badge = document.getElementById('faceCountBadge');
  if (!badge) return;
  clearAllFaceRects();

  if (currentItemFaces.length === 0) {
    badge.classList.add('hidden');
    return;
  }

  badge.innerHTML = `<span class="face-count-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg></span>${currentItemFaces.length}`;
  badge.classList.remove('hidden');
  badge.classList.remove('rects-visible');
  allRectsVisible = false;

  badge.onclick = (e) => {
    e.stopPropagation();
    toggleAllFaceRects();
  };
}

function toggleAllFaceRects() {
  const badge = document.getElementById('faceCountBadge');
  if (allRectsVisible) {
    clearAllFaceRects();
    if (badge) badge.classList.remove('rects-visible');
    allRectsVisible = false;
  } else {
    drawAllFaceRects(currentItemFaces);
    if (badge) badge.classList.add('rects-visible');
    allRectsVisible = true;
  }
}

function clearAllFaceRects() {
  const container = document.getElementById('allFaceRects');
  if (container) container.innerHTML = '';
  const mainRect = document.getElementById('mainFaceRect');
  if (mainRect) mainRect.classList.add('hidden');
}

function drawAllFaceRects(faces) {
  const container = document.getElementById('allFaceRects');
  const img = document.getElementById('currentImg');
  if (!container || !img) return;
  container.innerHTML = '';

  const naturalW = img.naturalWidth;
  const naturalH = img.naturalHeight;
  if (!naturalW || !naturalH) return;

  const containerW = img.parentElement.clientWidth;
  const containerH = img.parentElement.clientHeight;
  const imageRatio = naturalW / naturalH;
  const containerRatio = containerW / containerH;

  let renderW, renderH;
  if (imageRatio > containerRatio) {
    renderW = containerW;
    renderH = containerW / imageRatio;
  } else {
    renderH = containerH;
    renderW = containerH * imageRatio;
  }

  const renderOffsetX = (containerW - renderW) / 2;
  const renderOffsetY = (containerH - renderH) / 2;

  faces.forEach(face => {
    if (face.bboxX == null || face.bboxW == null) return;

    const origW = face.origW || naturalW;
    const origH = face.origH || naturalH;
    if (origW <= 0 || origH <= 0) return;

    let bx = face.bboxX, by = face.bboxY, bw = face.bboxW, bh = face.bboxH;
    let srcW = origW, srcH = origH;
    const rot = face.userRotation || currentRotation || 0;

    if (rot === 1) {
      const nx = origH - by - bh, ny = bx;
      bx = nx; by = ny;
      const tmp = bw; bw = bh; bh = tmp;
      srcW = origH; srcH = origW;
    } else if (rot === 2) {
      bx = origW - bx - bw;
      by = origH - by - bh;
    } else if (rot === 3) {
      const nx = by, ny = origW - bx - bw;
      bx = nx; by = ny;
      const tmp = bw; bw = bh; bh = tmp;
      srcW = origH; srcH = origW;
    }

    const finalX = renderOffsetX + (bx / srcW) * renderW;
    const finalY = renderOffsetY + (by / srcH) * renderH;
    const finalW = (bw / srcW) * renderW;
    const finalH = (bh / srcH) * renderH;

    const rectEl = document.createElement('div');
    rectEl.className = 'all-face-rect';
    rectEl.style.left = finalX + 'px';
    rectEl.style.top = finalY + 'px';
    rectEl.style.width = finalW + 'px';
    rectEl.style.height = finalH + 'px';
    rectEl.style.transform = img.style.transform;

    const cx = containerW / 2;
    const cy = containerH / 2;
    rectEl.style.transformOrigin = `${cx - finalX}px ${cy - finalY}px`;

    if (face.identityName) {
      const label = document.createElement('div');
      label.className = 'all-face-rect-label';
      label.textContent = face.identityName;
      rectEl.appendChild(label);
    }

    container.appendChild(rectEl);
  });
}

function displayFaceChips(faces) {
  const container = document.getElementById('metaOverlayIdentities');
  if (!container) return;
  container.innerHTML = '';

  faces.forEach(face => {
    const hasName = face.identityName && face.identityName.trim();
    const chip = document.createElement('div');
    chip.className = hasName ? 'identity-chip' : 'identity-chip identity-chip-unknown';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'identity-chip-name';
    nameSpan.textContent = hasName ? face.identityName : '?';
    chip.appendChild(nameSpan);

    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      showMainFaceRect(face);
      if (hasName) {
        showChipActions(chip, face);
      } else {
        showChipRenameInput(chip, face, createChipPopover(chip));
      }
    });

    container.appendChild(chip);
  });
}

function createChipPopover(chip) {
  closeChipActions();
  chip.classList.add('chip-active');
  const popover = document.createElement('div');
  popover.className = 'chip-popover chip-popover-rename';
  popover.id = 'chipPopover';
  chip.appendChild(popover);
  const dismiss = (e) => {
    if (!chip.contains(e.target)) {
      closeChipActions();
      document.removeEventListener('click', dismiss, true);
    }
  };
  setTimeout(() => document.addEventListener('click', dismiss, true), 10);
  return popover;
}

function showChipActions(chip, face) {
  closeChipActions();
  chip.classList.add('chip-active');

  const popover = document.createElement('div');
  popover.className = 'chip-popover';
  popover.id = 'chipPopover';

  const renameBtn = document.createElement('button');
  renameBtn.className = 'chip-action';
  renameBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg> Rename';
  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showChipRenameInput(chip, face, popover);
  });

  const removeBtn = document.createElement('button');
  removeBtn.className = 'chip-action chip-action-danger';
  removeBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg> Remove';
  removeBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await unassignFaceOccurrence(face);
    closeChipActions();
  });

  popover.appendChild(renameBtn);
  popover.appendChild(removeBtn);
  chip.appendChild(popover);

  const dismiss = (e) => {
    if (!chip.contains(e.target)) {
      closeChipActions();
      document.removeEventListener('click', dismiss, true);
    }
  };
  setTimeout(() => document.addEventListener('click', dismiss, true), 10);
}

async function showChipRenameInput(chip, face, popover) {
  popover.innerHTML = '';
  popover.classList.add('chip-popover-rename');

  const inputRow = document.createElement('div');
  inputRow.className = 'chip-rename-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chip-rename-input';
  input.value = face.identityName || '';
  input.placeholder = 'New name…';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'chip-action chip-action-save';
  saveBtn.textContent = '✓';

  inputRow.appendChild(input);
  inputRow.appendChild(saveBtn);
  popover.appendChild(inputRow);

  input.focus();

  const doRename = async (newName) => {
    newName = (newName || input.value).trim();
    if (!newName || newName === face.identityName) { closeChipActions(); return; }
    try {
      const res = await fetch(`${base}/api/faces/occurrences/${face.id}/reassign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: newName }),
      });
      if (res.ok) {
        const nameSpan = chip.querySelector('.identity-chip-name');
        if (nameSpan) nameSpan.textContent = newName;
        face.identityName = newName;
        face.identityId = face.identityId || true;
        chip.classList.remove('identity-chip-unknown');
      }
    } catch { }
    closeChipActions();
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') doRename();
    if (e.key === 'Escape') closeChipActions();
  });
  saveBtn.addEventListener('click', (e) => { e.stopPropagation(); doRename(); });

  try {
    if (!cachedKnownIdentities) {
      const res = await fetch(`${base}/api/faces/identities`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        cachedKnownIdentities = (data.identities || []).filter(i => i.name);
      }
    }
    if (cachedKnownIdentities && cachedKnownIdentities.length > 0) {
      const suggestionsEl = document.createElement('div');
      suggestionsEl.className = 'chip-suggestions';
      cachedKnownIdentities.forEach(identity => {
        if (!identity.name) return;
        const sChip = document.createElement('button');
        sChip.type = 'button';
        sChip.className = 'face-suggestion-chip';
        sChip.textContent = identity.name;
        sChip.addEventListener('click', (e) => {
          e.stopPropagation();
          doRename(identity.name);
        });
        suggestionsEl.appendChild(sChip);
      });
      popover.appendChild(suggestionsEl);
    }
  } catch { }

  setTimeout(() => { input.focus(); input.select(); }, 50);
}

async function unassignFaceOccurrence(face) {
  try {
    await fetch(`${base}/api/faces/occurrences/${face.id}/unassign`, {
      method: 'POST',
      credentials: 'include',
    });
    const mediaPath = getCurrentMediaPath();
    if (mediaPath) checkForUnknownFaces(mediaPath);
  } catch { }
}

function closeChipActions() {
  const old = document.getElementById('chipPopover');
  if (old) old.remove();
  document.querySelectorAll('.identity-chip.chip-active').forEach(c => c.classList.remove('chip-active'));
}

function showMainFaceRect(face) {
  const rect = document.getElementById('mainFaceRect');
  const img = document.getElementById('currentImg');

  if (!face.bboxX || !rect || !img) return;
  const origW = face.origW || img.naturalWidth;
  const origH = face.origH || img.naturalHeight;
  if (origW <= 0 || origH <= 0) return;

  // The main view uses object-fit: contain.
  // We need to calculate the exact X,Y,W,H of the letterboxed image ON SCREEN,
  // before ANY CSS transforms are applied, and use that as our "tight wrapper" coordinate space.
  const naturalW = img.naturalWidth;
  const naturalH = img.naturalHeight;
  if (!naturalW || !naturalH) return;

  const containerW = img.parentElement.clientWidth;
  const containerH = img.parentElement.clientHeight;

  const imageRatio = naturalW / naturalH;
  const containerRatio = containerW / containerH;

  // Rendered physical size of the image on screen (ignoring black letterbox bars)
  let renderW, renderH;
  if (imageRatio > containerRatio) {
    // Image hits left/right edges first, top/bottom are letterboxed
    renderW = containerW;
    renderH = containerW / imageRatio;
  } else {
    // Image hits top/bottom edges first, left/right are letterboxed
    renderH = containerH;
    renderW = containerH * imageRatio;
  }

  // Physical offset from the top-left of the .media-wrap container to the actual image pixels
  const renderOffsetX = (containerW - renderW) / 2;
  const renderOffsetY = (containerH - renderH) / 2;

  // The DB coordinates and origW/origH are un-rotated coordinates!
  // BUT the naturalWidth/naturalHeight are EXIF-rotated by the browser.
  // The face.userRotation rotates it even further mathematically.
  //
  // Here is the fix: we transform the bounding box to match the current visual orientation FIRST,
  // treating it exactly like the Who Is This prompt does!

  // const origW = face.origW || naturalW; // Already defined above
  // const origH = face.origH || naturalH; // Already defined above
  // if (origW <= 0 || origH <= 0) return; // Already checked above

  // Transform bbox for user rotation (0–3, each = 90° CW)
  // This expects the bbox to start relative to origW/origH, and outputs coordinates relative to srcW/srcH
  let bx = face.bboxX, by = face.bboxY, bw = face.bboxW, bh = face.bboxH;
  let srcW = origW, srcH = origH;
  const rot = face.userRotation || currentRotation || 0;

  if (rot === 1) {
    const nx = origH - by - bh, ny = bx;
    bx = nx; by = ny;
    const tmp = bw; bw = bh; bh = tmp;
    srcW = origH; srcH = origW;
  } else if (rot === 2) {
    bx = origW - bx - bw;
    by = origH - by - bh;
  } else if (rot === 3) {
    const nx = by, ny = origW - bx - bw;
    bx = nx; by = ny;
    const tmp = bw; bw = bh; bh = tmp;
    srcW = origH; srcH = origW;
  }

  // Now, (bx, by, bw, bh) are coordinates inside an image of size (srcW x srcH)
  // that matches the exact visual orientation of the image currently rendered on screen!

  // So we map them directly onto our calculated rendered bounds (renderW x renderH)
  const finalX = renderOffsetX + (bx / srcW) * renderW;
  const finalY = renderOffsetY + (by / srcH) * renderH;
  const finalW = (bw / srcW) * renderW;
  const finalH = (bh / srcH) * renderH;

  // Apply to rectangle natively
  rect.style.left = finalX + 'px';
  rect.style.top = finalY + 'px';
  rect.style.width = finalW + 'px';
  rect.style.height = finalH + 'px';

  // Apply the EXACT same CSS transform as the image, centering the rotation on the wrapper midpoint.
  // BUT WAIT! Because our finalX/finalY are already mapped to the visual representation AFTER userRotation,
  // we do NOT need to spin the rectangle anymore, except for whatever raw CSS transform is physically on
  // the `<img>` tag right now (which actually INCLUDES the scale logic and the CSS rotation).
  //
  // Actually, wait: the `<img>` tag has `transform: rotate(Ndeg) scale(X)` applied.
  // `img.naturalWidth/Height` do NOT include that transform – they are just the EXIF-rotated image dimensions.
  // So our `renderW` and `renderH` are the bounds BEFORE the CSS transform.
  // Therefore, mapping to `finalX/Y` puts the rectangle in the correct pre-transform spot.
  // Then we copy the CSS transform onto the rectangle so it spins and scales exactly like the image does!
  rect.style.transform = img.style.transform;

  // To rotate around the identical axis as the image, we must set transformOrigin to the center
  // of the full-screen container relative to the rectangle's top-left corner.
  const cx = containerW / 2;
  const cy = containerH / 2;
  const originX = cx - finalX;
  const originY = cy - finalY;
  rect.style.transformOrigin = `${originX}px ${originY}px`;

  rect.classList.remove('hidden');

  if (mainRectHideTimeout) clearTimeout(mainRectHideTimeout);
  mainRectHideTimeout = setTimeout(() => {
    rect.classList.add('hidden');
  }, 2500);
}

async function updateFaceScanBadge(mediaPath) {
  const badge = document.getElementById('faceScanBadge');
  if (!badge) return;
  try {
    const res = await fetch(`${base}/api/faces/check?path=${encodeURIComponent(mediaPath)}`, { credentials: 'include' });
    if (!res.ok) { badge.classList.add('hidden'); return; }
    const data = await res.json();
    if (data.scanned) {
      badge.textContent = '🔄';
      badge.title = 'Face scanned. Click to rescan.';
      badge.classList.remove('hidden');
    } else {
      badge.textContent = '🚫';
      badge.title = 'Not face-scanned. Click for options.';
      badge.classList.remove('hidden');
    }

    badge.onclick = async (e) => {
      e.stopPropagation();
      showFaceSettingsPopover(badge, mediaPath);
    };
  } catch {
    badge.classList.add('hidden');
  }
}

async function rescanCurrentItem(badge, mediaPath) {
  badge.textContent = '⏳';
  closeFaceSettingsPopover();
  try {
    const scanRes = await fetch(`${base}/api/faces/scan-item`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ path: mediaPath }),
    });
    if (scanRes.ok) {
      updateFaceScanBadge(mediaPath);
      checkForUnknownFaces(mediaPath);
    } else {
      badge.textContent = '❌';
      setTimeout(() => updateFaceScanBadge(mediaPath), 2000);
    }
  } catch {
    badge.textContent = '❌';
    setTimeout(() => updateFaceScanBadge(mediaPath), 2000);
  }
}

let _faceSettingsDismissHandler = null;
function closeFaceSettingsPopover() {
  const old = document.getElementById('faceSettingsPopover');
  if (old) old.remove();
  if (_faceSettingsDismissHandler) {
    document.removeEventListener('click', _faceSettingsDismissHandler, true);
    _faceSettingsDismissHandler = null;
  }
}

async function showFaceSettingsPopover(badge, mediaPath) {
  closeFaceSettingsPopover();

  let current = { distanceThreshold: 0.45, minConfidence: 0.5, inputSize: 512 };
  try {
    const url = mediaPath
      ? `${base}/api/faces/settings?path=${encodeURIComponent(mediaPath)}`
      : `${base}/api/faces/settings`;
    const res = await fetch(url, { credentials: 'include' });
    if (res.ok) current = await res.json();
  } catch { }

  const popover = document.createElement('div');
  popover.className = 'face-settings-popover';
  popover.id = 'faceSettingsPopover';

  const title = document.createElement('div');
  title.className = 'face-settings-title';
  title.textContent = 'Face Detection';
  popover.appendChild(title);

  const sliders = [
    { key: 'minConfidence', label: 'Detection confidence', min: 0.1, max: 0.95, step: 0.05, val: current.minConfidence,
      desc: 'Lower = detect more faces (may include false positives)' },
    { key: 'inputSize', label: 'Input resolution', min: 256, max: 2048, step: 64, val: current.inputSize,
      desc: 'Higher = detect smaller faces (slower, more memory)' },
    { key: 'distanceThreshold', label: 'Match threshold', min: 0.15, max: 0.7, step: 0.05, val: current.distanceThreshold,
      desc: 'Lower = stricter matching (fewer auto-merges)' },
  ];

  const pending = {};

  sliders.forEach(s => {
    const row = document.createElement('div');
    row.className = 'face-settings-row';

    const labelRow = document.createElement('div');
    labelRow.className = 'face-settings-label-row';
    const lbl = document.createElement('span');
    lbl.className = 'face-settings-label';
    lbl.textContent = s.label;
    const valSpan = document.createElement('span');
    valSpan.className = 'face-settings-value';
    valSpan.textContent = s.key === 'inputSize' ? `${s.val}px` : s.val.toFixed(2);
    labelRow.appendChild(lbl);
    labelRow.appendChild(valSpan);

    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'face-settings-slider';
    input.min = s.min;
    input.max = s.max;
    input.step = s.step;
    input.value = s.val;
    input.addEventListener('input', () => {
      const v = Number(input.value);
      valSpan.textContent = s.key === 'inputSize' ? `${v}px` : v.toFixed(2);
      pending[s.key] = v;
    });

    const desc = document.createElement('div');
    desc.className = 'face-settings-desc';
    desc.textContent = s.desc;

    row.appendChild(labelRow);
    row.appendChild(input);
    row.appendChild(desc);
    popover.appendChild(row);
  });

  const actions = document.createElement('div');
  actions.className = 'face-settings-actions';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'pill-btn primary face-settings-btn';
  saveBtn.textContent = 'Save & Rescan';
  saveBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (Object.keys(pending).length > 0) {
      try {
        await fetch(`${base}/api/faces/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(pending),
        });
      } catch { }
    }
    rescanCurrentItem(badge, mediaPath);
  });

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'pill-btn secondary face-settings-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeFaceSettingsPopover();
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  popover.appendChild(actions);

  document.body.appendChild(popover);
  const badgeRect = badge.getBoundingClientRect();
  popover.style.position = 'fixed';
  popover.style.left = `${badgeRect.left}px`;
  popover.style.bottom = `${window.innerHeight - badgeRect.top + 8}px`;

  _faceSettingsDismissHandler = (e) => {
    if (!popover.contains(e.target) && e.target !== badge) {
      closeFaceSettingsPopover();
    }
  };
  setTimeout(() => document.addEventListener('click', _faceSettingsDismissHandler, true), 10);
}

function getMediaThumbUrl(mediaPath) {
  return `${base}/api/media?path=${encodeURIComponent(mediaPath)}`;
}

async function showNextFacePrompt() {
  if (facePromptQueue.length === 0) {
    facePromptActive = false;
    return;
  }
  facePromptActive = true;
  const face = facePromptQueue[0];
  const overlay = document.getElementById('facePromptOverlay');
  const img = document.getElementById('facePromptImg');
  const rect = document.getElementById('facePromptRect');
  const cropContainer = document.getElementById('facePromptCropContainer');
  const cropImg = document.getElementById('facePromptCropImg');
  const nameInput = document.getElementById('facePromptName');
  const suggestionsEl = document.getElementById('facePromptSuggestions');

  // Show the full image
  const mediaSrc = getMediaThumbUrl(face.itemPath || getCurrentMediaPath());
  img.src = mediaSrc;
  img.dataset.occurrenceId = face.id;

  // Position the face rectangle using percentage-based coords.
  // Since the image fills at width:100% height:auto, the container
  // tightly wraps the rendered image — just use origW/origH percentages.
  const positionRect = () => {
    if (face.bboxX == null || face.bboxW == null) {
      rect.classList.add('hidden');
      return;
    }

    // Original dimensions the bbox was defined in
    const origW = face.origW || img.naturalWidth;
    const origH = face.origH || img.naturalHeight;
    if (origW <= 0 || origH <= 0) { rect.classList.add('hidden'); return; }

    // Transform bbox for user rotation (0–3, each = 90° CW)
    let bx = face.bboxX, by = face.bboxY, bw = face.bboxW, bh = face.bboxH;
    let srcW = origW, srcH = origH;
    const rot = face.userRotation || 0;
    if (rot === 1) {
      const nx = origH - by - bh, ny = bx;
      bx = nx; by = ny;
      const tmp = bw; bw = bh; bh = tmp;
      srcW = origH; srcH = origW;
    } else if (rot === 2) {
      bx = origW - bx - bw;
      by = origH - by - bh;
    } else if (rot === 3) {
      const nx = by, ny = origW - bx - bw;
      bx = nx; by = ny;
      const tmp = bw; bw = bh; bh = tmp;
      srcW = origH; srcH = origW;
    }

    // Simple percentage positioning — works because the image fills width:100%
    rect.style.left = (bx / srcW * 100) + '%';
    rect.style.top = (by / srcH * 100) + '%';
    rect.style.width = (bw / srcW * 100) + '%';
    rect.style.height = (bh / srcH * 100) + '%';

    rect.classList.remove('hidden');
  };
  if (img.complete && img.naturalWidth > 0) {
    positionRect();
  } else {
    img.onload = positionRect;
  }

  // Show the face crop thumbnail by hitting the dynamic crop endpoint
  cropImg.src = `${base}/api/faces/crop/${face.id}`;
  cropContainer.classList.remove('hidden');

  nameInput.value = '';
  suggestionsEl.innerHTML = '';

  // Load existing identity names as suggestions
  try {
    if (!cachedKnownIdentities) {
      const res = await fetch(`${base}/api/faces/identities`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        cachedKnownIdentities = (data.identities || []).filter(i => i.name);
      }
    }
    if (cachedKnownIdentities && cachedKnownIdentities.length > 0) {
      cachedKnownIdentities.forEach(identity => {
        if (!identity.name) return;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'face-suggestion-chip';
        chip.textContent = identity.name;
        chip.addEventListener('click', () => {
          nameInput.value = identity.name;
        });
        suggestionsEl.appendChild(chip);
      });
    }
  } catch { }

  overlay.classList.remove('hidden');
}

function closeFacePrompt() {
  document.getElementById('facePromptOverlay').classList.add('hidden');
  document.getElementById('facePromptRect').classList.add('hidden');
  facePromptActive = false;
  facePromptQueue = [];
  // Refresh chips to reflect any names that were just assigned
  const mediaPath = getCurrentMediaPath();
  if (mediaPath) {
    fetch(`${base}/api/faces/item?path=${encodeURIComponent(mediaPath)}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) displayFaceChips(data.faces || []); })
      .catch(() => {});
  }
}

async function saveFacePrompt() {
  const nameInput = document.getElementById('facePromptName');
  const img = document.getElementById('facePromptImg');
  const name = nameInput.value.trim();
  const occurrenceId = img.dataset.occurrenceId;
  if (!name || !occurrenceId) return;

  try {
    const res = await fetch(`${base}/api/faces/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ occurrenceId, name }),
    });
    const data = await res.json();
    if (data.ok) {
      cachedKnownIdentities = null;
    }
  } catch { }

  facePromptQueue.shift();
  if (facePromptQueue.length > 0) {
    showNextFacePrompt();
  } else {
    closeFacePrompt();
  }
}

function skipFacePrompt() {
  if (facePromptQueue.length > 0) {
    facePromptSkippedOccurrences.add(facePromptQueue[0].id);
    facePromptQueue.shift();
  }
  if (facePromptQueue.length > 0) {
    showNextFacePrompt();
  } else {
    closeFacePrompt();
  }
}

// ---- Init ----

async function init() {
  const { token, albumId: aid } = getParams();

  const undoBtn = document.getElementById('undoBtn');
  if (undoBtn) undoBtn.addEventListener('click', doUndo);

  const shareBtn = document.getElementById('shareBtn');
  if (shareBtn) shareBtn.addEventListener('click', doShare);

  const rotateBtn = document.getElementById('rotateBtn');
  if (rotateBtn) rotateBtn.addEventListener('click', doRotate);

  const revealBtn = document.getElementById('revealBtn');
  if (revealBtn) revealBtn.addEventListener('click', doReveal);
  const openBtn = document.getElementById('openBtn');
  if (openBtn) openBtn.addEventListener('click', doOpen);

  const filterBtn = document.getElementById('filterBtn');
  if (filterBtn) filterBtn.addEventListener('click', openFilterOverlay);
  const closeFilterBtn = document.getElementById('closeFilter');
  if (closeFilterBtn) closeFilterBtn.addEventListener('click', closeFilterOverlay);
  const filterBackdrop = document.getElementById('filterBackdrop');
  if (filterBackdrop) filterBackdrop.addEventListener('click', closeFilterOverlay);
  const filterApplyBtn = document.getElementById('filterApply');
  if (filterApplyBtn) filterApplyBtn.addEventListener('click', applyFilterAndReload);
  const filterClearBtn = document.getElementById('filterClear');
  if (filterClearBtn) filterClearBtn.addEventListener('click', clearFilterAndReload);

  const explorerBtn = document.getElementById('albumExplorerBtn');
  if (explorerBtn) explorerBtn.addEventListener('click', openAlbumExplorer);
  const closeBtn = document.getElementById('closeExplorer');
  if (closeBtn) closeBtn.addEventListener('click', closeAlbumExplorer);
  const backdrop = document.getElementById('explorerBackdrop');
  if (backdrop) backdrop.addEventListener('click', closeAlbumExplorer);

  // Identity manager overlay listeners
  const idManagerBtn = document.getElementById('identityManagerBtn');
  if (idManagerBtn) idManagerBtn.addEventListener('click', openIdentityManager);
  const closeIdManagerBtn = document.getElementById('closeIdentityManager');
  if (closeIdManagerBtn) closeIdManagerBtn.addEventListener('click', closeIdentityManager);
  const idManagerBackdropEl = document.getElementById('identityManagerBackdrop');
  if (idManagerBackdropEl) idManagerBackdropEl.addEventListener('click', closeIdentityManager);

  // Help dropdown
  const helpBtn = document.getElementById('helpBtn');
  const helpDropdown = document.getElementById('helpDropdown');
  if (helpBtn && helpDropdown) {
    helpBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      helpDropdown.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!helpDropdown.contains(e.target) && e.target !== helpBtn) {
        helpDropdown.classList.add('hidden');
      }
    });
  }

  // Face prompt listeners
  const facePromptSaveBtn = document.getElementById('facePromptSave');
  if (facePromptSaveBtn) facePromptSaveBtn.addEventListener('click', saveFacePrompt);
  const facePromptSkipBtn = document.getElementById('facePromptSkip');
  if (facePromptSkipBtn) facePromptSkipBtn.addEventListener('click', skipFacePrompt);
  const facePromptCloseBtn = document.getElementById('facePromptClose');
  if (facePromptCloseBtn) facePromptCloseBtn.addEventListener('click', closeFacePrompt);
  const facePromptBackdropEl = document.getElementById('facePromptBackdrop');
  if (facePromptBackdropEl) facePromptBackdropEl.addEventListener('click', closeFacePrompt);

  const muteBtn = document.getElementById('mutePromptsBtn');
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      facePromptsMuted = !facePromptsMuted;
      muteBtn.classList.toggle('active', facePromptsMuted);
      const icon = document.getElementById('mutePromptsIcon');
      if (facePromptsMuted) {
        icon.innerHTML = '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" y1="11" x2="23" y2="17"/><line x1="23" y1="11" x2="17" y2="17"/>';
        closeFacePrompt();
      } else {
        icon.innerHTML = '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="23" y1="13" x2="17" y2="13"/>';
      }
    });
  }

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
