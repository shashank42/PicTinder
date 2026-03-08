const portEl = document.getElementById('port');
const addFolderBtn = document.getElementById('addFolder');
const folderListEl = document.getElementById('folderList');
const serverToggleBtn = document.getElementById('serverToggle');
const serverPanel = document.getElementById('serverPanel');
const serverUrlEl = document.getElementById('serverUrl');
const joinQrEl = document.getElementById('joinQr');
const devicesSection = document.getElementById('devicesSection');
const devicesCountEl = document.getElementById('devicesCount');
const devicesListEl = document.getElementById('devicesList');
const albumsSection = document.getElementById('albumsSection');
const albumsCountEl = document.getElementById('albumsCount');
const albumsListEl = document.getElementById('albumsList');
const logEl = document.getElementById('log');

let serverRunning = false;
let folders = [];
let wsConn = null;
let serverPort = null;

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function addLog(message) {
  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `<span class="time">${time}</span>${escapeHtml(message)}`;
  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

// ---- Folders ----

function renderFolders() {
  folderListEl.innerHTML = '';
  if (folders.length === 0) {
    folderListEl.innerHTML = '<div class="folder-empty">No folders added yet.</div>';
  } else {
    folders.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'folder-row';
      row.innerHTML = `<span class="folder-path" title="${escapeHtml(f)}">${escapeHtml(f)}</span>`;
      const btn = document.createElement('button');
      btn.className = 'folder-remove';
      btn.textContent = '\u00d7';
      btn.title = 'Remove';
      btn.onclick = async () => {
        const result = await window.pictinder.removeFolder(f);
        if (result) folders = result.folders;
        renderFolders();
      };
      row.appendChild(btn);
      folderListEl.appendChild(row);
    });
  }
}

// ---- Devices ----

function renderDevices(list) {
  devicesListEl.innerHTML = '';
  const online = list.filter((d) => d.online);
  devicesCountEl.textContent = online.length;
  if (list.length === 0) {
    devicesListEl.innerHTML = '<div class="empty-panel">No devices yet</div>';
  } else {
    list.forEach((d) => {
      const card = document.createElement('div');
      card.className = `device-card ${d.online ? '' : 'offline'}`;
      const status = d.online ? (d.currentAlbumId ? 'In album' : 'Connected') : 'Offline';
      card.innerHTML = `<span class="device-dot ${d.online ? 'on' : 'off'}"></span><span class="device-label">${escapeHtml(d.label)}</span><span class="device-album">${status}</span>`;
      devicesListEl.appendChild(card);
    });
  }
}

// ---- Albums ----

async function deleteAlbum(album) {
  const confirmed = confirm(`Delete album "${album.name}"?\n\n${album.totalItems || 0} items · ${album.swipedCount || 0} swiped\n\nThis removes all swipe data for this album. No files on disk are deleted.`);
  if (!confirmed) return;
  try {
    const res = await fetch(`http://localhost:${serverPort}/api/albums/${album.id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Failed');
    addLog(`Deleted album: ${album.name}`);
    const listRes = await fetch(`http://localhost:${serverPort}/api/albums`);
    const data = await listRes.json();
    renderAlbums(data.albums || []);
  } catch {
    addLog(`Error deleting album: ${album.name}`);
  }
}

function renderAlbums(list) {
  albumsListEl.innerHTML = '';
  albumsCountEl.textContent = list.length;
  if (list.length === 0) {
    albumsListEl.innerHTML = '<div class="empty-panel">No albums yet</div>';
  } else {
    list.forEach((a) => {
      const card = document.createElement('div');
      card.className = 'album-card clickable';
      const modeLabel = a.mode === 'distributed' ? 'Dist' : 'Shared';
      card.innerHTML =
        `<div class="album-card-main">
          <span class="album-name" title="${escapeHtml(a.name)}">${escapeHtml(a.name)}</span>
          <span class="album-mode-badge">${modeLabel}</span>
          <span class="album-progress">${a.swipedCount || 0} / ${a.totalItems || 0}</span>
        </div>
        <button type="button" class="album-delete-btn" title="Delete album">Delete</button>`;
      const main = card.querySelector('.album-card-main');
      const deleteBtn = card.querySelector('.album-delete-btn');
      main.addEventListener('click', () => window.pictinder.openAlbumDetail(a.id));
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteAlbum(a);
      });
      albumsListEl.appendChild(card);
    });
  }
}

// ---- Cache ----

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function refreshCacheStats() {
  if (!serverPort) return;
  try {
    const res = await fetch(`http://localhost:${serverPort}/api/cache/stats`);
    const data = await res.json();
    document.getElementById('cacheSize').textContent = formatBytes(data.total);
    const parts = [];
    if (data.previews > 0) parts.push(`Images: ${formatBytes(data.previews)}`);
    if (data.thumbs > 0) parts.push(`Thumbs: ${formatBytes(data.thumbs)}`);
    if (data.transcoded > 0) parts.push(`Video: ${formatBytes(data.transcoded)}`);
    document.getElementById('cacheDetail').textContent = parts.join(' · ') || 'Empty';
  } catch {}
}

async function clearCache() {
  if (!serverPort) return;
  const confirmed = confirm('Clear all cached previews, thumbnails, and transcoded videos?\n\nThey will be re-generated on demand.');
  if (!confirmed) return;
  try {
    await fetch(`http://localhost:${serverPort}/api/cache/clear`, { method: 'POST' });
    addLog('Cache cleared');
    refreshCacheStats();
  } catch {
    addLog('Error clearing cache');
  }
}

// ---- Join QR ----

function renderJoinUrl(joinUrl, qrDataUrl) {
  if (qrDataUrl) {
    joinQrEl.innerHTML = '';
    const img = document.createElement('img');
    img.src = qrDataUrl;
    img.alt = 'Join QR';
    joinQrEl.appendChild(img);
  }
}

// ---- WebSocket ----

function connectWs(port) {
  if (wsConn) { wsConn.close(); wsConn = null; }
  try {
    wsConn = new WebSocket(`ws://localhost:${port}`);
  } catch { return; }

  wsConn.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      switch (data.type) {
        case 'init':
          renderDevices(data.devices || []);
          renderAlbums(data.albums || []);
          renderJoinUrl(data.joinUrl, data.qrDataUrl);
          if (data.joinUrl) serverUrlEl.textContent = data.joinUrl.split('/phone')[0];
          break;
        case 'devices':
          renderDevices(data.devices || []);
          break;
        case 'albums':
          renderAlbums(data.albums || []);
          break;
        case 'join-url':
          renderJoinUrl(data.joinUrl, data.qrDataUrl);
          break;
      }
    } catch {}
  };

  wsConn.onclose = () => {
    if (serverRunning) setTimeout(() => connectWs(port), 2000);
  };

  wsConn.onerror = () => {};
}

function disconnectWs() {
  if (wsConn) { wsConn.close(); wsConn = null; }
}

// ---- Server toggle ----

function updateServerButton() {
  serverToggleBtn.disabled = false;
  if (serverRunning) {
    serverToggleBtn.textContent = 'Stop server';
    serverToggleBtn.classList.add('running');
  } else {
    serverToggleBtn.textContent = 'Start server';
    serverToggleBtn.classList.remove('running');
  }
}

function showServerUI() {
  serverPanel.classList.remove('hidden');
  devicesSection.classList.remove('hidden');
  albumsSection.classList.remove('hidden');
  document.getElementById('cacheSection').classList.remove('hidden');
  refreshCacheStats();
}

function hideServerUI() {
  disconnectWs();
  serverPanel.classList.add('hidden');
  devicesSection.classList.add('hidden');
  albumsSection.classList.add('hidden');
  document.getElementById('cacheSection').classList.add('hidden');
  serverUrlEl.textContent = '';
  joinQrEl.innerHTML = '';
  devicesListEl.innerHTML = '';
  albumsListEl.innerHTML = '';
}

async function toggleServer() {
  const port = parseInt(portEl.value, 10) || 3847;
  await window.pictinder.savePort(port);

  if (serverRunning) {
    hideServerUI();
    await window.pictinder.stopServer();
    serverRunning = false;
    serverPort = null;
    updateServerButton();
    return;
  }

  const result = await window.pictinder.startServer({ port });
  if (result.error) {
    addLog(`Error: ${result.error}`);
    return;
  }
  serverRunning = true;
  serverPort = port;
  serverUrlEl.textContent = result.url;
  showServerUI();
  connectWs(port);
  updateServerButton();
}

// ---- Init ----

async function loadConfig() {
  const c = await window.pictinder.getInitialConfig();
  folders = c.folders || [];
  portEl.value = c.port || 3847;
  renderFolders();
  updateServerButton();
}

portEl.addEventListener('change', () => {
  window.pictinder.savePort(parseInt(portEl.value, 10) || 3847);
});

addFolderBtn.addEventListener('click', async () => {
  const result = await window.pictinder.addFolder();
  if (result) {
    folders = result.folders;
    renderFolders();
  }
});

serverToggleBtn.addEventListener('click', toggleServer);
document.getElementById('clearCache').addEventListener('click', clearCache);
window.pictinder.onServerLog(addLog);
loadConfig();
