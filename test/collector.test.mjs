/**
 * collector.test.mjs — end-to-end windowing + dedup, with a fake browser session.
 *
 * This covers the core requirement: only items from the last N days are ever
 * forwarded, and nothing is forwarded twice.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAll, withinWindow, derivePageBudget, fetchTarget, HARD_MAX_PAGES } from '../src/collector.js';
import { Store } from '../src/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const listHtml = fs.readFileSync(path.join(here, 'fixtures/notice-list.html'), 'utf8');
const loginHtml = fs.readFileSync(path.join(here, 'fixtures/login-page.html'), 'utf8');
/** Real captured response: unauthenticated list.jsp → clogin.jsp error shell. */
const authRequiredHtml = fs.readFileSync(path.join(here, 'fixtures/portal-auth-required.html'), 'utf8');
const AUTH_URL = 'http://my.bupt.edu.cn/system/resource/code/auth/clogin.jsp?owner=1664271694';

const NOW = new Date(2026, 8, 25); // 2026-09-25

function makeCfg(over = {}) {
  return {
    baseUrl: 'http://my.bupt.edu.cn/',
    windowDays: 10,
    maxPages: 1,
    targets: [
      { key: 'notice', name: '校内通知', treeId: '1154', path: 'list.jsp?wbtreeid=1154', url: 'http://my.bupt.edu.cn/list.jsp?wbtreeid=1154' },
      { key: 'document', name: '校内文件', treeId: '2001', path: 'list.jsp?wbtreeid=2001', url: 'http://my.bupt.edu.cn/list.jsp?wbtreeid=2001' },
    ],
    output: { mode: 'local', localDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-col-')) },
    email: { enabled: false },
    ...over,
  };
}

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-store-'));
  return new Store({ file: path.join(dir, 'state.json') });
}

/** Minimal stand-in for PortalSession. */
function fakeSession() {
  return {
    calls: [],
    async fetchHtml(url) {
      this.calls.push(url);
      return { html: listHtml, status: 200, finalUrl: url };
    },
  };
}

test('withinWindow is inclusive at both ends', () => {
  const o = { windowDays: 10, today: '2026-09-25' };
  assert.equal(withinWindow('2026-09-25', o), true, 'today');
  assert.equal(withinWindow('2026-09-15', o), true, 'exactly 10 days ago');
  assert.equal(withinWindow('2026-09-14', o), false, '11 days ago');
  assert.equal(withinWindow('2026-09-26', o), false, 'future date excluded');
  assert.equal(withinWindow(null, o), null, 'unknown date');
});

test('first run returns only in-window items from each column', async () => {
  const cfg = makeCfg();
  const store = tmpStore();
  const { items, stats, loginRequired } = await collectAll(fakeSession(), cfg, store, { now: NOW });

  assert.equal(loginRequired, false);

  // 校内通知 (1154): 142501 (09-25), 142488 (09-24), 142480 (09-18), 142000 (undated)
  //   136000 (2025-12-01) is outside the window.
  const notice = items.filter((i) => i.treeId === '1154').map((i) => i.newsId).sort();
  assert.deepEqual(notice, ['142000', '142480', '142488', '142501']);
  assert.ok(!notice.includes('136000'), 'old item excluded by the window');

  // 校内文件 (2001): 142490 (09-23)
  const doc = items.filter((i) => i.treeId === '2001').map((i) => i.newsId);
  assert.deepEqual(doc, ['142490']);

  assert.equal(stats.undatedNew, 1, 'the undated item counted as new-once');
  assert.equal(items.length, 5);
});

test('after forwarding, a second run reports nothing new', async () => {
  const cfg = makeCfg();
  const store = tmpStore();

  const first = await collectAll(fakeSession(), cfg, store, { now: NOW });
  assert.equal(first.items.length, 5);

  // Simulate the email/local write succeeding.
  for (const it of first.items) store.markForwarded(it, NOW);
  store.prune({ windowDays: cfg.windowDays, today: '2026-09-25' });

  const second = await collectAll(fakeSession(), cfg, store, { now: NOW });
  assert.equal(second.items.length, 0, 'nothing forwarded twice');
  assert.equal(second.stats.alreadyForwarded, 5);
});

test('a failed delivery leaves items eligible for retry', async () => {
  const cfg = makeCfg();
  const store = tmpStore();

  const first = await collectAll(fakeSession(), cfg, store, { now: NOW });
  // Email failed → markSeen only, never markForwarded.
  for (const it of first.items) store.markSeen(it, NOW);

  const second = await collectAll(fakeSession(), cfg, store, { now: NOW });
  assert.equal(second.items.length, 5, 'all five retried after a failed delivery');
});

test('a state file persisted to disk still suppresses re-forwarding', async () => {
  const cfg = makeCfg();
  const store = tmpStore();

  const first = await collectAll(fakeSession(), cfg, store, { now: NOW });
  for (const it of first.items) store.markForwarded(it, NOW);
  store.save();

  // Fresh Store instance, as after a reboot.
  const reloaded = new Store({ file: store.file });
  const second = await collectAll(fakeSession(), cfg, reloaded, { now: NOW });
  assert.equal(second.items.length, 0, 'dedup survives a restart');
});

test('an item that ages out of the window is not re-forwarded', async () => {
  const cfg = makeCfg();
  const store = tmpStore();

  const first = await collectAll(fakeSession(), cfg, store, { now: NOW });
  for (const it of first.items) store.markForwarded(it, NOW);
  store.prune({ windowDays: cfg.windowDays, today: '2026-09-25' });

  // 20 days later: the same page still lists 142501, but it is now out of window
  // AND its record is older than the window, so it must not be emailed again.
  const later = new Date(2026, 9, 15); // 2026-10-15
  const second = await collectAll(fakeSession(), cfg, store, { now: later });
  assert.equal(second.items.length, 0, 'no re-forward after the window advances');
});

test('a login interstitial aborts the run with loginRequired', async () => {
  const cfg = makeCfg();
  const store = tmpStore();
  const session = {
    async fetchHtml(url) {
      return { html: loginHtml, status: 200, finalUrl: url };
    },
  };

  const { items, loginRequired, errors } = await collectAll(session, cfg, store, { now: NOW });
  assert.equal(loginRequired, true);
  assert.equal(items.length, 0);
  assert.ok(errors.length >= 1, 'reports why');
});

test('the portal error shell after clogin.jsp triggers re-login, not "template changed"', async () => {
  const cfg = makeCfg();
  const store = tmpStore();
  // Exactly what the live portal returns for list.jsp without a session:
  // HTTP 200, final URL is clogin.jsp, body is the "系统发生错误" shell.
  const session = {
    async fetchHtml() {
      return { html: authRequiredHtml, status: 200, finalUrl: AUTH_URL };
    },
  };

  const { items, loginRequired, errors } = await collectAll(session, cfg, store, { now: NOW });

  assert.equal(loginRequired, true, 'must ask for a fresh login');
  assert.equal(items.length, 0);
  assert.ok(
    !errors.some((e) => /模板/.test(e)),
    `must NOT report a template change, got: ${JSON.stringify(errors)}`,
  );
});

test('a page with no parsable items is reported, not silently accepted', async () => {
  const cfg = makeCfg();
  const store = tmpStore();
  const session = {
    async fetchHtml(url) {
      return { html: '<html><body><p>页面模板可能已变更</p></body></html>', status: 200, finalUrl: url };
    },
  };

  const { items, loginRequired, errors } = await collectAll(session, cfg, store, { now: NOW });
  assert.equal(loginRequired, false, 'an empty page is not a login page');
  assert.equal(items.length, 0);
  assert.ok(errors.length >= 1, 'templates changing is surfaced in errors');
});

/* ------------------------- pagination & the window ------------------------- */

/**
 * 「只看最近多少天」 can only be effective if the collector can actually reach
 * older items, i.e. if it follows pagination. It could not: the page number was
 * mis-read from `totalpage=18` and query-only paging links were resolved against
 * the portal root, so every run silently read page 1 only — and the window
 * setting changed nothing beyond the newest 20 items per column.
 *
 * These tests pin the control flow: page N+1 is fetched only while page N still
 * contains in-window items, and it must be the LIST page that is re-requested.
 */

/** 20 items per page, newest first, one day apart, starting `offset` days back. */
function pageHtml({ page, totalPages, treeId, offsetStart }) {
  const base = new Date(2026, 8, 25); // same day as NOW
  const rows = [];
  for (let i = 0; i < 20; i += 1) {
    const d = new Date(base);
    d.setDate(d.getDate() - (offsetStart + i));
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const id = 900000 + (page - 1) * 20 + i;
    rows.push(
      `<li><a href="http://my.bupt.edu.cn/content.jsp?urltype=news.NewsContentUrl&wbtreeid=${treeId}&wbnewsid=${id}">` +
        `第 ${page} 页第 ${i + 1} 条 <span>${iso}</span></a></li>`,
    );
  }
  // The paging block as the portal really writes it (see list-pagination.html).
  const pager = [2, 3, 4, 5]
    .filter((p) => p <= totalPages)
    .map(
      (p) =>
        `<a href="?totalpage=${totalPages}&PAGENUM=${p}&urltype=tree.TreeTempUrl&wbtreeid=${treeId}">${p}</a>`,
    )
    .join('');
  return `<html><body><div class="tabinfo"><ul>${rows.join('')}</ul></div><div class="pagedown">${pager}</div></body></html>`;
}

/** Serves the generated pages and remembers which URLs were requested. */
function pagedSession({ treeId = '2001', totalPages = 5 } = {}) {
  return {
    calls: [],
    async fetchHtml(url) {
      this.calls.push(url);
      const query = url.split('?')[1] || '';
      const page = Number((query.match(/[?&]?PAGENUM=(\d+)/i) || [])[1] || 1);
      return {
        html: pageHtml({ page, totalPages, treeId, offsetStart: (page - 1) * 20 }),
        status: 200,
        finalUrl: url,
      };
    },
  };
}

function pagedCfg(windowDays) {
  return makeCfg({
    windowDays,
    maxPages: 3,
    targets: [
      {
        key: 'document',
        name: '校内文件',
        treeId: '2001',
        path: 'list.jsp?wbtreeid=2001',
        url: 'http://my.bupt.edu.cn/list.jsp?urltype=tree.TreeTempUrl&wbtreeid=2001',
      },
    ],
  });
}

test('derivePageBudget grows with the window and stays bounded', () => {
  assert.equal(derivePageBudget(3, 10), 3, 'a normal window keeps maxPages');
  assert.equal(derivePageBudget(3, 30), 3);
  assert.equal(derivePageBudget(3, 90), 3);
  assert.equal(derivePageBudget(3, 200), 7, '~one page per month');
  assert.equal(derivePageBudget(3, 365), HARD_MAX_PAGES, 'bounded, never unbounded');
  assert.equal(derivePageBudget(1, 365), HARD_MAX_PAGES, 'the window may raise maxPages');
  assert.equal(derivePageBudget(50, 10), HARD_MAX_PAGES, 'an explicit larger maxPages still honours the ceiling');
  assert.equal(derivePageBudget(0, 0), 1, 'never zero pages');
});

test('a narrow window reads only page 1 and keeps only in-window items', async () => {
  const session = pagedSession();
  const { items, stats } = await collectAll(session, pagedCfg(10), tmpStore(), { now: NOW });

  assert.equal(session.calls.length, 1, 'page 1 is already older than the window → stop');
  assert.equal(items.length, 11, 'offsets 0..10 — the window is inclusive at both ends');
  assert.ok(items.every((i) => i.date >= '2026-09-15'), 'nothing older than the window');
  assert.equal(stats.targets.document.pages, 1);
});

test('a wide window walks the pages it needs — and no further', async () => {
  const session = pagedSession();
  const { items, stats } = await collectAll(session, pagedCfg(45), tmpStore(), { now: NOW });

  assert.equal(session.calls.length, 3, 'page 3 is the first one that reaches past the window');
  assert.equal(stats.targets.document.pages, 3);
  // Page 2's request must go back to the LIST page, not the portal root.
  assert.ok(session.calls[1].includes('/list.jsp'), `page 2 URL: ${session.calls[1]}`);
  assert.ok(session.calls[1].includes('PAGENUM=2'), 'page 2 URL still asks for page 2');
  assert.ok(!/^http:\/\/my\.bupt\.edu\.cn\/\?/.test(session.calls[1]), 'never the portal root');
  // 45 days inclusive = items at offsets 0..45 = 46 items.
  assert.equal(items.length, 46);
  const dates = items.map((i) => i.date).sort();
  assert.equal(dates[0], '2026-08-11', 'oldest item is exactly at the window edge');
});

test('every item returned is inside the window, whatever the window is', async () => {
  for (const days of [1, 10, 45, 120]) {
    const { items } = await collectAll(pagedSession(), pagedCfg(days), tmpStore(), { now: NOW });
    const outside = items.filter((i) => withinWindow(i.date, { windowDays: days, today: '2026-09-25' }) !== true);
    assert.equal(outside.length, 0, `windowDays=${days} leaked ${JSON.stringify(outside.map((i) => i.date))}`);
  }
});

test('maxPages is a floor for a wide window, and an explicit page count wins', async () => {
  // cfg.maxPages = 3 cannot satisfy a 365-day window (one page ≈ one month), so
  // the budget grows — otherwise the window setting would silently return only
  // the newest 60 items per column.
  const session = pagedSession({ totalPages: 5 });
  const { stats } = await collectAll(session, pagedCfg(365), tmpStore(), { now: NOW });
  assert.equal(stats.targets.document.pages, 5, 'reads every existing page');
  assert.equal(session.calls.length, 5);

  // The per-call option is a hard override (used by tests and diagnostics).
  const capped = pagedSession({ totalPages: 5 });
  const r = await fetchTarget(capped, pagedCfg(365).targets[0], pagedCfg(365), {
    now: NOW,
    maxPages: 2,
  });
  assert.equal(capped.calls.length, 2, 'explicit maxPages=2 is honoured exactly');
  assert.equal(r.pages, 2);
  assert.equal(r.items.length, 40, 'two pages of 20');
});
