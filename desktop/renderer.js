// ---------------------------------------------------------------------------
// License gate — blocks UI until a valid license is activated
// ---------------------------------------------------------------------------

const licenseGate = document.getElementById('licenseGate');
const licenseEmailInput = document.getElementById('licenseEmail');
const licenseKeyInput = document.getElementById('licenseKeyInput');
const licenseErrorEl = document.getElementById('licenseError');
const activateBtn = document.getElementById('activateBtn');
const buyLink = document.getElementById('buyLink');

function showLicenseError(msg) {
  licenseErrorEl.textContent = msg;
  licenseErrorEl.classList.remove('hidden');
}

function hideLicenseError() {
  licenseErrorEl.classList.add('hidden');
}

function unlockApp() {
  licenseGate.classList.add('hidden');
}

function showLicenseGate() {
  licenseGate.classList.remove('hidden');
}

activateBtn.addEventListener('click', async () => {
  hideLicenseError();
  const email = licenseEmailInput.value.trim();
  const key = licenseKeyInput.value.trim().toUpperCase();
  if (!email) { showLicenseError('Please enter your email address.'); return; }
  if (!key) { showLicenseError('Please enter your license key.'); return; }

  activateBtn.disabled = true;
  activateBtn.textContent = 'Activating…';
  try {
    const result = await window.pictinder.activateLicense(email, key);
    if (result.ok) {
      unlockApp();
      renderLicenseInfo(email);
    } else {
      showLicenseError(result.error || 'Activation failed. Check your credentials.');
    }
  } catch (err) {
    showLicenseError('Network error — check your internet connection and try again.');
  } finally {
    activateBtn.disabled = false;
    activateBtn.textContent = 'Activate';
  }
});

licenseKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') activateBtn.click(); });
licenseEmailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') licenseKeyInput.focus(); });

buyLink.addEventListener('click', (e) => {
  e.preventDefault();
  if (window.pictinder && window.pictinder.openExternalUrl) {
    window.pictinder.openExternalUrl('https://pictinder.com/pricing.html');
  }
});

document.getElementById('recoverLink').addEventListener('click', (e) => {
  e.preventDefault();
  if (window.pictinder && window.pictinder.openExternalUrl) {
    window.pictinder.openExternalUrl('https://pictinder.com/recover.html');
  }
});

window.pictinder.onLicenseRevoked(() => {
  showLicenseGate();
  showLicenseError('Your license has been revoked or deactivated. Please re-activate.');
});

function renderLicenseInfo(email) {
  let infoEl = document.getElementById('licenseInfo');
  if (!infoEl) {
    infoEl = document.createElement('div');
    infoEl.id = 'licenseInfo';
    infoEl.className = 'license-info';
    const settingsSection = document.querySelector('.settings');
    if (settingsSection) settingsSection.prepend(infoEl);
  }
  infoEl.innerHTML =
    '<span class="license-info__email">' + escapeHtmlSafe(email) + '</span>' +
    '<span class="license-info__badge">Pro</span>';
}

function escapeHtmlSafe(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// Check license on startup
(async function checkLicense() {
  try {
    const status = await window.pictinder.getLicenseStatus();
    if (status.licensed) {
      const verify = await window.pictinder.verifyLicense();
      if (verify.valid) {
        unlockApp();
        renderLicenseInfo(status.email);
      } else {
        showLicenseGate();
        if (verify.error) showLicenseError(verify.error);
      }
    } else {
      showLicenseGate();
    }
  } catch {
    showLicenseGate();
  }
})();

// ---------------------------------------------------------------------------
// Main app (loads after license check)
// ---------------------------------------------------------------------------

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
const cloudAccountsCountEl = document.getElementById('cloudAccountsCount');
const cloudDropdownBody = document.getElementById('cloudDropdownBody');
const cloudNotificationsListEl = document.getElementById('cloudNotificationsList');
const cacheBtn = document.getElementById('cacheBtn');
const cacheBadge = document.getElementById('cacheBadge');
const cacheDropdown = document.getElementById('cacheDropdown');
const cloudSettingsBtn = document.getElementById('cloudSettingsBtn');
const cloudDropdown = document.getElementById('cloudDropdown');
const notifBell = document.getElementById('notifBell');
const notifBadge = document.getElementById('notifBadge');
const notifDropdown = document.getElementById('notifDropdown');
const uploadedAlbumsBtn = document.getElementById('uploadedAlbumsBtn');
const uploadedAlbumsDropdown = document.getElementById('uploadedAlbumsDropdown');
const uploadedAlbumsList = document.getElementById('uploadedAlbumsList');
const uploadedAlbumsSearch = document.getElementById('uploadedAlbumsSearch');
const logEl = document.getElementById('log');
const helpBtn = document.getElementById('helpBtn');
const helpDropdown = document.getElementById('helpDropdown');

let serverRunning = false;
let folders = [];
let wsConn = null;
let serverPort = null;
let latestCloudCoverage = {};
let latestCloudAccounts = [];
let latestRuns = [];
let latestNotifications = [];
let uploadModalAlbum = null;
let cloudPollTimer = null;
let resumeSnoozedUntil = 0;
let resumePromptOpen = false;
let latestOAuthConfig = { clientId: '', hasClientSecret: false };

function closeAllDropdowns() {
  notifDropdown.classList.add('hidden');
  notifBell.classList.remove('active');
  cloudDropdown.classList.add('hidden');
  cloudSettingsBtn.classList.remove('active');
  cacheDropdown.classList.add('hidden');
  cacheBtn.classList.remove('active');
  uploadedAlbumsDropdown.classList.add('hidden');
  uploadedAlbumsBtn.classList.remove('active');
  if (helpDropdown) { helpDropdown.classList.add('hidden'); helpBtn.classList.remove('active'); }
}

function positionDropdown(btn, dropdown) {
  const rect = btn.getBoundingClientRect();
  dropdown.style.top = `${rect.bottom + 6}px`;
}

function toggleDropdown(btn, dropdown) {
  return (e) => {
    e.stopPropagation();
    const wasOpen = !dropdown.classList.contains('hidden');
    closeAllDropdowns();
    if (!wasOpen) {
      positionDropdown(btn, dropdown);
      dropdown.classList.remove('hidden');
      btn.classList.add('active');
    }
  };
}

if (helpBtn && helpDropdown) helpBtn.addEventListener('click', toggleDropdown(helpBtn, helpDropdown));
cacheBtn.addEventListener('click', toggleDropdown(cacheBtn, cacheDropdown));
cloudSettingsBtn.addEventListener('click', toggleDropdown(cloudSettingsBtn, cloudDropdown));
uploadedAlbumsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const wasOpen = !uploadedAlbumsDropdown.classList.contains('hidden');
  closeAllDropdowns();
  if (!wasOpen) {
    positionDropdown(uploadedAlbumsBtn, uploadedAlbumsDropdown);
    uploadedAlbumsDropdown.classList.remove('hidden');
    uploadedAlbumsBtn.classList.add('active');
    fetchUploadedAlbums();
  }
});
notifBell.addEventListener('click', toggleDropdown(notifBell, notifDropdown));

document.addEventListener('click', (e) => {
  const inAny = [notifDropdown, notifBell, cloudDropdown, cloudSettingsBtn, cacheDropdown, cacheBtn, uploadedAlbumsDropdown, uploadedAlbumsBtn]
    .some((el) => el.contains(e.target));
  if (!inAny) closeAllDropdowns();
});

function updateNotifBadge(count) {
  if (count > 0) {
    notifBadge.textContent = String(count);
    notifBadge.classList.remove('hidden');
    notifBell.classList.add('has-notifs');
  } else {
    notifBadge.classList.add('hidden');
    notifBell.classList.remove('has-notifs');
  }
}

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

function formatAlbumStats(album) {
  const selected = album.selectedCount || 0;
  const discarded = album.discardedCount || 0;
  const total = album.totalItems || 0;
  const c = latestCloudCoverage[album.id];
  const uploaded = (c && c.fullyBackedUp) || 0;
  return `<span class="cov cov-ok" title="Selected">✔ ${selected}</span> / <span class="cov cov-bad" title="Discarded">✗ ${discarded}</span> / <span class="cov cov-cloud" title="Uploaded">☁ ${uploaded}</span> / <span class="cov cov-dim" title="Total">${total}</span>`;
}

// ---- Folders ----

let faceScanPollTimer = null;

function renderFolders() {
  folderListEl.innerHTML = '';
  if (folders.length === 0) {
    folderListEl.innerHTML = '<div class="folder-empty">No folders added yet.</div>';
  } else {
    folders.forEach((f) => {
      const row = document.createElement('div');
      row.className = 'folder-row';
      row.innerHTML = `<span class="folder-path" title="${escapeHtml(f)}">${escapeHtml(f)}</span>`;

      // Face scan button
      const scanBtn = document.createElement('button');
      scanBtn.className = 'folder-scan-btn';
      scanBtn.title = 'Scan faces';
      scanBtn.textContent = '🔍';
      scanBtn.dataset.folder = f;
      scanBtn.onclick = async () => {
        if (!serverPort) { addLog('Start the server first'); return; }
        scanBtn.disabled = true;
        scanBtn.textContent = '⏳';
        try {
          const res = await fetch(`http://localhost:${serverPort}/api/faces/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folder: f }),
          });
          const data = await res.json();
          if (!data.ok) {
            addLog(`Face scan: ${data.error || 'Failed'}`);
            scanBtn.disabled = false;
            scanBtn.textContent = '🔍';
            return;
          }
          addLog(`Face scan started for: ${f}`);
          startFaceScanPoll();
        } catch (err) {
          addLog('Face scan error: ' + err.message);
          scanBtn.disabled = false;
          scanBtn.textContent = '🔍';
        }
      };
      row.appendChild(scanBtn);

      // Scan progress element (hidden by default)
      const progressEl = document.createElement('div');
      progressEl.className = 'folder-scan-progress hidden';
      progressEl.dataset.folder = f;
      row.appendChild(progressEl);

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

function startFaceScanPoll() {
  if (faceScanPollTimer) return;
  faceScanPollTimer = setInterval(updateFaceScanProgress, 2000);
  updateFaceScanProgress();
}

function stopFaceScanPoll() {
  if (faceScanPollTimer) {
    clearInterval(faceScanPollTimer);
    faceScanPollTimer = null;
  }
}

async function updateFaceScanProgress() {
  if (!serverPort) { stopFaceScanPoll(); return; }
  try {
    const res = await fetch(`http://localhost:${serverPort}/api/faces/scan/status`);
    const data = await res.json();

    // Update progress bars for all folder scan buttons
    const progressEls = folderListEl.querySelectorAll('.folder-scan-progress');
    const scanBtns = folderListEl.querySelectorAll('.folder-scan-btn');

    if (data.scanning) {
      const activeFolder = data.folder === '__all__' ? null : data.folder;
      progressEls.forEach((el) => {
        const f = el.dataset.folder;
        if (activeFolder && f === activeFolder) {
          const pct = data.total > 0 ? Math.round(100 * data.processed / data.total) : 0;
          el.innerHTML = `<div class="scan-progress-bar-wrap"><div class="scan-progress-bar" style="width:${pct}%"></div></div><span class="scan-progress-text">${pct}% · ${data.found} faces</span>`;
          el.classList.remove('hidden');
        } else if (!activeFolder) {
          // All-folder scan
          const pct = data.total > 0 ? Math.round(100 * data.processed / data.total) : 0;
          el.innerHTML = `<div class="scan-progress-bar-wrap"><div class="scan-progress-bar" style="width:${pct}%"></div></div><span class="scan-progress-text">${pct}% · ${data.found} faces</span>`;
          el.classList.remove('hidden');
        } else {
          el.classList.add('hidden');
        }
      });
      scanBtns.forEach((btn) => {
        btn.disabled = true;
        btn.textContent = '⏳';
      });
    } else {
      // Scan finished
      progressEls.forEach((el) => el.classList.add('hidden'));
      scanBtns.forEach((btn) => {
        btn.disabled = false;
        btn.textContent = '🔍';
      });
      stopFaceScanPoll();
      if (data.stats) {
        addLog(`[faces] ${data.stats.totalOccurrences} total faces, ${data.stats.totalIdentities} identities`);
      }
    }
  } catch {
    stopFaceScanPoll();
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
          <span class="album-stats">${formatAlbumStats(a)}</span>
        </div>
        <button type="button" class="album-upload-btn" title="Upload to cloud">Upload</button>
        <button type="button" class="album-delete-btn" title="Delete album">Delete</button>`;
      const main = card.querySelector('.album-card-main');
      const uploadBtn = card.querySelector('.album-upload-btn');
      const deleteBtn = card.querySelector('.album-delete-btn');
      main.addEventListener('click', () => window.pictinder.openAlbumDetail(a.id));
      uploadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openUploadModal(a);
      });
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteAlbum(a);
      });
      albumsListEl.appendChild(card);
    });
  }
}

// ---- Cloud settings / notifications / uploads ----

function modeExplainerText(mode) {
  if (mode === 'distribute') {
    return 'Distribute: files are split across selected accounts based on available space. Best for maximizing capacity.';
  }
  return 'Duplicate: every selected file goes to every selected account. Best for redundancy.';
}

async function fetchCloudCoverage() {
  if (!serverPort) return;
  try {
    const res = await fetch(`http://localhost:${serverPort}/api/cloud/coverage-summary`);
    const data = await res.json();
    latestCloudCoverage = data.coverage || {};
  } catch { }
}

async function fetchCloudAccounts() {
  if (!serverPort) return;
  try {
    const res = await fetch(`http://localhost:${serverPort}/api/cloud/accounts`);
    const data = await res.json();
    latestCloudAccounts = data.accounts || [];
    renderCloudDropdown();
  } catch {
    latestCloudAccounts = [];
    renderCloudDropdown();
  }
}

async function fetchCloudNotifications() {
  if (!serverPort) return;
  try {
    const [runsRes, notifRes] = await Promise.all([
      fetch(`http://localhost:${serverPort}/api/cloud/resume-candidates`),
      fetch(`http://localhost:${serverPort}/api/cloud/notifications`),
    ]);
    const runsData = await runsRes.json();
    const notifData = await notifRes.json();
    latestRuns = runsData.runs || [];
    latestNotifications = notifData.notifications || [];
    renderCloudNotifications();
  } catch {
    latestRuns = [];
    latestNotifications = [];
    renderCloudNotifications();
  }
}

async function renderCloudDropdown() {
  cloudAccountsCountEl.textContent = String(latestCloudAccounts.length);
  cloudDropdownBody.innerHTML = '';

  try { latestOAuthConfig = await window.pictinder.getGoogleOAuthConfig(); } catch { }

  const hasOAuth = !!(latestOAuthConfig.clientId && latestOAuthConfig.hasClientSecret);
  const hasBundled = !!latestOAuthConfig.hasBundled;
  const hasAccounts = latestCloudAccounts.length > 0;

  if (hasOAuth || hasBundled || hasAccounts) {
    renderCloudAccountsView();
  } else {
    renderCloudSetupView();
  }
}

function renderCloudAccountsView() {
  const wrap = document.createElement('div');
  wrap.className = 'cloud-accounts-section';

  if (!serverPort) {
    wrap.innerHTML = '<div class="empty-panel">Start the server to manage cloud accounts</div>';
    cloudDropdownBody.appendChild(wrap);
    return;
  }

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn primary cloud-add-btn';
  addBtn.textContent = '+ Connect Google account';
  addBtn.addEventListener('click', async () => {
    await openGoogleAuthFromFlow();
    fetchCloudAccounts();
  });
  wrap.appendChild(addBtn);

  if (latestCloudAccounts.length > 0) {
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'dropdown-search';
    searchInput.placeholder = 'Search accounts…';
    searchInput.addEventListener('keydown', (e) => e.stopPropagation());
    wrap.appendChild(searchInput);

    const list = document.createElement('div');
    list.className = 'cloud-accounts-list';

    const renderAccountsList = () => {
      const q = searchInput.value.toLowerCase().trim();
      list.innerHTML = '';
      const filtered = latestCloudAccounts.filter((a) =>
        !q || (a.email || '').toLowerCase().includes(q) || (a.accountId || '').toLowerCase().includes(q),
      );
      for (const a of filtered) {
        const free = (a.quotaTotal && a.quotaUsed != null) ? Math.max(0, a.quotaTotal - a.quotaUsed) : null;
        const status = (a.status || 'active').toLowerCase();
        const row = document.createElement('div');
        row.className = 'cloud-account-item';
        row.innerHTML = `
          <div class="cloud-account-meta">
            <div class="cloud-account-email" title="${escapeHtml(a.email)}">${escapeHtml(a.email)}</div>
            <div class="cloud-account-sub">${escapeHtml(a.accountId || '')}${free != null ? ` · Free ${formatBytes(free)}` : ''}</div>
          </div>
          <div class="cloud-account-meta" style="align-items:flex-end">
            <div class="cloud-status ${escapeHtml(status)}">${escapeHtml(status.replace('_', ' '))}</div>
            <button type="button" class="btn link-btn danger-btn">Disconnect</button>
          </div>
        `;
        row.querySelector('button').addEventListener('click', async () => {
          if (!confirm(`Disconnect ${a.email}?`)) return;
          await fetch(`http://localhost:${serverPort}/api/cloud/accounts/${a.id}`, { method: 'DELETE' });
          fetchCloudAccounts();
          fetchCloudCoverage();
          fetchCloudNotifications();
        });
        list.appendChild(row);
      }
      if (filtered.length === 0) {
        list.innerHTML = '<div class="empty-panel">No matches</div>';
      }
    };

    searchInput.addEventListener('input', renderAccountsList);
    renderAccountsList();
    wrap.appendChild(list);
  }

  const advanced = document.createElement('button');
  advanced.type = 'button';
  advanced.className = 'btn link-btn cloud-edit-creds';
  advanced.textContent = 'Use custom OAuth credentials';
  advanced.addEventListener('click', () => showCloudCredentialsEditor());
  wrap.appendChild(advanced);

  cloudDropdownBody.appendChild(wrap);
}

function renderCloudSetupView() {
  const port = portEl.value || '3847';
  const redirectUri = `http://localhost:${port}/api/cloud/google/callback`;

  cloudDropdownBody.innerHTML = `
    <div class="cloud-setup">
      <div class="cloud-setup-title">Set up Google Drive backup</div>
      <div class="cloud-setup-hint">Requires a Google Cloud OAuth app (free, one-time setup).</div>
      <div class="cloud-setup-steps">
        <div class="cloud-step">
          <span class="cloud-step-num">1</span>
          <span>Go to <a href="#" class="cloud-link" data-url="https://console.cloud.google.com/apis/credentials">Google Cloud Console</a> &rarr; Create Credentials &rarr; OAuth Client ID &rarr; type "Web application"</span>
        </div>
        <div class="cloud-step">
          <span class="cloud-step-num">2</span>
          <div>
            Add this as an Authorized redirect URI:
            <code class="cloud-redirect-uri">${escapeHtml(redirectUri)}</code>
          </div>
        </div>
        <div class="cloud-step">
          <span class="cloud-step-num">3</span>
          <span>Copy the Client ID and Client Secret and paste below</span>
        </div>
      </div>
      <div class="cloud-auth-row">
        <input id="googleClientId" type="text" placeholder="Client ID" />
      </div>
      <div class="cloud-auth-row">
        <input id="googleClientSecret" type="password" placeholder="Client Secret" />
      </div>
      <button type="button" id="saveCloudConfig" class="btn primary" style="align-self:flex-start">Save credentials</button>
    </div>
  `;
  cloudDropdownBody.querySelectorAll('.cloud-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.pictinder.openExternalUrl(link.dataset.url);
    });
  });
  document.getElementById('saveCloudConfig').addEventListener('click', saveCloudConfigHandler);
}

function showCloudCredentialsEditor() {
  cloudDropdownBody.innerHTML = `
    <div class="cloud-setup">
      <div class="cloud-setup-title">Custom OAuth Credentials</div>
      <div class="cloud-setup-hint">Override the built-in credentials with your own Google Cloud OAuth app.</div>
      <div class="cloud-auth-row">
        <input id="googleClientId" type="text" placeholder="Client ID" value="${escapeHtml(latestOAuthConfig.clientId || '')}" />
      </div>
      <div class="cloud-auth-row">
        <input id="googleClientSecret" type="password" placeholder="Client Secret (leave blank to keep existing)" />
      </div>
      <div class="cloud-creds-actions">
        <button type="button" id="saveCloudConfig" class="btn primary">Save</button>
        <button type="button" id="cancelCloudEdit" class="btn link-btn">Back</button>
      </div>
    </div>
  `;
  document.getElementById('saveCloudConfig').addEventListener('click', saveCloudConfigHandler);
  document.getElementById('cancelCloudEdit').addEventListener('click', () => renderCloudDropdown());
}

async function saveCloudConfigHandler() {
  const clientId = document.getElementById('googleClientId').value.trim();
  const clientSecret = document.getElementById('googleClientSecret').value.trim();
  if (!clientId) {
    alert('Client ID is required');
    return;
  }
  await window.pictinder.saveGoogleOAuthConfig({ clientId, clientSecret });
  latestOAuthConfig = { ...latestOAuthConfig, clientId, hasClientSecret: !!clientSecret || latestOAuthConfig.hasClientSecret };
  addLog('Google OAuth credentials saved');
  renderCloudDropdown();
}

function renderUploadProgress() {
  const section = document.getElementById('uploadProgressSection');
  if (!section) return;
  const active = latestRuns.filter((r) => r.status === 'queued' || r.status === 'running');
  if (active.length === 0) {
    section.classList.add('hidden');
    section.innerHTML = '';
    return;
  }
  section.classList.remove('hidden');
  section.innerHTML = '';
  for (const r of active) {
    const total = Math.max(1, r.totalItems || 0);
    const done = r.uploadedItems || 0;
    const pct = Math.round((100 * done) / total);
    const label = `${escapeHtml(r.albumName || r.albumId)} · ${done}/${total}`;
    const item = document.createElement('div');
    item.className = 'upload-progress-item';
    item.innerHTML = `
      <div class="upload-progress-label"><span>${label}</span><span>${pct}%</span></div>
      <div class="upload-progress-row"><div class="upload-progress-bar-wrap"><div class="upload-progress-bar" style="width:${pct}%"></div></div><button type="button" class="btn link-btn danger-btn upload-cancel-btn">Cancel</button></div>
    `;
    item.querySelector('.upload-cancel-btn').addEventListener('click', async () => {
      if (!confirm(`Cancel upload for "${r.albumName || r.albumId}"?\n\nFiles already uploaded will remain on Drive.`)) return;
      await fetch(`http://localhost:${serverPort}/api/cloud/uploads/runs/${r.id}/cancel`, { method: 'POST' }).catch(() => { });
      fetchCloudNotifications();
    });
    section.appendChild(item);
  }
}

function renderCloudNotifications() {
  const items = [...latestNotifications];
  updateNotifBadge(items.length);
  renderUploadProgress();
  const notifSearchEl = document.getElementById('notifSearch');
  const q = notifSearchEl ? notifSearchEl.value.toLowerCase().trim() : '';
  cloudNotificationsListEl.innerHTML = '';
  const filtered = items.filter((n) => {
    if (!q) return true;
    const text = `${n.title || ''} ${n.albumName || ''} ${n.message || ''} ${(n.payload?.topFolders || []).join(' ')}`.toLowerCase();
    return text.includes(q);
  });
  if (filtered.length === 0) {
    cloudNotificationsListEl.innerHTML = `<div class="empty-panel">${q ? 'No matches' : 'No pending upload notifications'}</div>`;
    return;
  }
  for (const n of filtered) {
    const topFolders = (n.payload && Array.isArray(n.payload.topFolders)) ? n.payload.topFolders.join(', ') : '';
    const driveLinks = (n.payload && Array.isArray(n.payload.driveFolderLinks)) ? n.payload.driveFolderLinks : [];
    const isComplete = n.type === 'upload_complete' || n.type === 'upload_partial';
    const row = document.createElement('div');
    row.className = 'cloud-notification-item';
    row.innerHTML = `
      <div class="cloud-notification-title">${escapeHtml(n.title || 'Upload')}</div>
      <div class="cloud-notification-sub">${escapeHtml(n.albumName || n.message || '')}${topFolders ? ` · ${escapeHtml(topFolders)}` : ''}</div>
      <div class="cloud-notification-actions">
        ${driveLinks.length > 0 ? '<button type="button" class="btn link-btn notif-open">Open</button>' : ''}
        ${isComplete ? '' : '<button type="button" class="btn link-btn notif-snooze">Snooze</button>'}
        <button type="button" class="btn link-btn danger-btn notif-dismiss">Dismiss</button>
      </div>
    `;
    const openBtn = row.querySelector('.notif-open');
    if (openBtn) {
      openBtn.addEventListener('click', async () => {
        for (const link of driveLinks) {
          window.pictinder ? window.pictinder.openExternalUrl(link) : window.open(link, '_blank');
        }
        await fetch(`http://localhost:${serverPort}/api/cloud/notifications/${n.id}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'open' }),
        });
        fetchCloudNotifications();
      });
    }
    const snoozeBtn = row.querySelector('.notif-snooze');
    if (snoozeBtn) {
      snoozeBtn.addEventListener('click', async () => {
        await fetch(`http://localhost:${serverPort}/api/cloud/notifications/${n.id}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'snooze', snoozeMinutes: 180 }),
        });
        fetchCloudNotifications();
      });
    }
    row.querySelector('.notif-dismiss').addEventListener('click', async () => {
      await fetch(`http://localhost:${serverPort}/api/cloud/notifications/${n.id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dismiss' }),
      });
      fetchCloudNotifications();
    });
    cloudNotificationsListEl.appendChild(row);
  }
}

// ---- Uploaded albums dropdown ----

let latestUploadedAlbums = [];

async function fetchUploadedAlbums() {
  if (!serverPort) return;
  try {
    const res = await fetch(`http://localhost:${serverPort}/api/cloud/uploaded-albums`);
    const data = await res.json();
    latestUploadedAlbums = data.albums || [];
  } catch {
    latestUploadedAlbums = [];
  }
  renderUploadedAlbums();
}

function renderUploadedAlbums() {
  const q = (uploadedAlbumsSearch.value || '').toLowerCase().trim();
  uploadedAlbumsList.innerHTML = '';
  const filtered = latestUploadedAlbums.filter((a) => {
    if (!q) return true;
    if (a.name.toLowerCase().includes(q)) return true;
    if (a.topFolders && a.topFolders.some((f) => f.toLowerCase().includes(q))) return true;
    if (a.driveLinks && a.driveLinks.some((l) => (l.account || '').toLowerCase().includes(q))) return true;
    return false;
  });
  if (filtered.length === 0) {
    uploadedAlbumsList.innerHTML = `<div class="empty-panel">${q ? 'No matches' : 'No uploaded albums yet'}</div>`;
    return;
  }
  for (const a of filtered) {
    const row = document.createElement('div');
    row.className = 'uploaded-album-item';
    const folders = (a.topFolders || []).join(', ');
    const pct = a.total > 0 ? Math.round(100 * a.uploaded / a.total) : 0;
    const statusText = a.uploaded === a.total ? 'All uploaded' : `${a.uploaded} of ${a.total} (${pct}%)`;
    row.innerHTML = `
      <div class="uploaded-album-name">${escapeHtml(a.name)}</div>
      <div class="uploaded-album-meta">${escapeHtml(statusText)}${folders ? ` · ${escapeHtml(folders)}` : ''}</div>
      <div class="uploaded-album-links-list">
        ${a.driveLinks.map((l) => `
          <div class="uploaded-album-link-row">
            <span class="uploaded-album-account">${escapeHtml(l.account)}</span>
            <button type="button" class="btn link-btn uploaded-album-open" data-url="${escapeHtml(l.url)}">Open</button>
          </div>
        `).join('')}
      </div>
    `;
    row.querySelectorAll('.uploaded-album-open').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        window.pictinder ? window.pictinder.openExternalUrl(btn.dataset.url) : window.open(btn.dataset.url, '_blank');
      });
    });
    uploadedAlbumsList.appendChild(row);
  }
}

uploadedAlbumsSearch.addEventListener('input', () => renderUploadedAlbums());
document.getElementById('notifSearch').addEventListener('input', () => renderCloudNotifications());
document.getElementById('notifSearch').addEventListener('keydown', (e) => e.stopPropagation());

function maybeShowResumePrompt() {
  const now = Date.now();
  if (resumePromptOpen) return;
  if (now < resumeSnoozedUntil) return;
  const resumables = latestRuns.filter((r) => ['queued', 'running', 'paused', 'failed'].includes(r.status));
  if (resumables.length === 0) return;
  resumePromptOpen = true;
  const top = resumables.slice(0, 5).map((r) => `${r.albumName} (${r.uploadedItems}/${r.totalItems})${r.topFolders && r.topFolders.length ? ` · ${r.topFolders.join(', ')}` : ''}`);
  const extra = resumables.length > 5 ? `\n+ ${resumables.length - 5} more projects in notification tray.` : '';
  document.getElementById('resumePromptText').textContent = `${top.join('\n')}${extra}`;
  document.getElementById('resumePrompt').classList.remove('hidden');
}

function closeResumePrompt() {
  resumePromptOpen = false;
  document.getElementById('resumePrompt').classList.add('hidden');
}

async function openGoogleAuthFromFlow() {
  const res = await fetch(`http://localhost:${serverPort}/api/cloud/accounts/google/start`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok || !data.authUrl) {
    alert(data.error || 'Unable to start Google sign-in');
    return false;
  }
  await window.pictinder.openExternalUrl(data.authUrl);
  alert('Complete Google sign-in in your browser, then click OK to refresh accounts.');
  await fetchCloudAccounts();
  return true;
}

function openUploadModal(album) {
  uploadModalAlbum = album;
  document.getElementById('uploadAlbumName').textContent = album.name;
  document.getElementById('uploadMode').value = 'distribute';
  document.getElementById('uploadMediaScope').value = 'selected';
  document.getElementById('uploadModeExplainer').textContent = modeExplainerText('distribute');
  const searchEl = document.getElementById('uploadAccountSearch');
  if (searchEl) searchEl.value = '';
  renderUploadAccountChecklist();
  document.getElementById('uploadModal').classList.remove('hidden');
}

function closeUploadModal() {
  uploadModalAlbum = null;
  document.getElementById('uploadModal').classList.add('hidden');
}

function renderUploadAccountChecklist() {
  const container = document.getElementById('uploadAccountChecklist');
  container.innerHTML = '';
  if (latestCloudAccounts.length === 0) {
    container.innerHTML = '<div class="empty-panel">No connected account. It will prompt Google sign-in when you start.</div>';
    return;
  }
  for (const a of latestCloudAccounts) {
    const row = document.createElement('label');
    row.className = 'upload-account-check';
    row.setAttribute('data-email', (a.email || '').toLowerCase());
    row.innerHTML = `<input type="checkbox" value="${escapeHtml(a.id)}" checked /> <span>${escapeHtml(a.email)} <small>(${escapeHtml(a.status || 'active')})</small></span>`;
    container.appendChild(row);
  }
  filterUploadAccountChecklist();
}

function filterUploadAccountChecklist() {
  const searchEl = document.getElementById('uploadAccountSearch');
  const container = document.getElementById('uploadAccountChecklist');
  if (!searchEl || !container) return;
  const q = (searchEl.value || '').toLowerCase().trim();
  const rows = container.querySelectorAll('.upload-account-check');
  rows.forEach((row) => {
    const email = (row.getAttribute('data-email') || '');
    row.style.display = !q || email.includes(q) ? '' : 'none';
  });
}

async function startUploadFromModal() {
  if (!uploadModalAlbum) return;
  let selected = Array.from(document.querySelectorAll('#uploadAccountChecklist input[type="checkbox"]:checked')).map((n) => n.value);
  if (selected.length === 0) {
    const ok = await openGoogleAuthFromFlow();
    if (!ok) return;
    selected = Array.from(document.querySelectorAll('#uploadAccountChecklist input[type="checkbox"]:checked')).map((n) => n.value);
    if (selected.length === 0) {
      alert('Select at least one account');
      return;
    }
  }
  const mode = document.getElementById('uploadMode').value;
  const mediaScope = document.getElementById('uploadMediaScope').value;
  const resp = await fetch(`http://localhost:${serverPort}/api/cloud/uploads/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      albumId: uploadModalAlbum.id,
      mode,
      mediaScope,
      accountIds: selected,
    }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    alert(data.error || 'Failed to start upload');
    return;
  }
  addLog(`Cloud upload started: ${uploadModalAlbum.name}`);
  closeUploadModal();
  fetchCloudNotifications();
  fetchCloudCoverage().then(async () => {
    const listRes = await fetch(`http://localhost:${serverPort}/api/albums`);
    const listData = await listRes.json();
    renderAlbums(listData.albums || []);
  });
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
    const totalStr = formatBytes(data.total);
    document.getElementById('cacheSize').textContent = totalStr;
    if (data.total > 0) {
      cacheBadge.textContent = totalStr;
      cacheBadge.classList.remove('hidden');
    } else {
      cacheBadge.classList.add('hidden');
    }
    const parts = [];
    if (data.previews > 0) parts.push(`Images: ${formatBytes(data.previews)}`);
    if (data.thumbs > 0) parts.push(`Thumbs: ${formatBytes(data.thumbs)}`);
    if (data.transcoded > 0) parts.push(`Video: ${formatBytes(data.transcoded)}`);
    document.getElementById('cacheDetail').textContent = parts.join(' · ') || 'Empty';
  } catch { }
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

let currentJoinUrl = null;
const openDesktopFeedBtn = document.getElementById('openDesktopFeed');

function renderJoinUrl(joinUrl, qrDataUrl) {
  currentJoinUrl = joinUrl || null;
  if (qrDataUrl) {
    joinQrEl.innerHTML = '';
    const img = document.createElement('img');
    img.src = qrDataUrl;
    img.alt = 'Join QR';
    joinQrEl.appendChild(img);
  }
}

openDesktopFeedBtn.addEventListener('click', () => {
  if (!currentJoinUrl) return;
  const url = currentJoinUrl.replace(/\/phone\//, '/phone/');
  window.pictinder.openDesktopFeed(url);
});

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
        case 'cloud':
          latestRuns = data.runs || latestRuns;
          latestCloudCoverage = data.coverage || latestCloudCoverage;
          latestNotifications = data.notifications || latestNotifications;
          renderCloudNotifications();
          break;
      }
    } catch { }
  };

  wsConn.onclose = () => {
    if (serverRunning) setTimeout(() => connectWs(port), 2000);
  };

  wsConn.onerror = () => { };
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
  refreshCacheStats();
  fetchCloudCoverage().then(async () => {
    try {
      const listRes = await fetch(`http://localhost:${serverPort}/api/albums`);
      const listData = await listRes.json();
      renderAlbums(listData.albums || []);
    } catch { }
  });
  fetchCloudAccounts();
  fetchCloudNotifications();
  if (cloudPollTimer) clearInterval(cloudPollTimer);
  cloudPollTimer = setInterval(() => {
    if (!serverRunning) return;
    fetchCloudCoverage();
    fetchCloudNotifications();
  }, 15000);
}

function hideServerUI() {
  disconnectWs();
  serverPanel.classList.add('hidden');
  devicesSection.classList.add('hidden');
  albumsSection.classList.add('hidden');
  closeAllDropdowns();
  cacheBadge.classList.add('hidden');
  updateNotifBadge(0);
  serverUrlEl.textContent = '';
  joinQrEl.innerHTML = '';
  devicesListEl.innerHTML = '';
  albumsListEl.innerHTML = '';
  cloudNotificationsListEl.innerHTML = '';
  renderCloudDropdown();
  if (cloudPollTimer) {
    clearInterval(cloudPollTimer);
    cloudPollTimer = null;
  }
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

  setTimeout(async () => {
    try {
      const res = await fetch(`http://localhost:${serverPort}/api/faces/scan/status`);
      const data = await res.json();
      if (data.scanning) {
        addLog(`[faces] Auto-scan in progress (${data.processed || 0}/${data.total || '?'})…`);
        startFaceScanPoll();
      }
    } catch { /* server may not be ready yet */ }
  }, 4000);
}

// ---- Init ----

async function loadConfig() {
  try {
    const c = await window.pictinder.getInitialConfig();
    folders = c.folders || [];
    portEl.value = c.port || 3847;
  } catch (e) {
    addLog('Config load error: ' + (e && e.message || e));
  }
  renderFolders();
  updateServerButton();
  try {
    latestOAuthConfig = await window.pictinder.getGoogleOAuthConfig();
  } catch (e) {
    addLog('OAuth config error: ' + (e && e.message || e));
  }
  renderCloudDropdown();
}

loadConfig().catch((e) => addLog('loadConfig failed: ' + (e && e.message || e)));

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

document.getElementById('createAlbumBtn').addEventListener('click', () => {
  const form = document.getElementById('createAlbumForm');
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) {
    document.getElementById('newAlbumName').value = '';
    document.getElementById('newAlbumName').focus();
  }
});
document.getElementById('newAlbumCancel').addEventListener('click', () => {
  document.getElementById('createAlbumForm').classList.add('hidden');
});
document.getElementById('newAlbumSubmit').addEventListener('click', async () => {
  const name = document.getElementById('newAlbumName').value.trim();
  const mode = document.getElementById('newAlbumMode').value;
  if (!name) return;
  try {
    const res = await fetch(`http://localhost:${serverPort}/api/albums`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mode }),
    });
    if (!res.ok) throw new Error('Failed');
    document.getElementById('createAlbumForm').classList.add('hidden');
    addLog(`Created album: ${name}`);
    const listRes = await fetch(`http://localhost:${serverPort}/api/albums`);
    const data = await listRes.json();
    renderAlbums(data.albums || []);
  } catch {
    addLog(`Error creating album: ${name}`);
  }
});
document.getElementById('newAlbumName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('newAlbumSubmit').click();
  if (e.key === 'Escape') document.getElementById('createAlbumForm').classList.add('hidden');
});
document.getElementById('uploadMode').addEventListener('change', (e) => {
  document.getElementById('uploadModeExplainer').textContent = modeExplainerText(e.target.value);
});
document.getElementById('closeUploadModal').addEventListener('click', closeUploadModal);
document.getElementById('uploadModal').addEventListener('click', (e) => {
  if (e.target.id === 'uploadModal') closeUploadModal();
});
const uploadAccountSearchEl = document.getElementById('uploadAccountSearch');
if (uploadAccountSearchEl) {
  uploadAccountSearchEl.addEventListener('input', filterUploadAccountChecklist);
  uploadAccountSearchEl.addEventListener('keydown', (e) => e.stopPropagation());
}
document.getElementById('startUploadBtn').addEventListener('click', startUploadFromModal);
document.getElementById('resumeAllUploads').addEventListener('click', async () => {
  for (const r of latestRuns) {
    const runId = r.runId || r.id;
    if (runId) await fetch(`http://localhost:${serverPort}/api/cloud/uploads/runs/${runId}/resume`, { method: 'POST' }).catch(() => { });
  }
  fetchCloudNotifications();
});
document.getElementById('snoozeAllUploads').addEventListener('click', async () => {
  const notifications = [...latestNotifications];
  for (const n of notifications) {
    await fetch(`http://localhost:${serverPort}/api/cloud/notifications/${n.id}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'snooze', snoozeMinutes: 180 }),
    }).catch(() => { });
  }
  fetchCloudNotifications();
});

document.getElementById('resumePromptCancel').addEventListener('click', async () => {
  const resumables = latestRuns.filter((r) => ['queued', 'running', 'paused', 'failed'].includes(r.status));
  if (resumables.length === 0) { closeResumePrompt(); return; }
  const names = resumables.map((r) => r.albumName || r.albumId).join(', ');
  if (!confirm(`Cancel all uploads (${names})?\n\nFiles already uploaded will remain on Drive.`)) return;
  for (const r of resumables) {
    const runId = r.runId || r.id;
    if (runId) await fetch(`http://localhost:${serverPort}/api/cloud/uploads/runs/${runId}/cancel`, { method: 'POST' }).catch(() => { });
  }
  closeResumePrompt();
  fetchCloudNotifications();
});
document.getElementById('resumePromptResume').addEventListener('click', async () => {
  const resumables = latestRuns.filter((r) => ['queued', 'running', 'paused', 'failed'].includes(r.status));
  for (const r of resumables) {
    const runId = r.runId || r.id;
    if (runId) await fetch(`http://localhost:${serverPort}/api/cloud/uploads/runs/${runId}/resume`, { method: 'POST' }).catch(() => { });
  }
  closeResumePrompt();
  fetchCloudNotifications();
});
document.getElementById('resumePromptSnooze').addEventListener('click', () => {
  resumeSnoozedUntil = Date.now() + 3 * 60 * 60 * 1000;
  closeResumePrompt();
});
document.getElementById('resumePromptDismiss').addEventListener('click', async () => {
  const notifications = [...latestNotifications];
  for (const n of notifications) {
    await fetch(`http://localhost:${serverPort}/api/cloud/notifications/${n.id}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss' }),
    }).catch(() => { });
  }
  closeResumePrompt();
  fetchCloudNotifications();
});
document.getElementById('closeResumePrompt').addEventListener('click', () => {
  closeResumePrompt();
});
document.getElementById('resumePrompt').addEventListener('click', (e) => {
  if (e.target.id === 'resumePrompt') closeResumePrompt();
});
window.pictinder.onServerLog((msg) => {
  addLog(msg);
  if (msg.includes('[faces] Starting face scan')) {
    startFaceScanPoll();
  }
});
