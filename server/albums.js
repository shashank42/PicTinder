const nodePath = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

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
        PRIMARY KEY (album_id, path),
        FOREIGN KEY (album_id) REFERENCES albums(id)
      );

      CREATE INDEX IF NOT EXISTS idx_media_status
        ON media_items(album_id, status);
      CREATE INDEX IF NOT EXISTS idx_media_idx
        ON media_items(album_id, idx);

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
    const del = this.db.transaction(() => {
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
        SUM(CASE WHEN m.status IN ('selected','discarded') THEN 1 ELSE 0 END) as swipedCount
      FROM albums a
      LEFT JOIN media_items m ON a.id = m.album_id
      GROUP BY a.id
      ORDER BY a.created_at DESC
    `).all();
  }

  // ---- Bulk item insert (batched transactions for large sets) ----

  insertItems(albumId, paths, startIdx = 0) {
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

  getItems(albumId, { filter = 'all', offset = 0, limit = 200, includeVotes = false } = {}) {
    const counts = this.getCounts(albumId);

    let statusClause = '';
    if (filter === 'selected') statusClause = "AND status = 'selected'";
    else if (filter === 'discarded') statusClause = "AND status = 'discarded'";
    else if (filter === 'unswiped') statusClause = "AND status IN ('unswiped','assigned')";

    const totalRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM media_items WHERE album_id = ? ${statusClause}`,
    ).get(albumId);
    const filteredTotal = totalRow ? totalRow.cnt : 0;

    const items = this.db.prepare(
      `SELECT path, filename,
        CASE WHEN status = 'assigned' THEN 'unswiped' ELSE status END as status
      FROM media_items WHERE album_id = ? ${statusClause}
      ORDER BY idx LIMIT ? OFFSET ?`,
    ).all(albumId, limit, offset);

    if (includeVotes && items.length > 0) {
      const placeholders = items.map(() => '?').join(',');
      const itemPaths = items.map(i => i.path);
      const rows = this.db.prepare(
        `SELECT device_id, path, direction FROM shared_choices
         WHERE album_id = ? AND path IN (${placeholders})`,
      ).all(albumId, ...itemPaths);

      const voteMap = {};
      for (const r of rows) {
        if (!voteMap[r.path]) voteMap[r.path] = [];
        voteMap[r.path].push({ deviceId: r.device_id, direction: r.direction });
      }
      for (const item of items) {
        item.votes = voteMap[item.path] || [];
      }
    }

    return { items, total: filteredTotal, counts, hasMore: offset + items.length < filteredTotal };
  }

  // ---- Distributed mode ----

  assignNextUnassigned(albumId, deviceId) {
    return this.db.transaction(() => {
      const item = this.db.prepare(
        "SELECT path FROM media_items WHERE album_id = ? AND status = 'unswiped' LIMIT 1",
      ).get(albumId);
      if (item) {
        this.db.prepare(
          "UPDATE media_items SET status = 'assigned', assigned_to = ? WHERE album_id = ? AND path = ?",
        ).run(deviceId, albumId, item.path);
        return { path: item.path, done: false };
      }
      const assigned = this.db.prepare(
        "SELECT COUNT(*) as cnt FROM media_items WHERE album_id = ? AND status = 'assigned'",
      ).get(albumId);
      const anyAssigned = assigned && assigned.cnt > 0;
      return { done: !anyAssigned, waiting: anyAssigned };
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

  getSharedBatch(albumId, fromIndex, count) {
    return this.db.prepare(
      'SELECT idx, path, filename FROM media_items WHERE album_id = ? AND idx >= ? ORDER BY idx LIMIT ?',
    ).all(albumId, fromIndex, count);
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
    const dbStatus = status === 'selected' ? 'selected' : 'discarded';
    this.db.prepare(
      'UPDATE media_items SET status = ?, assigned_to = NULL WHERE album_id = ? AND path = ?',
    ).run(dbStatus, albumId, itemPath);
  }

  // ---- Cleanup ----

  close() {
    if (this.db && this.db.open) this.db.close();
  }
}

module.exports = { AlbumStore, generateId };
