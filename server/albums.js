const nodePath = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DEDUP_RAW_EXTS = new Set([
  '.nef', '.arw', '.sr2', '.srf', '.cr2', '.cr3', '.dng', '.raf', '.raw', '.orf', '.rw2', '.pef',
]);
const DEDUP_JPG_EXTS = new Set(['.jpg', '.jpeg']);

const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif',
  '.nef', '.arw', '.sr2', '.srf', '.cr2', '.cr3', '.dng', '.raf', '.raw', '.orf', '.rw2', '.pef',
]);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.webm', '.mkv']);

function pathMatchesFileType(p, types) {
  const ext = nodePath.extname(p).toLowerCase();
  for (const t of types) {
    if (t === 'image' && IMAGE_EXTS.has(ext)) return true;
    if (t === 'video' && VIDEO_EXTS.has(ext)) return true;
    if (typeof t === 'string' && t.startsWith('.') && ext === t.toLowerCase()) return true;
  }
  return false;
}

function pathMatchesFolder(p, rootsArr, relPrefixes) {
  const norm = p.replace(/\\/g, '/');
  for (const root of rootsArr) {
    const r = root.replace(/\\/g, '/');
    if (!norm.startsWith(r + '/') && norm !== r) continue;
    const rel = norm.slice(r.length).replace(/^\//, '');
    for (const prefix of relPrefixes) {
      if (rel === prefix || rel.startsWith(prefix + '/')) return true;
    }
  }
  return false;
}

function generateId() {
  return require('crypto').randomBytes(8).toString('hex');
}

class AlbumStore {
  constructor(dbPath) {
    fs.mkdirSync(nodePath.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._createTables();
    this._migrate();
    this._filterCache = new Map();
  }

  _filterCacheKey(albumId, extras) {
    return albumId + ':' + JSON.stringify(extras);
  }

  _getCachedFilteredList(key) {
    return this._filterCache.get(key) || null;
  }

  _setCachedFilteredList(key, list) {
    this._filterCache.set(key, list);
  }

  invalidateFilterCache(albumId) {
    for (const k of this._filterCache.keys()) {
      if (k.startsWith(albumId + ':')) this._filterCache.delete(k);
    }
  }

  /**
   * Return the next `count` paths from the cached filtered list starting after `afterPath`.
   * Used for background preview pre-generation look-ahead.
   */
  getLookAheadPaths(albumId, { fileTypes = [], folderPaths = [], identities = [], dedup = false } = {}, roots = [], afterPath, count = 20) {
    const cacheKey = this._filterCacheKey(albumId, { fileTypes, folderPaths, identities, dedup, roots, type: 'shared' });
    const filteredIndex = this._getCachedFilteredList(cacheKey);
    if (!filteredIndex || filteredIndex.length === 0) return [];
    let startIdx = 0;
    if (afterPath) {
      const idx = filteredIndex.findIndex(r => r.path === afterPath);
      if (idx >= 0) startIdx = idx + 1;
    }
    return filteredIndex.slice(startIdx, startIdx + count).map(r => r.path);
  }

  _migrate() {
    const cols = this.db.pragma('table_info(media_items)').map((c) => c.name);
    if (!cols.includes('rotation')) {
      this.db.exec('ALTER TABLE media_items ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0');
    }
    if (!cols.includes('orientation_checked')) {
      this.db.exec('ALTER TABLE media_items ADD COLUMN orientation_checked INTEGER NOT NULL DEFAULT 0');
    }
    // Migrate per-album rotations to global media_rotations table
    this.db.exec(`
      INSERT OR IGNORE INTO media_rotations (path, rotation)
      SELECT path, rotation FROM media_items WHERE rotation != 0
    `);
    // Add per-image scan settings columns
    const fspCols = this.db.pragma('table_info(face_scanned_paths)').map((c) => c.name);
    if (!fspCols.includes('input_size')) {
      this.db.exec('ALTER TABLE face_scanned_paths ADD COLUMN input_size INTEGER');
      this.db.exec('ALTER TABLE face_scanned_paths ADD COLUMN min_confidence REAL');
      this.db.exec('ALTER TABLE face_scanned_paths ADD COLUMN distance_threshold REAL');
    }
  }

  _createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS albums (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS media_items (
        album_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        path TEXT NOT NULL,
        filename TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unswiped',
        assigned_to TEXT,
        rotation INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (album_id, path),
        FOREIGN KEY (album_id) REFERENCES albums(id)
      );

      CREATE INDEX IF NOT EXISTS idx_media_status
        ON media_items(album_id, status);
      CREATE INDEX IF NOT EXISTS idx_media_idx
        ON media_items(album_id, idx);

      CREATE TABLE IF NOT EXISTS media_rotations (
        path TEXT PRIMARY KEY,
        rotation INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS shared_choices (
        album_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        path TEXT NOT NULL,
        direction TEXT NOT NULL,
        swiped_at TEXT NOT NULL,
        PRIMARY KEY (album_id, device_id, path),
        FOREIGN KEY (album_id) REFERENCES albums(id)
      );

      CREATE TABLE IF NOT EXISTS shared_progress (
        album_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        last_index INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (album_id, device_id),
        FOREIGN KEY (album_id) REFERENCES albums(id)
      );

      CREATE TABLE IF NOT EXISTS cloud_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        account_id TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        quota_total INTEGER,
        quota_used INTEGER,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, account_id)
      );

      CREATE TABLE IF NOT EXISTS cloud_album_targets (
        album_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        media_scope TEXT NOT NULL,
        destination_folder_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (album_id, account_id),
        FOREIGN KEY (album_id) REFERENCES albums(id),
        FOREIGN KEY (account_id) REFERENCES cloud_accounts(id)
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_targets_album
        ON cloud_album_targets(album_id);

      CREATE TABLE IF NOT EXISTS cloud_upload_runs (
        id TEXT PRIMARY KEY,
        album_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        media_scope TEXT NOT NULL,
        target_account_ids TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        total_items INTEGER NOT NULL DEFAULT 0,
        uploaded_items INTEGER NOT NULL DEFAULT 0,
        failed_items INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        finished_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (album_id) REFERENCES albums(id)
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_runs_album
        ON cloud_upload_runs(album_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cloud_runs_status
        ON cloud_upload_runs(status, created_at DESC);

      CREATE TABLE IF NOT EXISTS cloud_upload_items (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        album_id TEXT NOT NULL,
        path TEXT NOT NULL,
        account_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        remote_file_id TEXT,
        remote_link TEXT,
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        file_size INTEGER,
        content_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        uploaded_at TEXT,
        UNIQUE(album_id, path, account_id),
        FOREIGN KEY (run_id) REFERENCES cloud_upload_runs(id),
        FOREIGN KEY (album_id) REFERENCES albums(id),
        FOREIGN KEY (account_id) REFERENCES cloud_accounts(id)
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_upload_items_run
        ON cloud_upload_items(run_id, state);
      CREATE INDEX IF NOT EXISTS idx_cloud_upload_items_album
        ON cloud_upload_items(album_id, state);

      CREATE TABLE IF NOT EXISTS cloud_notifications (
        id TEXT PRIMARY KEY,
        album_id TEXT,
        run_id TEXT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT,
        payload_json TEXT,
        state TEXT NOT NULL DEFAULT 'new',
        snooze_until TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (album_id) REFERENCES albums(id),
        FOREIGN KEY (run_id) REFERENCES cloud_upload_runs(id)
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_notifications_state
        ON cloud_notifications(state, created_at DESC);

      CREATE TABLE IF NOT EXISTS face_identities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        representative_descriptor BLOB,
        thumbnail_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS face_occurrences (
        id TEXT PRIMARY KEY,
        item_path TEXT NOT NULL,
        identity_id TEXT,
        descriptor BLOB NOT NULL,
        bbox_x REAL,
        bbox_y REAL,
        bbox_w REAL,
        bbox_h REAL,
        score REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (identity_id) REFERENCES face_identities(id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_face_occ_path
        ON face_occurrences(item_path);
      CREATE INDEX IF NOT EXISTS idx_face_occ_identity
        ON face_occurrences(identity_id);

      CREATE TABLE IF NOT EXISTS face_scanned_paths (
        path TEXT PRIMARY KEY,
        faces_found INTEGER NOT NULL DEFAULT 0,
        scanned_at TEXT NOT NULL,
        input_size INTEGER,
        min_confidence REAL,
        distance_threshold REAL
      );
    `);
  }

  // ---- Albums CRUD ----

  createAlbum(name, mode) {
    const id = generateId();
    const createdAt = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO albums (id, name, mode, created_at) VALUES (?, ?, ?, ?)',
    ).run(id, name, mode, createdAt);
    return { id, name, mode, createdAt };
  }

  deleteAlbum(id) {
    this.invalidateFilterCache(id);
    const del = this.db.transaction(() => {
      this.db.prepare('DELETE FROM cloud_notifications WHERE album_id = ?').run(id);
      this.db.prepare('DELETE FROM cloud_upload_items WHERE album_id = ?').run(id);
      this.db.prepare('DELETE FROM cloud_upload_runs WHERE album_id = ?').run(id);
      this.db.prepare('DELETE FROM cloud_album_targets WHERE album_id = ?').run(id);
      this.db.prepare('DELETE FROM shared_progress WHERE album_id = ?').run(id);
      this.db.prepare('DELETE FROM shared_choices WHERE album_id = ?').run(id);
      this.db.prepare('DELETE FROM media_items WHERE album_id = ?').run(id);
      this.db.prepare('DELETE FROM albums WHERE id = ?').run(id);
    });
    del();
  }

  getAlbumMeta(id) {
    return this.db.prepare(
      'SELECT id, name, mode, created_at as createdAt FROM albums WHERE id = ?',
    ).get(id) || null;
  }

  listDetailed() {
    return this.db.prepare(`
      SELECT a.id, a.name, a.mode, a.created_at as createdAt,
        COUNT(m.path) as totalItems,
        SUM(CASE WHEN m.status = 'selected' THEN 1 ELSE 0 END) as selectedCount,
        SUM(CASE WHEN m.status = 'discarded' THEN 1 ELSE 0 END) as discardedCount,
        SUM(CASE WHEN m.status IN ('selected','discarded') THEN 1 ELSE 0 END) as swipedCount,
        (
          SELECT COUNT(*)
          FROM cloud_upload_items cu
          WHERE cu.album_id = a.id AND cu.state = 'uploaded'
        ) as uploadedCopies
      FROM albums a
      LEFT JOIN media_items m ON a.id = m.album_id
      GROUP BY a.id
      ORDER BY a.created_at DESC
    `).all();
  }

  // ---- Bulk item insert (batched transactions for large sets) ----

  insertItems(albumId, paths, startIdx = 0) {
    this.invalidateFilterCache(albumId);
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO media_items (album_id, idx, path, filename, status) VALUES (?, ?, ?, ?, ?)',
    );
    const BATCH = 10000;
    for (let b = 0; b < paths.length; b += BATCH) {
      const end = Math.min(b + BATCH, paths.length);
      this.db.transaction(() => {
        for (let i = b; i < end; i++) {
          stmt.run(albumId, startIdx + i, paths[i], nodePath.basename(paths[i]), 'unswiped');
        }
      })();
    }
  }

  // ---- Counts ----

  getItemCount(albumId) {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM media_items WHERE album_id = ?',
    ).get(albumId);
    return row ? row.cnt : 0;
  }

  getCounts(albumId) {
    const rows = this.db.prepare(
      'SELECT status, COUNT(*) as cnt FROM media_items WHERE album_id = ? GROUP BY status',
    ).all(albumId);
    const counts = { all: 0, selected: 0, discarded: 0, unswiped: 0 };
    for (const r of rows) {
      if (r.status === 'assigned') {
        counts.unswiped += r.cnt;
      } else {
        counts[r.status] = (counts[r.status] || 0) + r.cnt;
      }
      counts.all += r.cnt;
    }
    return counts;
  }

  // ---- Paginated items (for album detail view) ----

  getItems(albumId, { filter = 'all', offset = 0, limit = 200, includeVotes = false, dedup = false } = {}) {
    const counts = this.getCounts(albumId);

    let statusClause = '';
    if (filter === 'selected') statusClause = "AND status = 'selected'";
    else if (filter === 'discarded') statusClause = "AND status = 'discarded'";
    else if (filter === 'unswiped') statusClause = "AND status IN ('unswiped','assigned')";

    if (dedup) {
      const cacheKey = this._filterCacheKey(albumId, { filter, dedup: true, type: 'items' });
      let deduped = this._getCachedFilteredList(cacheKey);
      if (!deduped) {
        const allRows = this.db.prepare(
          `SELECT m.path, m.filename, COALESCE(mr.rotation, 0) as rotation,
            CASE WHEN m.status = 'assigned' THEN 'unswiped' ELSE m.status END as status
          FROM media_items m
          LEFT JOIN media_rotations mr ON mr.path = m.path
          WHERE m.album_id = ? ${statusClause}
          ORDER BY m.idx`,
        ).all(albumId);
        deduped = AlbumStore.deduplicateRaw(allRows);
        this._setCachedFilteredList(cacheKey, deduped);
        console.log('[CACHE] items filter: ' + deduped.length + ' items (from ' + allRows.length + ')');
      }
      const filteredTotal = deduped.length;
      const items = deduped.slice(offset, offset + limit);

      if (includeVotes && items.length > 0) {
        this._attachVotes(albumId, items);
      }
      return { items, total: filteredTotal, counts, hasMore: offset + items.length < filteredTotal };
    }

    const totalRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM media_items WHERE album_id = ? ${statusClause}`,
    ).get(albumId);
    const filteredTotal = totalRow ? totalRow.cnt : 0;

    const items = this.db.prepare(
      `SELECT m.path, m.filename, COALESCE(mr.rotation, 0) as rotation,
        CASE WHEN m.status = 'assigned' THEN 'unswiped' ELSE m.status END as status
      FROM media_items m
      LEFT JOIN media_rotations mr ON mr.path = m.path
      WHERE m.album_id = ? ${statusClause}
      ORDER BY m.idx LIMIT ? OFFSET ?`,
    ).all(albumId, limit, offset);

    if (includeVotes && items.length > 0) {
      this._attachVotes(albumId, items);
    }

    return { items, total: filteredTotal, counts, hasMore: offset + items.length < filteredTotal };
  }

  // ---- Distributed mode ----

  assignNextUnassigned(albumId, deviceId) {
    return this.db.transaction(() => {
      const item = this.db.prepare(
        "SELECT m.path FROM media_items m WHERE m.album_id = ? AND m.status = 'unswiped' LIMIT 1",
      ).get(albumId);
      if (item) {
        this.db.prepare(
          "UPDATE media_items SET status = 'assigned', assigned_to = ? WHERE album_id = ? AND path = ?",
        ).run(deviceId, albumId, item.path);
        const rotation = this.getRotation(item.path);
        return { path: item.path, rotation, done: false };
      }
      const assigned = this.db.prepare(
        "SELECT COUNT(*) as cnt FROM media_items WHERE album_id = ? AND status = 'assigned'",
      ).get(albumId);
      const anyAssigned = assigned && assigned.cnt > 0;
      return { done: !anyAssigned, waiting: anyAssigned };
    })();
  }

  assignNextUnassignedFiltered(albumId, deviceId, { fileTypes = [], folderPaths = [], dedup = false } = {}, roots = []) {
    const hasFileFilter = Array.isArray(fileTypes) && fileTypes.length > 0;
    const hasFolderFilter = Array.isArray(folderPaths) && folderPaths.length > 0 && roots.length > 0;
    if (!hasFileFilter && !hasFolderFilter && !dedup) {
      return this.assignNextUnassigned(albumId, deviceId);
    }
    return this.db.transaction(() => {
      const cacheKey = this._filterCacheKey(albumId, { fileTypes, folderPaths, dedup, roots, type: 'shared' });
      let filteredIndex = this._getCachedFilteredList(cacheKey);

      if (!filteredIndex) {
        const rows = this.db.prepare(
          'SELECT idx, path, filename FROM media_items WHERE album_id = ? ORDER BY idx',
        ).all(albumId);
        let filtered = rows;
        if (hasFileFilter) filtered = filtered.filter((r) => pathMatchesFileType(r.path, fileTypes));
        if (hasFolderFilter) filtered = filtered.filter((r) => pathMatchesFolder(r.path, roots, folderPaths));
        if (dedup) filtered = AlbumStore.deduplicateRaw(filtered);
        filteredIndex = filtered;
        this._setCachedFilteredList(cacheKey, filteredIndex);
        console.log('[CACHE] shared filter: ' + filteredIndex.length + ' items (from ' + rows.length + ')');
      }

      const unswipedRows = this.db.prepare(
        "SELECT path FROM media_items WHERE album_id = ? AND status = 'unswiped'"
      ).all(albumId);

      const unswipedPaths = new Set(unswipedRows.map(r => r.path));
      const item = filteredIndex.find(r => unswipedPaths.has(r.path));

      if (item) {
        this.db.prepare(
          "UPDATE media_items SET status = 'assigned', assigned_to = ? WHERE album_id = ? AND path = ?",
        ).run(deviceId, albumId, item.path);
        return { path: item.path, rotation: this.getRotation(item.path), done: false };
      }

      if (unswipedRows.length === 0) {
        const assigned = this.db.prepare(
          "SELECT COUNT(*) as cnt FROM media_items WHERE album_id = ? AND status = 'assigned'",
        ).get(albumId);
        const anyAssigned = assigned && assigned.cnt > 0;
        return { done: !anyAssigned, waiting: anyAssigned };
      }
      return { done: true };
    })();
  }

  swipeDistributed(albumId, itemPath, direction, deviceId) {
    const newStatus = direction === 'right' ? 'selected' : 'discarded';
    return this.db.transaction(() => {
      const item = this.db.prepare(
        'SELECT status, assigned_to FROM media_items WHERE album_id = ? AND path = ?',
      ).get(albumId, itemPath);
      if (!item) return { ok: false, alreadySwipedByOther: true };
      if (item.status === 'selected' || item.status === 'discarded') {
        return { ok: false, alreadySwipedByOther: true };
      }
      if (item.status === 'assigned' && item.assigned_to !== deviceId) {
        return { ok: false, alreadySwipedByOther: true };
      }
      if (item.status === 'unswiped') {
        return { ok: false, alreadySwipedByOther: true };
      }
      this.db.prepare(
        'UPDATE media_items SET status = ?, assigned_to = NULL WHERE album_id = ? AND path = ?',
      ).run(newStatus, albumId, itemPath);
      return { ok: true };
    })();
  }

  releaseAssignments(albumId, deviceId) {
    const info = this.db.prepare(
      "UPDATE media_items SET status = 'unswiped', assigned_to = NULL WHERE album_id = ? AND assigned_to = ? AND status = 'assigned'",
    ).run(albumId, deviceId);
    return info.changes;
  }

  getSharedDevices(albumId) {
    return this.db.prepare(
      'SELECT DISTINCT device_id FROM shared_choices WHERE album_id = ? ORDER BY device_id',
    ).all(albumId).map(r => r.device_id);
  }

  // ---- Shared mode ----

  initSharedProgress(albumId, deviceId) {
    this.db.prepare(
      'INSERT OR IGNORE INTO shared_progress (album_id, device_id, last_index) VALUES (?, ?, 0)',
    ).run(albumId, deviceId);
  }

  getSharedProgress(albumId, deviceId) {
    this.initSharedProgress(albumId, deviceId);
    return this.db.prepare(
      'SELECT last_index as lastIndex FROM shared_progress WHERE album_id = ? AND device_id = ?',
    ).get(albumId, deviceId);
  }

  getSharedBatch(albumId, fromIndex, count, deviceId) {
    const items = this.db.prepare(
      `SELECT m.idx, m.path, m.filename, COALESCE(mr.rotation, 0) as rotation,
        CASE WHEN m.status = 'assigned' THEN 'unswiped' ELSE m.status END as status,
        COALESCE(sc.direction, '') as myChoice
      FROM media_items m
      LEFT JOIN media_rotations mr ON mr.path = m.path
      LEFT JOIN shared_choices sc ON sc.album_id = m.album_id AND sc.path = m.path AND sc.device_id = ?
      WHERE m.album_id = ? AND m.idx >= ? ORDER BY m.idx LIMIT ?`,
    ).all(deviceId || '', albumId, fromIndex, count);
    this._attachVotes(albumId, items);
    return items;
  }

  _attachVotes(albumId, items) {
    if (!items || items.length === 0) return;
    const paths = items.map(i => i.path);
    const placeholders = paths.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT device_id, path, direction FROM shared_choices
       WHERE album_id = ? AND path IN (${placeholders})`,
    ).all(albumId, ...paths);
    const voteMap = {};
    for (const r of rows) {
      if (!voteMap[r.path]) voteMap[r.path] = [];
      voteMap[r.path].push({ deviceId: r.device_id, direction: r.direction });
    }
    for (const item of items) {
      item.votes = voteMap[item.path] || [];
    }
  }

  /**
   * Deduplicate items when both RAW and JPG versions exist for the same base filename.
   * Keeps RAW, drops JPG. Items is an array of objects with `.path`.
   */
  static deduplicateRaw(items) {
    return AlbumStore.deduplicateRawWithContext(items, items);
  }

  static deduplicateRawWithContext(items, allAlbumItems) {
    const keyOf = (p) => {
      const dir = nodePath.dirname(p);
      const base = nodePath.basename(p, nodePath.extname(p));
      return dir + '/' + base.toLowerCase();
    };

    const rawKeys = new Set();
    for (const item of allAlbumItems) {
      const ext = nodePath.extname(item.path).toLowerCase();
      if (DEDUP_RAW_EXTS.has(ext)) rawKeys.add(keyOf(item.path));
    }

    if (rawKeys.size === 0) return items;

    const result = items.filter((item) => {
      const ext = nodePath.extname(item.path).toLowerCase();
      if (!DEDUP_JPG_EXTS.has(ext)) return true;
      return !rawKeys.has(keyOf(item.path));
    });

    const removed = items.length - result.length;
    if (removed > 0) console.log('[DEDUP] removed ' + removed + ' JPG duplicates (RAW keys=' + rawKeys.size + ', batch=' + items.length + ' -> ' + result.length + ')');
    return result;
  }

  /** Get all paths for an album (for computing filter options). */
  getAlbumPaths(albumId) {
    return this.db.prepare(
      'SELECT path FROM media_items WHERE album_id = ? ORDER BY idx',
    ).all(albumId).map((r) => r.path);
  }

  /**
   * Get batch of items for shared feed with optional filter.
   * fileTypes: array of 'image' | 'video' or extensions like '.jpg'
   * folderPaths: array of relative path prefixes (e.g. 'DCIM', '2024/01')
   * identities: array of identity IDs
   * roots: array of absolute root paths (registered folders)
   */
  getSharedBatchFiltered(albumId, fromIndex, count, { fileTypes = [], folderPaths = [], identities = [], dedup = false } = {}, roots = [], deviceId) {
    const cacheKey = this._filterCacheKey(albumId, { fileTypes, folderPaths, identities, dedup, roots, type: 'shared' });
    let filteredIndex = this._getCachedFilteredList(cacheKey);

    if (!filteredIndex) {
      const rows = this.db.prepare(
        'SELECT idx, path, filename FROM media_items WHERE album_id = ? ORDER BY idx',
      ).all(albumId);
      const hasFileFilter = Array.isArray(fileTypes) && fileTypes.length > 0;
      const hasFolderFilter = Array.isArray(folderPaths) && folderPaths.length > 0 && roots.length > 0;
      const hasIdentityFilter = Array.isArray(identities) && identities.length > 0;

      let identityPaths = null;
      if (hasIdentityFilter) {
        const placeholders = identities.map(() => '?').join(',');
        const faceRows = this.db.prepare(
          `SELECT DISTINCT item_path FROM face_occurrences WHERE identity_id IN (${placeholders})`
        ).all(...identities);
        identityPaths = new Set(faceRows.map(r => r.item_path));
      }

      let filtered = rows;
      if (hasFileFilter) filtered = filtered.filter((r) => pathMatchesFileType(r.path, fileTypes));
      if (hasFolderFilter) filtered = filtered.filter((r) => pathMatchesFolder(r.path, roots, folderPaths));
      if (hasIdentityFilter) filtered = filtered.filter((r) => identityPaths.has(r.path));

      if (dedup) filtered = AlbumStore.deduplicateRaw(filtered);
      filteredIndex = filtered;
      this._setCachedFilteredList(cacheKey, filteredIndex);
      console.log('[CACHE] shared filter: ' + filteredIndex.length + ' items (from ' + rows.length + ')');
    }

    const slice = filteredIndex.slice(fromIndex, fromIndex + count);
    if (slice.length === 0) return { items: slice, totalFiltered: filteredIndex.length };

    const pathSet = slice.map(s => s.path);
    const placeholders = pathSet.map(() => '?').join(',');
    const choiceRows = deviceId
      ? this.db.prepare(
        `SELECT path, direction FROM shared_choices WHERE album_id = ? AND device_id = ? AND path IN (${placeholders})`,
      ).all(albumId, deviceId, ...pathSet)
      : [];
    const choiceMap = new Map(choiceRows.map(c => [c.path, c.direction]));

    const items = slice.map(s => ({
      idx: s.idx,
      path: s.path,
      filename: s.filename,
      rotation: this.getRotation(s.path),
      status: 'unswiped',
      myChoice: choiceMap.get(s.path) || '',
    }));
    this._attachVotes(albumId, items);
    return { items, totalFiltered: filteredIndex.length };
  }

  _recalcSharedStatus(albumId, itemPath) {
    const choices = this.db.prepare(
      'SELECT direction FROM shared_choices WHERE album_id = ? AND path = ?',
    ).all(albumId, itemPath);
    let status = 'unswiped';
    if (choices.length > 0) {
      status = choices.some(c => c.direction === 'right') ? 'selected' : 'discarded';
    }
    this.db.prepare(
      'UPDATE media_items SET status = ? WHERE album_id = ? AND path = ?',
    ).run(status, albumId, itemPath);
  }

  swipeShared(albumId, itemPath, direction, deviceId) {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(
        'INSERT OR REPLACE INTO shared_choices (album_id, device_id, path, direction, swiped_at) VALUES (?, ?, ?, ?, ?)',
      ).run(albumId, deviceId, itemPath, direction, now);
      this._recalcSharedStatus(albumId, itemPath);
    })();
  }

  updateSharedProgress(albumId, deviceId, lastIndex) {
    this.db.prepare(
      'INSERT OR REPLACE INTO shared_progress (album_id, device_id, last_index) VALUES (?, ?, ?)',
    ).run(albumId, deviceId, lastIndex);
  }

  // ---- Reject (permanently discard) ----

  rejectItem(albumId, itemPath, deviceId) {
    return this.db.transaction(() => {
      const item = this.db.prepare(
        'SELECT status FROM media_items WHERE album_id = ? AND path = ?',
      ).get(albumId, itemPath);
      if (!item) return { ok: false };
      this.db.prepare(
        "UPDATE media_items SET status = 'discarded', assigned_to = NULL WHERE album_id = ? AND path = ?",
      ).run(albumId, itemPath);
      return { ok: true, status: 'discarded' };
    })();
  }

  // ---- Toggle selection ----

  toggleShared(albumId, itemPath, deviceId) {
    const now = new Date().toISOString();
    return this.db.transaction(() => {
      const existing = this.db.prepare(
        'SELECT direction FROM shared_choices WHERE album_id = ? AND device_id = ? AND path = ?',
      ).get(albumId, deviceId, itemPath);

      if (existing && existing.direction === 'right') {
        this.db.prepare(
          'DELETE FROM shared_choices WHERE album_id = ? AND device_id = ? AND path = ?',
        ).run(albumId, deviceId, itemPath);
      } else {
        this.db.prepare(
          'INSERT OR REPLACE INTO shared_choices (album_id, device_id, path, direction, swiped_at) VALUES (?, ?, ?, ?, ?)',
        ).run(albumId, deviceId, itemPath, 'right', now);
      }
      this._recalcSharedStatus(albumId, itemPath);

      const item = this.db.prepare(
        'SELECT status FROM media_items WHERE album_id = ? AND path = ?',
      ).get(albumId, itemPath);
      const selected = !(existing && existing.direction === 'right');
      return { ok: true, status: item ? item.status : 'unswiped', selected };
    })();
  }

  toggleDistributed(albumId, itemPath, deviceId) {
    return this.db.transaction(() => {
      const item = this.db.prepare(
        'SELECT status, assigned_to FROM media_items WHERE album_id = ? AND path = ?',
      ).get(albumId, itemPath);
      if (!item) return { ok: false };

      const newStatus = item.status === 'selected' ? 'assigned' : 'selected';
      this.db.prepare(
        'UPDATE media_items SET status = ?, assigned_to = ? WHERE album_id = ? AND path = ?',
      ).run(newStatus, newStatus === 'assigned' ? deviceId : null, albumId, itemPath);
      return { ok: true, status: newStatus, selected: newStatus === 'selected' };
    })();
  }

  // ---- Undo swipe ----

  undoShared(albumId, itemPath, deviceId) {
    return this.db.transaction(() => {
      const choice = this.db.prepare(
        'SELECT direction FROM shared_choices WHERE album_id = ? AND device_id = ? AND path = ?',
      ).get(albumId, deviceId, itemPath);
      if (!choice) return { ok: false, reason: 'no_choice' };

      this.db.prepare(
        'DELETE FROM shared_choices WHERE album_id = ? AND device_id = ? AND path = ?',
      ).run(albumId, deviceId, itemPath);

      this._recalcSharedStatus(albumId, itemPath);

      const progress = this.db.prepare(
        'SELECT last_index as lastIndex FROM shared_progress WHERE album_id = ? AND device_id = ?',
      ).get(albumId, deviceId);
      if (progress && progress.lastIndex > 0) {
        this.db.prepare(
          'UPDATE shared_progress SET last_index = ? WHERE album_id = ? AND device_id = ?',
        ).run(progress.lastIndex - 1, albumId, deviceId);
      }

      return { ok: true, newLastIndex: progress ? Math.max(0, progress.lastIndex - 1) : 0 };
    })();
  }

  undoDistributed(albumId, itemPath, deviceId) {
    return this.db.transaction(() => {
      const item = this.db.prepare(
        'SELECT status FROM media_items WHERE album_id = ? AND path = ?',
      ).get(albumId, itemPath);
      if (!item) return { ok: false, reason: 'not_found' };
      if (item.status !== 'selected' && item.status !== 'discarded') {
        return { ok: false, reason: 'not_swiped' };
      }
      this.db.prepare(
        "UPDATE media_items SET status = 'assigned', assigned_to = ? WHERE album_id = ? AND path = ?",
      ).run(deviceId, albumId, itemPath);
      return { ok: true };
    })();
  }

  // ---- Reclassify ----

  reclassify(albumId, itemPath, status) {
    this.invalidateFilterCache(albumId);
    const dbStatus = status === 'selected' ? 'selected' : 'discarded';
    this.db.prepare(
      'UPDATE media_items SET status = ?, assigned_to = NULL WHERE album_id = ? AND path = ?',
    ).run(dbStatus, albumId, itemPath);
  }

  // ---- Cloud accounts ----

  upsertCloudAccount({ provider, accountId, email, displayName = null, status = 'active' }) {
    const now = new Date().toISOString();
    const existing = this.db.prepare(
      'SELECT id FROM cloud_accounts WHERE provider = ? AND account_id = ?',
    ).get(provider, accountId);
    if (existing) {
      this.db.prepare(
        `UPDATE cloud_accounts
         SET email = ?, display_name = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      ).run(email, displayName, status, now, existing.id);
      return existing.id;
    }
    const id = generateId();
    this.db.prepare(
      `INSERT INTO cloud_accounts
       (id, provider, account_id, email, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, provider, accountId, email, displayName, status, now, now);
    return id;
  }

  listCloudAccounts({ search = '', status = '', sort = 'updated' } = {}) {
    const allowedSort = new Set(['updated', 'email', 'quotaFree']);
    const sortKey = allowedSort.has(sort) ? sort : 'updated';
    const where = [];
    const params = [];
    if (search) {
      where.push('(email LIKE ? OR account_id LIKE ? OR IFNULL(display_name, \'\') LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    let orderBy = 'updated_at DESC';
    if (sortKey === 'email') orderBy = 'email COLLATE NOCASE ASC';
    if (sortKey === 'quotaFree') orderBy = '(IFNULL(quota_total,0) - IFNULL(quota_used,0)) DESC, updated_at DESC';
    return this.db.prepare(
      `SELECT id, provider, account_id as accountId, email, display_name as displayName,
              status, quota_total as quotaTotal, quota_used as quotaUsed,
              last_error as lastError, created_at as createdAt, updated_at as updatedAt
       FROM cloud_accounts
       ${clause}
       ORDER BY ${orderBy}`,
    ).all(...params);
  }

  getCloudAccount(id) {
    return this.db.prepare(
      `SELECT id, provider, account_id as accountId, email, display_name as displayName,
              status, quota_total as quotaTotal, quota_used as quotaUsed,
              last_error as lastError, created_at as createdAt, updated_at as updatedAt
       FROM cloud_accounts WHERE id = ?`,
    ).get(id) || null;
  }

  setCloudAccountStatus(id, status, lastError = null) {
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE cloud_accounts SET status = ?, last_error = ?, updated_at = ? WHERE id = ?',
    ).run(status, lastError, now, id);
  }

  setCloudAccountQuota(id, quotaTotal, quotaUsed) {
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE cloud_accounts SET quota_total = ?, quota_used = ?, updated_at = ? WHERE id = ?',
    ).run(quotaTotal, quotaUsed, now, id);
  }

  deleteCloudAccount(id) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM cloud_album_targets WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM cloud_upload_items WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM cloud_accounts WHERE id = ?').run(id);
    })();
  }

  // ---- Cloud targets ----

  setCloudAlbumTargets(albumId, accountIds, mode, mediaScope) {
    const now = new Date().toISOString();
    const keep = new Set(accountIds);
    this.db.transaction(() => {
      const existing = this.db.prepare(
        'SELECT account_id as accountId, destination_folder_id as folderId FROM cloud_album_targets WHERE album_id = ?',
      ).all(albumId);
      for (const row of existing) {
        if (!keep.has(row.accountId) && !row.folderId) {
          this.db.prepare(
            'DELETE FROM cloud_album_targets WHERE album_id = ? AND account_id = ?',
          ).run(albumId, row.accountId);
        }
      }
      for (const accountId of accountIds) {
        this.db.prepare(
          `INSERT INTO cloud_album_targets
           (album_id, account_id, mode, media_scope, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(album_id, account_id) DO UPDATE
           SET mode = excluded.mode,
               media_scope = excluded.media_scope,
               updated_at = excluded.updated_at`,
        ).run(albumId, accountId, mode, mediaScope, now, now);
      }
    })();
  }

  updateCloudAlbumTargetFolder(albumId, accountId, destinationFolderId) {
    this.db.prepare(
      'UPDATE cloud_album_targets SET destination_folder_id = ?, updated_at = ? WHERE album_id = ? AND account_id = ?',
    ).run(destinationFolderId, new Date().toISOString(), albumId, accountId);
  }

  listCloudAlbumTargets(albumId) {
    return this.db.prepare(
      `SELECT t.album_id as albumId, t.account_id as accountId, t.mode, t.media_scope as mediaScope,
              t.destination_folder_id as destinationFolderId,
              a.email, a.account_id as accountExternalId, a.status as accountStatus
       FROM cloud_album_targets t
       JOIN cloud_accounts a ON a.id = t.account_id
       WHERE t.album_id = ?
       ORDER BY a.updated_at DESC`,
    ).all(albumId);
  }

  // ---- Cloud upload runs/items ----

  createCloudUploadRun({ albumId, mode, mediaScope, targetAccountIds }) {
    const id = generateId();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO cloud_upload_runs
       (id, album_id, mode, media_scope, target_account_ids, status, created_at, updated_at, started_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    ).run(id, albumId, mode, mediaScope, JSON.stringify(targetAccountIds || []), now, now, now);
    return id;
  }

  getCloudUploadRun(runId) {
    const row = this.db.prepare(
      `SELECT id, album_id as albumId, mode, media_scope as mediaScope, target_account_ids as targetAccountIds,
              status, total_items as totalItems, uploaded_items as uploadedItems, failed_items as failedItems,
              started_at as startedAt, finished_at as finishedAt, last_error as lastError,
              created_at as createdAt, updated_at as updatedAt
       FROM cloud_upload_runs WHERE id = ?`,
    ).get(runId);
    if (!row) return null;
    try { row.targetAccountIds = JSON.parse(row.targetAccountIds || '[]'); } catch { row.targetAccountIds = []; }
    return row;
  }

  listCloudUploadRuns({ status = '', limit = 30 } = {}) {
    const params = [];
    let where = '';
    if (status) {
      where = 'WHERE r.status = ?';
      params.push(status);
    }
    params.push(Math.min(200, Math.max(1, limit)));
    const rows = this.db.prepare(
      `SELECT r.id, r.album_id as albumId, r.mode, r.media_scope as mediaScope,
              r.target_account_ids as targetAccountIds, r.status,
              r.total_items as totalItems, r.uploaded_items as uploadedItems, r.failed_items as failedItems,
              r.started_at as startedAt, r.finished_at as finishedAt, r.last_error as lastError,
              r.created_at as createdAt, a.name as albumName
       FROM cloud_upload_runs r
       JOIN albums a ON a.id = r.album_id
       ${where}
       ORDER BY r.created_at DESC
       LIMIT ?`,
    ).all(...params);
    for (const r of rows) {
      try { r.targetAccountIds = JSON.parse(r.targetAccountIds || '[]'); } catch { r.targetAccountIds = []; }
    }
    return rows;
  }

  setCloudRunStatus(runId, status, lastError = null) {
    const now = new Date().toISOString();
    const finishedAt = ['completed', 'cancelled', 'failed'].includes(status) ? now : null;
    this.db.prepare(
      `UPDATE cloud_upload_runs
       SET status = ?, last_error = ?, updated_at = ?, finished_at = COALESCE(?, finished_at)
       WHERE id = ?`,
    ).run(status, lastError, now, finishedAt, runId);
  }

  updateCloudRunCounters(runId) {
    const row = this.db.prepare(
      `SELECT
         COUNT(*) as totalItems,
         SUM(CASE WHEN state = 'uploaded' THEN 1 ELSE 0 END) as uploadedItems,
         SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) as failedItems
       FROM cloud_upload_items WHERE run_id = ?`,
    ).get(runId);
    this.db.prepare(
      `UPDATE cloud_upload_runs
       SET total_items = ?, uploaded_items = ?, failed_items = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      row ? row.totalItems : 0,
      row ? row.uploadedItems : 0,
      row ? row.failedItems : 0,
      new Date().toISOString(),
      runId,
    );
  }

  enqueueCloudUploadItems(runId, albumId, items) {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      `INSERT INTO cloud_upload_items
       (id, run_id, album_id, path, account_id, state, file_size, content_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)
       ON CONFLICT(album_id, path, account_id) DO UPDATE
       SET run_id = excluded.run_id,
           state = CASE
                     WHEN cloud_upload_items.state = 'uploaded' THEN 'uploaded'
                     ELSE 'queued'
                   END,
           file_size = excluded.file_size,
           content_hash = excluded.content_hash,
           error_message = NULL,
           updated_at = excluded.updated_at`,
    );
    this.db.transaction(() => {
      for (const it of items) {
        stmt.run(generateId(), runId, albumId, it.path, it.accountId, it.fileSize || null, it.contentHash || null, now, now);
      }
    })();
    this.updateCloudRunCounters(runId);
  }

  listPendingCloudUploadItems(runId, limit = 50) {
    return this.db.prepare(
      `SELECT id, run_id as runId, album_id as albumId, path, account_id as accountId, state,
              remote_file_id as remoteFileId, remote_link as remoteLink,
              error_message as errorMessage, retry_count as retryCount,
              file_size as fileSize, content_hash as contentHash
       FROM cloud_upload_items
       WHERE run_id = ? AND state IN ('queued', 'failed', 'uploading')
       ORDER BY updated_at ASC
       LIMIT ?`,
    ).all(runId, Math.min(500, Math.max(1, limit)));
  }

  /** Reset items stuck in 'uploading' (e.g. after crash) so they can be retried. */
  resetStuckCloudUploadItems(runId, olderThanMs = 5 * 60 * 1000) {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const r = this.db.prepare(
      `UPDATE cloud_upload_items SET state = 'queued', error_message = NULL, updated_at = ? WHERE run_id = ? AND state = 'uploading' AND updated_at < ?`,
    ).run(new Date().toISOString(), runId, cutoff);
    return r.changes;
  }

  setCloudUploadItemState(itemId, state, { remoteFileId = null, remoteLink = null, errorMessage = null, incRetry = false } = {}) {
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE cloud_upload_items
       SET state = ?,
           remote_file_id = COALESCE(?, remote_file_id),
           remote_link = COALESCE(?, remote_link),
           error_message = ?,
           retry_count = retry_count + ?,
           uploaded_at = CASE WHEN ? = 'uploaded' THEN ? ELSE uploaded_at END,
           updated_at = ?
       WHERE id = ?`,
    ).run(
      state,
      remoteFileId,
      remoteLink,
      errorMessage,
      incRetry ? 1 : 0,
      state,
      now,
      now,
      itemId,
    );
  }

  getCloudUploadItemsByAlbum(albumId, { offset = 0, limit = 200 } = {}) {
    return this.db.prepare(
      `SELECT i.path, i.account_id as accountId, a.email, i.state, i.remote_link as remoteLink,
              i.error_message as errorMessage, i.updated_at as updatedAt
       FROM cloud_upload_items i
       JOIN cloud_accounts a ON a.id = i.account_id
       WHERE i.album_id = ?
       ORDER BY i.updated_at DESC
       LIMIT ? OFFSET ?`,
    ).all(albumId, Math.min(1000, Math.max(1, limit)), Math.max(0, offset));
  }

  getAlbumMediaPaths(albumId, mediaScope = 'all') {
    if (mediaScope === 'selected') {
      return this.db.prepare(
        "SELECT path FROM media_items WHERE album_id = ? AND status = 'selected' ORDER BY idx",
      ).all(albumId).map((r) => r.path);
    }
    return this.db.prepare(
      'SELECT path FROM media_items WHERE album_id = ? ORDER BY idx',
    ).all(albumId).map((r) => r.path);
  }

  getAlbumTopFolders(albumId, limit = 3) {
    const rows = this.db.prepare(
      'SELECT path FROM media_items WHERE album_id = ? ORDER BY idx LIMIT ?',
    ).all(albumId, Math.max(1, limit * 4));
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const p = r.path || '';
      const parts = p.split(/[\\/]/).filter(Boolean);
      if (parts.length >= 2) {
        const folder = parts[parts.length - 2];
        if (!seen.has(folder)) {
          seen.add(folder);
          out.push(folder);
          if (out.length >= limit) break;
        }
      }
    }
    return out;
  }

  getAlbumCloudCoverage(albumId) {
    const mediaRows = this.db.prepare(
      'SELECT path FROM media_items WHERE album_id = ?',
    ).all(albumId);
    const total = mediaRows.length;
    if (total === 0) {
      return { total, fullyBackedUp: 0, partial: 0, missing: 0, mode: null, targetCount: 0 };
    }

    const targets = this.db.prepare(
      'SELECT account_id as accountId, mode FROM cloud_album_targets WHERE album_id = ?',
    ).all(albumId);
    if (targets.length === 0) {
      return { total, fullyBackedUp: 0, partial: 0, missing: total, mode: null, targetCount: 0 };
    }

    const targetIds = new Set(targets.map((t) => t.accountId));
    const mode = targets[0].mode || 'duplicate';
    const uploadedRows = this.db.prepare(
      `SELECT path, account_id as accountId
       FROM cloud_upload_items
       WHERE album_id = ? AND state = 'uploaded'`,
    ).all(albumId);

    const uploadedByPath = new Map();
    for (const r of uploadedRows) {
      if (!targetIds.has(r.accountId)) continue;
      if (!uploadedByPath.has(r.path)) uploadedByPath.set(r.path, new Set());
      uploadedByPath.get(r.path).add(r.accountId);
    }

    let fullyBackedUp = 0;
    let partial = 0;
    for (const m of mediaRows) {
      const set = uploadedByPath.get(m.path) || new Set();
      if (mode === 'duplicate') {
        if (set.size >= targetIds.size) fullyBackedUp++;
        else if (set.size > 0) partial++;
      } else {
        if (set.size > 0) fullyBackedUp++;
      }
    }
    const missing = Math.max(0, total - fullyBackedUp - partial);
    return { total, fullyBackedUp, partial, missing, mode, targetCount: targetIds.size };
  }

  getAllAlbumsCloudCoverage() {
    const albums = this.db.prepare('SELECT id FROM albums').all();
    const out = {};
    for (const a of albums) out[a.id] = this.getAlbumCloudCoverage(a.id);
    return out;
  }

  // ---- Cloud notifications ----

  createCloudNotification({ albumId = null, runId = null, type, title, message = '', payload = null }) {
    const id = generateId();
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO cloud_notifications
       (id, album_id, run_id, type, title, message, payload_json, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
    ).run(id, albumId, runId, type, title, message, payload ? JSON.stringify(payload) : null, now, now);
    return id;
  }

  listCloudNotifications({ includeDismissed = false, limit = 100 } = {}) {
    const now = new Date().toISOString();
    const where = includeDismissed
      ? ''
      : "WHERE state != 'dismissed' AND (snooze_until IS NULL OR snooze_until <= ?)";
    const rows = this.db.prepare(
      `SELECT n.id, n.album_id as albumId, n.run_id as runId, n.type, n.title, n.message,
              n.payload_json as payloadJson, n.state, n.snooze_until as snoozeUntil,
              n.created_at as createdAt, n.updated_at as updatedAt, a.name as albumName
       FROM cloud_notifications n
       LEFT JOIN albums a ON a.id = n.album_id
       ${where}
       ORDER BY n.created_at DESC
       LIMIT ?`,
    ).all(...(includeDismissed ? [Math.min(500, Math.max(1, limit))] : [now, Math.min(500, Math.max(1, limit))]));
    for (const r of rows) {
      try { r.payload = r.payloadJson ? JSON.parse(r.payloadJson) : null; } catch { r.payload = null; }
      delete r.payloadJson;
    }
    return rows;
  }

  updateCloudNotificationState(id, action, snoozeUntil = null) {
    const now = new Date().toISOString();
    let state = 'opened';
    if (action === 'dismiss') state = 'dismissed';
    if (action === 'snooze') state = 'snoozed';
    this.db.prepare(
      'UPDATE cloud_notifications SET state = ?, snooze_until = ?, updated_at = ? WHERE id = ?',
    ).run(state, snoozeUntil, now, id);
  }

  dismissNotificationsByRunAndType(runId, type) {
    const now = new Date().toISOString();
    this.db.prepare(
      "UPDATE cloud_notifications SET state = 'dismissed', updated_at = ? WHERE run_id = ? AND type = ? AND state NOT IN ('dismissed')",
    ).run(now, runId, type);
  }

  // ---- Uploaded albums list ----

  listUploadedAlbums() {
    return this.db.prepare(
      `SELECT a.id, a.name, a.mode,
              t.destination_folder_id as folderId, t.mode as uploadMode,
              ca.email as accountEmail
       FROM cloud_album_targets t
       JOIN albums a ON a.id = t.album_id
       JOIN cloud_accounts ca ON ca.id = t.account_id
       WHERE t.destination_folder_id IS NOT NULL
       ORDER BY a.name`,
    ).all();
  }

  // ---- Rotation ----

  getRotation(itemPath) {
    const row = this.db.prepare(
      'SELECT rotation FROM media_rotations WHERE path = ?',
    ).get(itemPath);
    return row ? row.rotation : 0;
  }

  setRotation(itemPath, rotation) {
    const r = ((rotation % 4) + 4) % 4;
    if (r === 0) {
      this.db.prepare('DELETE FROM media_rotations WHERE path = ?').run(itemPath);
    } else {
      this.db.prepare(
        'INSERT OR REPLACE INTO media_rotations (path, rotation) VALUES (?, ?)',
      ).run(itemPath, r);
    }
    return r;
  }

  clearAllRotations() {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM media_rotations').run();
      this.db.prepare('UPDATE media_items SET rotation = 0').run();
      this.db.prepare('UPDATE media_items SET orientation_checked = 0').run();
    })();
  }

  // ---- Auto-orientation ----

  getUncheckedFromPaths(albumId, paths) {
    if (!paths || paths.length === 0) return [];
    const placeholders = paths.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT path FROM media_items
       WHERE album_id = ? AND orientation_checked = 0 AND path IN (${placeholders})`,
    ).all(albumId, ...paths);
  }

  getNextUncheckedPaths(albumId, limit = 15) {
    return this.db.prepare(
      `SELECT path FROM media_items
       WHERE album_id = ? AND orientation_checked = 0
       ORDER BY idx LIMIT ?`,
    ).all(albumId, limit).map(r => r.path);
  }

  markOrientationChecked(albumId, itemPath, rotation) {
    if (rotation != null && rotation !== 0) {
      this.setRotation(itemPath, rotation);
    }
    this.db.prepare(
      'UPDATE media_items SET orientation_checked = 1 WHERE album_id = ? AND path = ?',
    ).run(albumId, itemPath);
  }

  // ---- Face Recognition ----

  /**
   * Create a new face identity.
   * @param {string} name
   * @param {Buffer|null} descriptor - face embedding buffer (float32s)
   * @param {string|null} thumbnailPath
   * @returns {{ id: string, name: string }}
   */
  createIdentity(name, descriptor = null, thumbnailPath = null) {
    const id = generateId();
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO face_identities (id, name, representative_descriptor, thumbnail_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, name || '', descriptor, thumbnailPath, now, now);
    return { id, name: name || '' };
  }

  /**
   * Update an existing identity.
   */
  updateIdentity(id, { name, descriptor, thumbnailPath } = {}) {
    const now = new Date().toISOString();
    const fields = [];
    const values = [];
    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (descriptor !== undefined) { fields.push('representative_descriptor = ?'); values.push(descriptor); }
    if (thumbnailPath !== undefined) { fields.push('thumbnail_path = ?'); values.push(thumbnailPath); }
    if (fields.length === 0) return;
    fields.push('updated_at = ?');
    values.push(now, id);
    this.db.prepare(
      `UPDATE face_identities SET ${fields.join(', ')} WHERE id = ?`,
    ).run(...values);
  }

  /**
   * Delete an identity. Face occurrences get identity_id set to NULL (ON DELETE SET NULL).
   */
  deleteIdentity(id) {
    this.db.prepare('DELETE FROM face_identities WHERE id = ?').run(id);
  }

  /**
   * Merge two identities: move all occurrences from removeId to keepId, then delete removeId.
   */
  mergeIdentities(keepId, removeId) {
    this.db.transaction(() => {
      this.db.prepare(
        'UPDATE face_occurrences SET identity_id = ? WHERE identity_id = ?',
      ).run(keepId, removeId);
      this.db.prepare('DELETE FROM face_identities WHERE id = ?').run(removeId);
    })();
  }

  /**
   * List all identities with occurrence counts.
   */
  listIdentities() {
    return this.db.prepare(`
      SELECT fi.id, fi.name, fi.thumbnail_path as thumbnailPath,
        fi.created_at as createdAt, fi.updated_at as updatedAt,
        COUNT(fo.id) as occurrenceCount
      FROM face_identities fi
      LEFT JOIN face_occurrences fo ON fo.identity_id = fi.id
      GROUP BY fi.id
      ORDER BY occurrenceCount DESC, fi.name ASC
    `).all();
  }

  /**
   * Get a single identity by ID.
   */
  getIdentity(id) {
    return this.db.prepare(
      'SELECT id, name, representative_descriptor as descriptor, thumbnail_path as thumbnailPath, created_at as createdAt, updated_at as updatedAt FROM face_identities WHERE id = ?',
    ).get(id) || null;
  }

  /**
   * Get a single identity with its descriptor as a Float32Array.
   */
  getIdentityWithDescriptor(id) {
    const row = this.getIdentity(id);
    if (!row) return null;
    if (row.descriptor && row.descriptor.length > 0) {
      row.descriptor = new Float32Array(row.descriptor.buffer, row.descriptor.byteOffset, row.descriptor.byteLength / 4);
    }
    return row;
  }

  /**
   * Insert a face occurrence record.
   * @param {string} itemPath
   * @param {Float32Array} descriptor - face embedding descriptor
   * @param {{ x: number, y: number, width: number, height: number }} box
   * @param {number} score - Detection confidence
   * @param {string|null} identityId
   * @returns {string} - The new occurrence ID
   */
  insertFaceOccurrence(itemPath, descriptor, box, score, identityId = null) {
    const id = generateId();
    const now = new Date().toISOString();
    const descBuf = Buffer.from(descriptor.buffer, descriptor.byteOffset, descriptor.byteLength);
    this.db.prepare(
      'INSERT INTO face_occurrences (id, item_path, identity_id, descriptor, bbox_x, bbox_y, bbox_w, bbox_h, score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, itemPath, identityId, descBuf, box.x, box.y, box.width, box.height, score, now);
    return id;
  }

  /**
   * Bulk insert face occurrences in a transaction.
   */
  insertFaceOccurrencesBulk(occurrences) {
    const stmt = this.db.prepare(
      'INSERT INTO face_occurrences (id, item_path, identity_id, descriptor, bbox_x, bbox_y, bbox_w, bbox_h, score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const now = new Date().toISOString();
    const BATCH = 5000;
    for (let b = 0; b < occurrences.length; b += BATCH) {
      const end = Math.min(b + BATCH, occurrences.length);
      this.db.transaction(() => {
        for (let i = b; i < end; i++) {
          const occ = occurrences[i];
          const occId = generateId();
          const descBuf = Buffer.from(occ.descriptor.buffer, occ.descriptor.byteOffset, occ.descriptor.byteLength);
          stmt.run(occId, occ.itemPath, occ.identityId || null, descBuf,
            occ.box.x, occ.box.y, occ.box.width, occ.box.height, occ.score || 0, now);
        }
      })();
    }
  }

  /**
 * Check if a given item_path already has face occurrences.
 * Matches by stem (ignores extension) so that scanning a JPG
 * also covers its RAW companion (e.g., DSC05320.JPG → DSC05320.ARW).
 */
  hasScannedFaces(itemPath) {
    const exact = this.db.prepare(
      'SELECT 1 FROM face_scanned_paths WHERE path = ?',
    ).get(itemPath);
    if (exact) return true;
    const stem = itemPath.replace(/\.[^./\\]+$/, '');
    const stemRow = this.db.prepare(
      "SELECT 1 FROM face_scanned_paths WHERE path LIKE ? ESCAPE '\\'",
    ).get(stem.replace(/%/g, '\\%').replace(/_/g, '\\_') + '.%');
    return !!stemRow;
  }

  markFaceScanned(itemPath, facesFound, scanSettings) {
    const s = scanSettings || {};
    this.db.prepare(
      'INSERT OR REPLACE INTO face_scanned_paths (path, faces_found, scanned_at, input_size, min_confidence, distance_threshold) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(itemPath, facesFound, new Date().toISOString(), s.inputSize || null, s.minConfidence || null, s.distanceThreshold || null);
  }

  markFaceScannedBulk(items) {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO face_scanned_paths (path, faces_found, scanned_at) VALUES (?, ?, ?)',
    );
    const now = new Date().toISOString();
    this.db.transaction(() => {
      for (const { path: p, facesFound } of items) {
        stmt.run(p, facesFound, now);
      }
    })();
  }

  getFaceScannedCount() {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM face_scanned_paths').get();
    return row ? row.cnt : 0;
  }

  getScanSettings(itemPath) {
    const exact = this.db.prepare(
      'SELECT input_size, min_confidence, distance_threshold FROM face_scanned_paths WHERE path = ?',
    ).get(itemPath);
    if (exact && exact.input_size != null) return exact;
    const stem = itemPath.replace(/\.[^./\\]+$/, '');
    const likePattern = stem.replace(/%/g, '\\%').replace(/_/g, '\\_') + '.%';
    return this.db.prepare(
      "SELECT input_size, min_confidence, distance_threshold FROM face_scanned_paths WHERE path LIKE ? ESCAPE '\\' AND input_size IS NOT NULL LIMIT 1",
    ).get(likePattern) || null;
  }

  /**
   * Load all scanned paths into memory for fast O(1) lookups.
   * Returns { exactPaths: Set<string>, stems: Set<string> }.
   */
  getScannedPathSets() {
    const rows = this.db.prepare('SELECT path FROM face_scanned_paths').all();
    const exactPaths = new Set();
    const stems = new Set();
    for (const r of rows) {
      exactPaths.add(r.path);
      stems.add(r.path.replace(/\.[^./\\]+$/, ''));
    }
    return { exactPaths, stems, count: rows.length };
  }

  /**
 * Get all face occurrences for a media item.
 * Matches by stem (ignores extension) so faces detected on a JPG
 * are also returned when querying the companion RAW path.
 */
  getItemFaces(itemPath) {
    let rows;
    // Try exact match first
    const exact = this.db.prepare(
      `SELECT fo.id, fo.item_path as itemPath, fo.identity_id as identityId,
      fo.bbox_x as bboxX, fo.bbox_y as bboxY, fo.bbox_w as bboxW, fo.bbox_h as bboxH,
      fo.score, fi.name as identityName, fi.thumbnail_path as identityThumbnail
    FROM face_occurrences fo
    LEFT JOIN face_identities fi ON fi.id = fo.identity_id
    WHERE fo.item_path = ?`,
    ).all(itemPath);
    if (exact.length > 0) {
      rows = exact;
    } else {
      // Stem match: pick ONE companion file to avoid doubles when multiple
      // extensions exist (e.g. .jpg + .JPG, or leftover rescan duplicates)
      const stem = itemPath.replace(/\.[^./\\]+$/, '');
      const likePattern = stem.replace(/%/g, '\\%').replace(/_/g, '\\_') + '.%';
      const matchPath = this.db.prepare(
        `SELECT item_path FROM face_occurrences WHERE item_path LIKE ? ESCAPE '\\' LIMIT 1`,
      ).get(likePattern);
      if (!matchPath) return [];
      rows = this.db.prepare(
        `SELECT fo.id, fo.item_path as itemPath, fo.identity_id as identityId,
        fo.bbox_x as bboxX, fo.bbox_y as bboxY, fo.bbox_w as bboxW, fo.bbox_h as bboxH,
        fo.score, fi.name as identityName, fi.thumbnail_path as identityThumbnail
      FROM face_occurrences fo
      LEFT JOIN face_identities fi ON fi.id = fo.identity_id
      WHERE fo.item_path = ?`,
      ).all(matchPath.item_path);
    }
    // Dedup: keep only one occurrence per unique bbox (handles duplicate inserts)
    const seen = new Set();
    return rows.filter(r => {
      const key = `${r.bboxX}|${r.bboxY}|${r.bboxW}|${r.bboxH}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Get all item paths that contain a given identity.
   */
  getItemsForIdentity(identityId) {
    return this.db.prepare(
      'SELECT DISTINCT item_path as path FROM face_occurrences WHERE identity_id = ? ORDER BY item_path',
    ).all(identityId).map(r => r.path);
  }

  /**
   * Get face occurrences with no identity assigned.
   */
  getUnidentifiedOccurrences(limit = 100) {
    return this.db.prepare(
      `SELECT id, item_path as itemPath, bbox_x as bboxX, bbox_y as bboxY,
        bbox_w as bboxW, bbox_h as bboxH, score
      FROM face_occurrences WHERE identity_id IS NULL
      ORDER BY created_at LIMIT ?`,
    ).all(limit);
  }

  /**
   * Get all occurrences with parsed descriptors for clustering.
   */
  getAllDescriptors() {
    const rows = this.db.prepare(
      'SELECT id, item_path as itemPath, identity_id as identityId, descriptor FROM face_occurrences',
    ).all();
    return rows.map((r) => ({
      id: r.id,
      itemPath: r.itemPath,
      identityId: r.identityId,
      descriptor: new Float32Array(r.descriptor.buffer, r.descriptor.byteOffset, r.descriptor.byteLength / 4),
    }));
  }

  /**
   * Get all identities with parsed descriptors for matching.
   */
  getAllIdentityDescriptors() {
    const rows = this.db.prepare(
      'SELECT id, name, representative_descriptor as descriptor FROM face_identities WHERE representative_descriptor IS NOT NULL',
    ).all();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      descriptor: new Float32Array(r.descriptor.buffer, r.descriptor.byteOffset, r.descriptor.byteLength / 4),
    }));
  }

  /**
   * Assign an identity to a face occurrence.
   */
  setOccurrenceIdentity(occurrenceId, identityId) {
    this.db.prepare(
      'UPDATE face_occurrences SET identity_id = ? WHERE id = ?',
    ).run(identityId, occurrenceId);
  }

  /**
   * Bulk assign identity to multiple occurrences.
   */
  setOccurrencesIdentity(occurrenceIds, identityId) {
    if (!occurrenceIds || occurrenceIds.length === 0) return;
    const stmt = this.db.prepare(
      'UPDATE face_occurrences SET identity_id = ? WHERE id = ?',
    );
    this.db.transaction(() => {
      for (const occId of occurrenceIds) {
        stmt.run(identityId, occId);
      }
    })();
  }

  /**
   * Get total face-related stats.
   */
  getFaceStats() {
    const totalOccurrences = this.db.prepare('SELECT COUNT(*) as cnt FROM face_occurrences').get().cnt;
    const totalIdentities = this.db.prepare('SELECT COUNT(*) as cnt FROM face_identities').get().cnt;
    const unidentified = this.db.prepare('SELECT COUNT(*) as cnt FROM face_occurrences WHERE identity_id IS NULL').get().cnt;
    const scannedPaths = this.db.prepare('SELECT COUNT(DISTINCT item_path) as cnt FROM face_occurrences').get().cnt;
    return { totalOccurrences, totalIdentities, unidentified, scannedPaths };
  }

  /**
   * Get an occurrence by ID with its descriptor.
   */
  getOccurrence(occurrenceId) {
    const row = this.db.prepare(
      `SELECT id, item_path as itemPath, identity_id as identityId, descriptor,
        bbox_x as bboxX, bbox_y as bboxY, bbox_w as bboxW, bbox_h as bboxH, score
      FROM face_occurrences WHERE id = ?`,
    ).get(occurrenceId);
    if (!row) return null;
    row.descriptor = new Float32Array(row.descriptor.buffer, row.descriptor.byteOffset, row.descriptor.byteLength / 4);
    return row;
  }

  /**
   * Delete all face occurrences (used when re-scanning).
   */
  clearAllFaceData() {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM face_occurrences').run();
      this.db.prepare('DELETE FROM face_identities').run();
      this.db.prepare('DELETE FROM face_scanned_paths').run();
    })();
  }

  // ---- Cleanup ----

  close() {
    if (this.db && this.db.open) this.db.close();
  }
}

// Self-test dedup on module load
(function () {
  const test = [
    { path: '/dir/DSC001.ARW' },
    { path: '/dir/DSC001.JPG' },
    { path: '/dir/DSC002.JPG' },
    { path: '/dir/DSC003.arw' },
    { path: '/dir/DSC003.jpg' },
    { path: '/dir/video.mp4' },
  ];
  let result = AlbumStore.deduplicateRaw(test);
  let names = result.map(i => nodePath.basename(i.path));
  console.log('[DEDUP SELF-TEST] deduplicateRaw: input=' + test.length + ' output=' + result.length + ' result=' + JSON.stringify(names));
  if (result.length !== 4) console.error('[DEDUP SELF-TEST] deduplicateRaw FAILED! Expected 4 items');

  // Test contextual dedup: RAW already assigned, JPG still unswiped
  const allItems = [
    { path: '/dir/DSC001.ARW' },
    { path: '/dir/DSC001.JPG' },
    { path: '/dir/DSC002.JPG' },
  ];
  const batch = [
    { path: '/dir/DSC001.JPG' },
    { path: '/dir/DSC002.JPG' },
  ];
  result = AlbumStore.deduplicateRawWithContext(batch, allItems);
  names = result.map(i => nodePath.basename(i.path));
  console.log('[DEDUP SELF-TEST] withContext: input=' + batch.length + ' output=' + result.length + ' result=' + JSON.stringify(names));
  if (result.length !== 1 || names[0] !== 'DSC002.JPG') console.error('[DEDUP SELF-TEST] withContext FAILED! Expected [DSC002.JPG]');
})();

module.exports = { AlbumStore, generateId };
