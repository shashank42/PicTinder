'use strict';

const { isImageFile } = require('./face-rotation');

const WINDOW_SIZE = 15;
const MAX_QUEUE_SIZE = 50;
const PROCESS_DELAY_MS = 50;

class OrientationQueue {
  constructor({ albumStore, detectFn, onResult, onLog }) {
    this._albumStore = albumStore;
    this._detectFn = detectFn;
    this._onResult = onResult;
    this._onLog = onLog || (() => {});
    this._queue = [];
    this._seen = new Set();
    this._processing = false;
    this._processedCount = 0;
    this._modelReady = false;
  }

  /**
   * Enqueue a window of paths for background face-rotation detection.
   * Filters to unchecked image files and takes the first WINDOW_SIZE.
   */
  enqueueWindow(albumId, paths) {
    if (!paths || paths.length === 0) return;

    const unchecked = [];
    for (const p of paths) {
      const key = `${albumId}:${p}`;
      if (this._seen.has(key)) continue;
      if (!isImageFile(p)) continue;
      unchecked.push(p);
      if (unchecked.length >= WINDOW_SIZE) break;
    }

    if (unchecked.length === 0) return;

    const checkedSet = new Set(
      this._albumStore.getUncheckedFromPaths(albumId, unchecked).map(r => r.path),
    );

    let added = 0;
    for (const p of unchecked) {
      if (!checkedSet.has(p)) continue;
      const key = `${albumId}:${p}`;
      if (this._seen.has(key)) continue;
      this._seen.add(key);
      this._queue.push({ albumId, path: p, priority: 0 });
      added++;
    }

    if (added > 0) {
      this._onLog(`🧠 Queued ${added} images for face orientation check`);
      this._evictIfNeeded();
      this._scheduleProcess();
    }
  }

  /**
   * Enqueue upcoming unchecked items from an album directly from DB.
   * Used for distributed mode where we don't have a batch of paths from the client.
   */
  enqueueAlbumWindow(albumId) {
    const paths = this._albumStore.getNextUncheckedPaths(albumId, WINDOW_SIZE);
    if (!paths || paths.length === 0) return;
    let added = 0;
    for (const p of paths) {
      const key = `${albumId}:${p}`;
      if (this._seen.has(key)) continue;
      if (!isImageFile(p)) continue;
      this._seen.add(key);
      this._queue.push({ albumId, path: p, priority: 0 });
      added++;
    }
    if (added > 0) {
      this._onLog(`🧠 Queued ${added} images for face orientation check`);
      this._evictIfNeeded();
      this._scheduleProcess();
    }
  }

  /**
   * Promote a specific path to the front of the queue (high priority).
   * If not already queued, inserts at front if unchecked.
   */
  promote(albumId, path) {
    if (!path || !isImageFile(path)) return;

    const key = `${albumId}:${path}`;

    const idx = this._queue.findIndex(
      (item) => item.albumId === albumId && item.path === path,
    );

    if (idx >= 0) {
      const [item] = this._queue.splice(idx, 1);
      item.priority = 1;
      this._queue.unshift(item);
    } else if (!this._seen.has(key)) {
      const unchecked = this._albumStore.getUncheckedFromPaths(albumId, [path]);
      if (unchecked.length > 0) {
        this._seen.add(key);
        this._queue.unshift({ albumId, path, priority: 1 });
        this._evictIfNeeded();
      }
    }

    this._scheduleProcess();
  }

  _evictIfNeeded() {
    while (this._queue.length > MAX_QUEUE_SIZE) {
      let evictIdx = -1;
      for (let i = this._queue.length - 1; i >= 0; i--) {
        if (this._queue[i].priority === 0) { evictIdx = i; break; }
      }
      if (evictIdx === -1) evictIdx = this._queue.length - 1;
      this._queue.splice(evictIdx, 1);
    }
  }

  _scheduleProcess() {
    if (this._processing) return;
    this._processing = true;
    setTimeout(() => this._processNext(), PROCESS_DELAY_MS);
  }

  async _processNext() {
    if (this._queue.length === 0) {
      this._processing = false;
      return;
    }

    const item = this._queue.shift();
    const filename = require('path').basename(item.path);
    try {
      if (!this._modelReady) {
        this._onLog('🧠 Face detection model loading…');
      }
      const rotation = await this._detectFn(item.path);
      if (!this._modelReady) {
        this._modelReady = true;
        this._onLog('🧠 Face detection model ready for inference');
      }
      this._processedCount++;
      this._albumStore.markOrientationChecked(item.albumId, item.path, rotation);
      if (rotation != null && rotation !== 0) {
        this._onResult(item.albumId, item.path, rotation);
        if (this._processedCount <= 5) {
          const rotLabel = ['0°', '90° CW', '180°', '270° CW'][rotation] || `${rotation}`;
          this._onLog(`🔄 Auto-rotated ${filename} → ${rotLabel}`);
        }
      } else if (this._processedCount <= 5) {
        this._onLog(`🔄 Checked ${filename} — ${rotation === null ? 'no faces' : 'already upright'}`);
      }
    } catch (err) {
      console.warn('[orientation-queue] Error processing', item.path, err.message);
      try {
        this._albumStore.markOrientationChecked(item.albumId, item.path, null);
      } catch {}
    }

    setTimeout(() => this._processNext(), PROCESS_DELAY_MS);
  }
}

module.exports = { OrientationQueue };
