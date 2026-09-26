/**
 * store.test.mjs — dedup, 10-day window and pruning behaviour.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-store-'));
  return new Store({ file: path.join(dir, 'state.json') });
}

const item = (over = {}) => ({
  treeId: '1154',
  newsId: '142501',
  title: '关于放假的通知',
  url: 'http://my.bupt.edu.cn/x',
  date: '2026-09-25',
  source: '校内通知',
  ...over,
});

test('keyOf combines treeId and newsId', () => {
  assert.equal(Store.keyOf(item()), '1154:142501');
  // Same newsId in a different column is a different item.
  assert.notEqual(Store.keyOf(item()), Store.keyOf(item({ treeId: '2001' })));
});

test('an item is forwarded only after markForwarded, not by markSeen', () => {
  const s = tmpStore();
  assert.equal(s.isForwarded(item()), false, 'unknown item is not forwarded');

  s.markSeen(item());
  assert.equal(s.has(item()), true, 'seen');
  assert.equal(s.isForwarded(item()), false, 'seen alone must NOT count as forwarded (email may have failed)');

  s.markForwarded(item());
  assert.equal(s.isForwarded(item()), true);
});

test('markSeen is idempotent and preserves firstSeenAt', () => {
  const s = tmpStore();
  const t1 = new Date(2026, 8, 25, 10, 0, 0);
  const t2 = new Date(2026, 8, 25, 12, 0, 0);
  s.markSeen(item(), t1);
  s.markSeen(item(), t2);
  const rec = s.get(item());
  assert.equal(rec.firstSeenAt, t1.toISOString());
  assert.equal(rec.lastSeenAt, t2.toISOString());
  assert.equal(s.size, 1);
});

test('prune drops records older than the window on both axes', () => {
  const s = tmpStore();
  const today = '2026-09-25';
  // 5 days old: inside the window → kept
  s.markForwarded(item({ newsId: '1', date: '2026-09-20' }), new Date(2026, 8, 20));
  // 40 days old publish + 40 days old record → purged
  s.markForwarded(item({ newsId: '2', date: '2026-08-01' }), new Date(2026, 7, 1));
  // Undated but recorded today → kept (cannot prove it is old)
  s.markForwarded(item({ newsId: '3', date: null }), new Date(2026, 8, 25));

  const removed = s.prune({ windowDays: 10, today });
  assert.equal(removed, 1, 'exactly one stale record purged');
  assert.equal(s.has(item({ newsId: '1' })), true);
  assert.equal(s.has(item({ newsId: '2' })), false);
  assert.equal(s.has(item({ newsId: '3' })), true, 'undated record recorded today survives');
});

test('records survive a save/load round trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-store-'));
  const file = path.join(dir, 'state.json');

  const a = new Store({ file });
  a.markForwarded(item());
  a.recordRun({ at: '2026-09-25T10:00:00Z', ok: true, newItems: 1 });
  a.save();

  const b = new Store({ file });
  assert.equal(b.isForwarded(item()), true, 'forwarded flag persisted');
  assert.equal(b.size, 1);
  assert.equal(b.lastRun.newItems, 1, 'run history persisted');
});

test('a corrupted state file degrades to empty instead of crashing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-store-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{ this is not json', 'utf8');
  const s = new Store({ file });
  assert.equal(s.size, 0);
  assert.equal(s.isForwarded(item()), false);
});

test('inWindow reports only records inside the window', () => {
  const s = tmpStore();
  s.markSeen(item({ newsId: '1', date: '2026-09-24' }));
  s.markSeen(item({ newsId: '2', date: '2026-01-01' }));
  const inWin = s.inWindow({ windowDays: 10, today: '2026-09-25' });
  assert.equal(inWin.length, 1);
  assert.equal(inWin[0].newsId, '1');
});
