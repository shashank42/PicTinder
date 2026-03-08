const BROWSER_IMG_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp',
  '.nef', '.arw', '.sr2', '.srf', '.cr2', '.cr3',
  '.dng', '.raf', '.raw', '.orf', '.rw2', '.pef', '.heic', '.heif',
]);
const BROWSER_VID_EXT = new Set(['.mp4', '.webm', '.mov']);
const PAGE_SIZE = 200;
const LONG_PRESS_MS = 500;

let albumData = null;
let currentFilter = 'all';
let currentOffset = 0;
let totalFiltered = 0;
let counts = { all: 0, selected: 0, discarded: 0, unswiped: 0 };
let loading = false;
let hasMore = false;
let selectedItem = null;
let actionSheetItem = null;
let reclassifyHistory = [];
let deviceMap = {};
let isSharedMode = false;

const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

const gridEl = document.getElementById('grid');
const scrollArea = document.getElementById('scrollArea');
const sentinelEl = document.getElementById('sentinel');
const emptyMsgEl = document.getElementById('emptyMsg');
const renderedElements = new Map();

function getAlbumId() {
  return new URLSearchParams(window.location.search).get('albumId');
}

function getExt(p) {
  const idx = p.lastIndexOf('.');
  return idx >= 0 ? p.substring(idx).toLowerCase() : '';
}

function canDisplayAsImage(p) { return BROWSER_IMG_EXT.has(getExt(p)); }
function canDisplayAsVideo(p) { return BROWSER_VID_EXT.has(getExt(p)); }
function getMediaUrl(p) { return `/api/media?path=${encodeURIComponent(p)}`; }
function getThumbUrl(p) { return `/api/media?path=${encodeURIComponent(p)}&thumb=1`; }

async function fetchMediaMeta(mediaPath) {
  try {
    const res = await fetch(`/api/media/meta?path=${encodeURIComponent(mediaPath)}`, { credentials: 'include' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function pathFilename(p) {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}
function pathDir(p) {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(0, idx + 1) : '';
}

function setDetailMetaOverlays(meta, mediaPath) {
  const pathEl = document.getElementById('detailMetaOverlayPath');
  const filenameEl = document.getElementById('detailMetaOverlayFilename');
  const left = document.getElementById('detailMetaOverlayLeft');
  const right = document.getElementById('detailMetaOverlayRight');
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

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ---- Paginated data loading ----

async function fetchPage(filter, offset) {
  const albumId = getAlbumId();
  const url = `/api/albums/${albumId}/items?filter=${encodeURIComponent(filter)}&offset=${offset}&limit=${PAGE_SIZE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to load album');
  return await res.json();
}

async function loadNextPage() {
  if (loading || !hasMore) return;
  loading = true;
  try {
    const data = await fetchPage(currentFilter, currentOffset);
    if (data.album && !albumData) albumData = data.album;
    if (data.devices) {
      for (const d of data.devices) deviceMap[d.id] = d.short;
    }
    const fragment = document.createDocumentFragment();
    for (const item of data.items) {
      fragment.appendChild(createGridItem(item));
    }
    gridEl.appendChild(fragment);
    currentOffset += data.items.length;
    totalFiltered = data.total;
    hasMore = data.hasMore;
    counts = data.counts;
    renderCounts();
  } catch {
    // Silently fail — user can scroll again to retry
  } finally {
    loading = false;
  }
}

// ---- Grid rendering ----

function createGridItem(item) {
  const div = document.createElement('div');
  div.className = `grid-item ${item.status}`;

  if (canDisplayAsImage(item.path)) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = getMediaUrl(item.path);
    img.alt = item.filename;
    div.appendChild(img);
  } else if (canDisplayAsVideo(item.path)) {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = getThumbUrl(item.path);
    img.alt = item.filename;
    div.appendChild(img);
    const playIcon = document.createElement('div');
    playIcon.className = 'video-play-icon';
    playIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="white" opacity="0.85"><polygon points="6 3 20 12 6 21"/></svg>';
    div.appendChild(playIcon);
  } else {
    div.innerHTML =
      `<div class="placeholder-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="20" rx="3"/><circle cx="8.5" cy="8.5" r="2"/><path d="M21 15l-5-5L5 21"/></svg></div>` +
      `<div class="placeholder-label">${escapeHtml(item.filename)}</div>`;
  }

  if (item.votes && item.votes.length > 0) {
    const votesWrap = document.createElement('div');
    votesWrap.className = 'votes-wrap';
    for (const v of item.votes) {
      const chip = document.createElement('span');
      chip.className = `vote-chip ${v.direction === 'right' ? 'vote-yes' : 'vote-no'}`;
      const label = deviceMap[v.deviceId] || v.deviceId.slice(0, 4);
      chip.textContent = `${v.direction === 'right' ? '✓' : '✗'} ${label}`;
      chip.title = `${deviceMap[v.deviceId] || v.deviceId}: ${v.direction === 'right' ? 'Selected' : 'Discarded'}`;
      votesWrap.appendChild(chip);
    }
    div.appendChild(votesWrap);
  } else {
    const badge = document.createElement('div');
    badge.className = 'status-badge';
    badge.textContent = item.status === 'selected' ? '✓' : item.status === 'discarded' ? '✗' : '?';
    div.appendChild(badge);
  }

  if (isTouchDevice) {
    div.addEventListener('click', () => openItemDetail(item));
  }
  attachGridInteractions(div, item);
  renderedElements.set(item.path, div);
  return div;
}

// ---- Filters ----

async function applyFilter(filter) {
  currentFilter = filter;
  currentOffset = 0;
  totalFiltered = 0;
  hasMore = true;
  gridEl.innerHTML = '';
  renderedElements.clear();

  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });

  emptyMsgEl.classList.add('hidden');
  scrollArea.classList.remove('hidden');
  await loadNextPage();

  if (currentOffset === 0 && !hasMore) {
    emptyMsgEl.classList.remove('hidden');
    scrollArea.classList.add('hidden');
  }
}

function renderCounts() {
  document.getElementById('countAll').textContent = counts.all || 0;
  document.getElementById('countSelected').textContent = counts.selected || 0;
  document.getElementById('countDiscarded').textContent = counts.discarded || 0;
  document.getElementById('countUnswiped').textContent = counts.unswiped || 0;
  document.getElementById('statsText').textContent =
    `${counts.all || 0} items · ${counts.selected || 0} selected · ${counts.discarded || 0} discarded`;
}

// ---- Infinite scroll via IntersectionObserver ----

let observer = null;

function setupObserver() {
  observer = new IntersectionObserver(
    (entries) => {
      if (entries[0].isIntersecting && hasMore && !loading) {
        loadNextPage();
      }
    },
    { root: scrollArea, rootMargin: '400px' },
  );
  observer.observe(sentinelEl);
}

// ---- Item detail overlay ----

function openItemDetail(item) {
  selectedItem = item;
  const overlay = document.getElementById('itemOverlay');
  const img = document.getElementById('previewImg');
  const video = document.getElementById('previewVideo');
  const placeholder = document.getElementById('previewPlaceholder');

  img.classList.add('hidden');
  video.classList.add('hidden');
  placeholder.classList.add('hidden');
  img.src = '';
  video.src = '';
  video.pause();

  if (canDisplayAsImage(item.path)) {
    img.classList.remove('hidden');
    img.src = getMediaUrl(item.path);
  } else if (canDisplayAsVideo(item.path)) {
    video.classList.remove('hidden');
    video.src = getMediaUrl(item.path);
    video.play().catch(() => {});
  } else {
    placeholder.classList.remove('hidden');
    document.getElementById('placeholderName').textContent = item.filename;
  }

  document.getElementById('detailFilename').textContent = item.filename;
  setDetailMetaOverlays(null, item.path);
  fetchMediaMeta(item.path).then((meta) => setDetailMetaOverlays(meta, item.path));
  refreshOverlayStatus();
  overlay.classList.remove('hidden');
}

function refreshOverlayStatus() {
  if (!selectedItem) return;
  const s = selectedItem.status;
  const statusEl = document.getElementById('detailStatus');
  const labels = { selected: '✓ Selected', discarded: '✗ Discarded', unswiped: '? Not yet swiped' };
  const colors = { selected: '#34c759', discarded: '#ff3b30', unswiped: '#888' };

  if (selectedItem.votes && selectedItem.votes.length > 0) {
    statusEl.innerHTML = '';
    for (const v of selectedItem.votes) {
      const label = deviceMap[v.deviceId] || v.deviceId.slice(0, 6);
      const icon = v.direction === 'right' ? '✓' : '✗';
      const color = v.direction === 'right' ? '#34c759' : '#ff3b30';
      statusEl.innerHTML += `<span class="vote-detail" style="color:${color}">${icon} ${label}</span> `;
    }
  } else {
    statusEl.textContent = labels[s] || s;
    statusEl.style.color = colors[s] || '#888';
  }

  document.getElementById('btnSelect').classList.toggle('active', s === 'selected');
  document.getElementById('btnDiscard').classList.toggle('active', s === 'discarded');
}

function closeItemDetail() {
  document.getElementById('itemOverlay').classList.add('hidden');
  const video = document.getElementById('previewVideo');
  video.pause();
  video.src = '';
  selectedItem = null;
}

async function reclassify(newStatus) {
  if (!selectedItem) return;
  const oldStatus = selectedItem.status;
  if (oldStatus === newStatus) return;
  const albumId = getAlbumId();
  try {
    const res = await fetch(`/api/albums/${albumId}/reclassify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: selectedItem.path, status: newStatus }),
    });
    if (!res.ok) throw new Error('Failed');
  } catch {
    return;
  }

  reclassifyHistory.push({ path: selectedItem.path, oldStatus, newStatus });
  updateUndoBtn();

  selectedItem.status = newStatus;

  // Optimistic count update
  if (counts[oldStatus] > 0) counts[oldStatus]--;
  counts[newStatus] = (counts[newStatus] || 0) + 1;
  renderCounts();

  // Update the grid element visually
  const el = renderedElements.get(selectedItem.path);
  if (el) {
    el.className = `grid-item ${newStatus}`;
    const votesWrap = el.querySelector('.votes-wrap');
    if (votesWrap) votesWrap.remove();
    let badge = el.querySelector('.status-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'status-badge';
      el.appendChild(badge);
    }
    badge.textContent = newStatus === 'selected' ? '✓' : newStatus === 'discarded' ? '✗' : '?';
  }

  selectedItem.votes = [];
  refreshOverlayStatus();

  // If current filter no longer matches, remove from the visible grid
  if (currentFilter !== 'all' && currentFilter !== newStatus) {
    if (el) el.remove();
    renderedElements.delete(selectedItem.path);
    totalFiltered--;
    currentOffset = Math.max(0, currentOffset - 1);
    if (gridEl.children.length === 0 && !hasMore) {
      emptyMsgEl.classList.remove('hidden');
      scrollArea.classList.add('hidden');
    } else if (hasMore) {
      loadNextPage();
    }
  }
}

// ---- Undo ----

function updateUndoBtn() {
  const btn = document.getElementById('undoBtn');
  if (btn) btn.classList.toggle('hidden', reclassifyHistory.length === 0);
}

async function doUndo() {
  if (reclassifyHistory.length === 0) return;
  const last = reclassifyHistory.pop();
  updateUndoBtn();

  const albumId = getAlbumId();
  try {
    const res = await fetch(`/api/albums/${albumId}/reclassify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: last.path, status: last.oldStatus }),
    });
    if (!res.ok) throw new Error('Failed');
  } catch { return; }

  if (counts[last.newStatus] > 0) counts[last.newStatus]--;
  counts[last.oldStatus] = (counts[last.oldStatus] || 0) + 1;
  renderCounts();

  const el = renderedElements.get(last.path);
  if (el) {
    el.className = `grid-item ${last.oldStatus}`;
    let badge = el.querySelector('.status-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'status-badge';
      el.appendChild(badge);
    }
    badge.textContent = last.oldStatus === 'selected' ? '✓' : last.oldStatus === 'discarded' ? '✗' : '?';
  }

  if (selectedItem && selectedItem.path === last.path) {
    selectedItem.status = last.oldStatus;
    selectedItem.votes = [];
    refreshOverlayStatus();
  }

  showToast('Undone');
}

// ---- File actions (reveal / open) ----

function fileReveal(filePath) {
  fetch('/api/file/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath }),
  }).catch(() => {});
}

function fileOpen(filePath) {
  fetch('/api/file/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath }),
  }).catch(() => {});
}

function shareFilename(originalName, mime) {
  const base = originalName.replace(/\.[^.]+$/, '');
  const extMap = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif',
    'image/webp': '.webp', 'video/mp4': '.mp4', 'video/webm': '.webm',
  };
  return base + (extMap[mime] || '.bin');
}

async function fileShare(filePath) {
  const origName = filePath.split('/').pop();
  const url = getMediaUrl(filePath);

  try {
    showToast('Preparing…');
    const res = await fetch(url);
    const mime = res.headers.get('content-type') || 'application/octet-stream';
    const blob = await res.blob();
    const filename = shareFilename(origName, mime);
    const file = new File([blob], filename, { type: mime });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
    if (navigator.share) {
      await navigator.share({ title: filename, text: filename });
      return;
    }

    if (mime.startsWith('image/') && navigator.clipboard && typeof ClipboardItem !== 'undefined') {
      const pngBlob = await convertToPng(blob, mime);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      showToast('Copied to clipboard');
      return;
    }

    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('Saved');
  } catch (e) {
    if (e.name !== 'AbortError') showToast('Share failed');
  }
}

function convertToPng(blob, mime) {
  if (mime === 'image/png') return Promise.resolve(blob);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      canvas.toBlob((pngBlob) => resolve(pngBlob || blob), 'image/png');
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); resolve(blob); };
    img.src = URL.createObjectURL(blob);
  });
}

async function fileCopyPath(filePath) {
  try {
    await navigator.clipboard.writeText(filePath);
    showToast('Path copied');
  } catch {
    showToast('Copy failed');
  }
}

// ---- Grid interaction: right-click, double-click, long-press ----

function attachGridInteractions(div, item) {
  if (!isTouchDevice) {
    let clickTimer = null;

    div.addEventListener('click', (e) => {
      if (clickTimer) return;
      clickTimer = setTimeout(() => {
        clickTimer = null;
        openItemDetail(item);
      }, 250);
    });

    div.addEventListener('dblclick', (e) => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      e.preventDefault();
      fileOpen(item.path);
      showToast('Opening file…');
    });

    div.addEventListener('contextmenu', (e) => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      e.preventDefault();
      fileReveal(item.path);
      showToast('Revealed in Finder');
    });
  } else {
    let pressTimer = null;
    let pressTriggered = false;

    div.addEventListener('touchstart', (e) => {
      pressTriggered = false;
      pressTimer = setTimeout(() => {
        pressTriggered = true;
        openActionSheet(item);
      }, LONG_PRESS_MS);
    }, { passive: true });

    div.addEventListener('touchend', () => {
      clearTimeout(pressTimer);
    });

    div.addEventListener('touchmove', () => {
      clearTimeout(pressTimer);
    });

    div.addEventListener('click', (e) => {
      if (pressTriggered) {
        e.preventDefault();
        e.stopPropagation();
        pressTriggered = false;
      }
    }, true);
  }
}

// ---- Action sheet (mobile) ----

function openActionSheet(item) {
  actionSheetItem = item;
  document.getElementById('actionSheetTitle').textContent = item.filename;
  document.getElementById('actionSheet').classList.remove('hidden');
}

function closeActionSheet() {
  document.getElementById('actionSheet').classList.add('hidden');
  actionSheetItem = null;
}

// ---- Toast ----

function showToast(msg) {
  const existing = document.querySelector('.context-hint');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'context-hint';
  el.textContent = msg;
  el.style.top = '16px';
  el.style.left = '50%';
  el.style.transform = 'translateX(-50%)';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1500);
}

// ---- Keyboard ----

function onKeyDown(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
    e.preventDefault();
    doUndo();
    return;
  }
  if (e.key === 'Escape') {
    if (!document.getElementById('actionSheet').classList.contains('hidden')) {
      closeActionSheet();
    } else {
      closeItemDetail();
    }
  }
}

// ---- Init ----

async function init() {
  const albumId = getAlbumId();
  if (!albumId) {
    document.body.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#888">No album specified.</div>';
    return;
  }

  // Load the first page to get album info + counts
  try {
    const data = await fetchPage('all', 0);
    albumData = data.album;
    isSharedMode = albumData && albumData.mode === 'shared';
    counts = data.counts;
    totalFiltered = data.total;
    hasMore = data.hasMore;
    if (data.devices) {
      for (const d of data.devices) deviceMap[d.id] = d.short;
    }
    const fragment = document.createDocumentFragment();
    for (const item of data.items) {
      fragment.appendChild(createGridItem(item));
    }
    gridEl.appendChild(fragment);
    currentOffset = data.items.length;
  } catch (err) {
    document.body.innerHTML =
      `<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#888">${escapeHtml(err.message)}</div>`;
    return;
  }

  document.getElementById('albumName').textContent = albumData.name;
  document.getElementById('modeBadge').textContent =
    albumData.mode === 'distributed' ? 'Distributed' : 'Shared';
  renderCounts();

  if (totalFiltered === 0) {
    emptyMsgEl.classList.remove('hidden');
    scrollArea.classList.add('hidden');
  }

  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => applyFilter(btn.dataset.filter));
  });

  document.getElementById('backBtn').addEventListener('click', () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      window.close();
    }
  });

  document.getElementById('undoBtn').addEventListener('click', doUndo);
  document.getElementById('overlayBackdrop').addEventListener('click', closeItemDetail);
  document.getElementById('closeOverlay').addEventListener('click', closeItemDetail);
  document.getElementById('btnSelect').addEventListener('click', () => reclassify('selected'));
  document.getElementById('btnDiscard').addEventListener('click', () => reclassify('discarded'));

  document.getElementById('btnReveal').addEventListener('click', () => {
    if (selectedItem) {
      fileReveal(selectedItem.path);
      showToast('Revealed in Finder');
    }
  });
  document.getElementById('btnOpen').addEventListener('click', () => {
    if (selectedItem) {
      fileOpen(selectedItem.path);
      showToast('Opening file…');
    }
  });
  document.getElementById('btnShare').addEventListener('click', () => {
    if (selectedItem) fileShare(selectedItem.path);
  });
  document.getElementById('btnCopyPath').addEventListener('click', () => {
    if (selectedItem) fileCopyPath(selectedItem.path);
  });

  document.getElementById('actionSheetBackdrop').addEventListener('click', closeActionSheet);
  document.getElementById('asCancel').addEventListener('click', closeActionSheet);
  document.getElementById('asReveal').addEventListener('click', () => {
    if (actionSheetItem) fileReveal(actionSheetItem.path);
    closeActionSheet();
    showToast('Revealed in Finder');
  });
  document.getElementById('asOpen').addEventListener('click', () => {
    if (actionSheetItem) fileOpen(actionSheetItem.path);
    closeActionSheet();
    showToast('Opening on desktop…');
  });
  document.getElementById('asShare').addEventListener('click', () => {
    if (actionSheetItem) fileShare(actionSheetItem.path);
    closeActionSheet();
  });

  document.addEventListener('keydown', onKeyDown);

  setupObserver();
}

init();
