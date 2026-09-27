/**
 * store.js — local dedup state.
 *
 * Requirement: remember which notices/files were already forwarded within the
 * last 10 days, and never forward them again.
 *
 * Key design decisions:
 *  - The identity of an item is `treeId:newsId`, taken straight from the VSB URL
 *    (`...&wbtreeid=2001&wbnewsid=141749`). This is stable across page re-orderings,
 *    title edits and re-renders, unlike a title hash.
 *  - An item is marked forwarded ONLY after the email actually succeeds, so a
 *    failed send is retried on the next run instead of being silently dropped.
 *  - Records are purged once they are older than the window on both axes
 *    (publish date and time we recorded it), which keeps the file tiny while
 *    still guaranteeing no re-forward inside the window.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, readJson, writeJsonAtomic, todayLocal, daysBetween, parseDate } from './util.js';

export const STATE_PATH = path.join(DATA_DIR, 'state.json');
const STATE_VERSION = 1;
const MAX_ENTRIES = 5000;

function emptyState() {
  return { version: STATE_VERSION, updatedAt: null, seen: {}, lastRuns: [], meta: {} };
}

export class Store {
  constructor({ file = STATE_PATH } = {}) {
    this.file = file;
    this.state = readJson(file, null) || emptyState();
    if (this.state.version !== STATE_VERSION) {
      // Forward-compatible: keep whatever we can read.
      this.state.version = STATE_VERSION;
    }
    if (!this.state.seen || typeof this.state.seen !== 'object') this.state.seen = {};
    /** mtime when we last read/wrote the file, used by reloadIfChanged(). */
    this.loadedMtimeMs = undefined;
    try {
      this.loadedMtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      /* file does not exist yet */
    }
  }

  /** Static identity string for an item. */
  static keyOf(item) {
    return `${item.treeId}:${item.newsId}`;
  }

  has(item) {
    return Object.prototype.hasOwnProperty.call(this.state.seen, Store.keyOf(item));
  }

  /** True only when the item was seen AND the email was delivered. */
  isForwarded(item) {
    const rec = this.state.seen[Store.keyOf(item)];
    return Boolean(rec && rec.forwardedAt);
  }

  get(item) {
    return this.state.seen[Store.keyOf(item)] || null;
  }

  /** Record that we saw an item (idempotent). Does not imply it was emailed. */
  markSeen(item, now = new Date()) {
    const key = Store.keyOf(item);
    const prev = this.state.seen[key];
    if (prev) {
      prev.lastSeenAt = now.toISOString();
      if (item.title && !prev.title) prev.title = item.title;
      return prev;
    }
    const rec = {
      treeId: item.treeId,
      newsId: item.newsId,
      title: item.title || '',
      date: item.date || null,
      url: item.url || '',
      source: item.source || '',
      firstSeenAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      forwardedAt: null,
    };
    this.state.seen[key] = rec;
    return rec;
  }

  /** Mark an item as successfully forwarded. */
  markForwarded(item, now = new Date()) {
    const rec = this.markSeen(item, now);
    rec.forwardedAt = now.toISOString();
    return rec;
  }

  /**
   * Drop records that have fallen out of the window on both the publish date
   * and the date we first recorded them, then cap total size.
   */
  prune({ windowDays = 10, today = todayLocal() } = {}) {
    const seen = this.state.seen;
    let removed = 0;

    for (const [key, rec] of Object.entries(seen)) {
      const byPublish = rec.date ? daysBetween(rec.date, today) : null;
      const bySeen = daysBetween((rec.firstSeenAt || '').slice(0, 10), today);
      const publishStale = byPublish === null ? true : byPublish > windowDays;
      const seenStale = bySeen === null ? true : bySeen > windowDays;
      if (publishStale && seenStale) {
        delete seen[key];
        removed += 1;
      }
    }

    // Hard cap: drop the oldest-first records if the file somehow grows huge.
    const keys = Object.keys(seen);
    if (keys.length > MAX_ENTRIES) {
      keys
        .sort((a, b) => String(seen[a].firstSeenAt).localeCompare(String(seen[b].firstSeenAt)))
        .slice(0, keys.length - MAX_ENTRIES)
        .forEach((k) => {
          delete seen[k];
          removed += 1;
        });
    }

    return removed;
  }

  recordRun(summary) {
    this.state.lastRuns.unshift(summary);
    this.state.lastRuns = this.state.lastRuns.slice(0, 20);
  }

  get lastRun() {
    return this.state.lastRuns[0] || null;
  }

  /* --------------------------- generic key/value --------------------------- */

  /** Small persisted bag for odds and ends (auth backoff, UI prefs, …). */
  getMeta(key, fallback = null) {
    const bag = this.state.meta;
    return bag && Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : fallback;
  }

  setMeta(key, value) {
    if (!this.state.meta || typeof this.state.meta !== 'object') this.state.meta = {};
    this.state.meta[key] = value;
    return value;
  }

  save() {
    this.state.updatedAt = new Date().toISOString();
    writeJsonAtomic(this.file, this.state);
    try {
      this.loadedMtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      /* ignore */
    }
  }

  /**
   * Re-read the state file when another process changed it.
   *
   * Under the default 'task' schedule every run is a SEPARATE short-lived
   * process, so an open control panel would otherwise keep showing whatever its
   * own instance last saw. The panel polls every couple of seconds, so this only
   * touches the disk when the file's mtime actually moved.
   *
   * @returns {boolean} true when fresh data was loaded
   */
  reloadIfChanged() {
    let mtime;
    try {
      mtime = fs.statSync(this.file).mtimeMs;
    } catch {
      return false; // no file yet
    }
    if (this.loadedMtimeMs !== undefined && mtime === this.loadedMtimeMs) return false;

    const fresh = readJson(this.file, null);
    if (!fresh || typeof fresh !== 'object') return false;
    this.state = fresh;
    if (this.state.version !== STATE_VERSION) this.state.version = STATE_VERSION;
    if (!this.state.seen || typeof this.state.seen !== 'object') this.state.seen = {};
    this.loadedMtimeMs = mtime;
    return true;
  }

  get size() {
    return Object.keys(this.state.seen).length;
  }

  /** All records whose publish date falls inside the window (for diagnostics). */
  inWindow({ windowDays = 10, today = todayLocal() } = {}) {
    return Object.values(this.state.seen).filter((rec) => {
      if (!rec.date || !parseDate(rec.date)) return true;
      const d = daysBetween(rec.date, today);
      return d !== null && d <= windowDays;
    });
  }
}
