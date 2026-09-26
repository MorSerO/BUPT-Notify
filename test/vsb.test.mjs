/**
 * vsb.test.mjs — parser unit tests, run with `npm test` (node --test).
 * All tests are offline and use fixtures derived from real portal markup.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseListPage,
  extractPaginationLinks,
  pageNumberOf,
  looksLikeLoginPage,
  extractArticle,
  makeYearInferrer,
  normaliseUrl,
  classifyPage,
  PAGE,
  isAuthUrl,
} from '../src/vsb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const listHtml = fs.readFileSync(path.join(here, 'fixtures/notice-list.html'), 'utf8');
/** The real paging block: `?totalpage=18&PAGENUM=2&…&wbtreeid=2001`. */
const pagingHtml = fs.readFileSync(path.join(here, 'fixtures/list-pagination.html'), 'utf8');
const LIST_URL = 'http://my.bupt.edu.cn/list.jsp?urltype=tree.TreeTempUrl&wbtreeid=2001';
const loginHtml = fs.readFileSync(path.join(here, 'fixtures/login-page.html'), 'utf8');
/** Real response captured from the portal: list.jsp while unauthenticated. */
const authRequiredHtml = fs.readFileSync(path.join(here, 'fixtures/portal-auth-required.html'), 'utf8');
const AUTH_URL = 'http://my.bupt.edu.cn/system/resource/code/auth/clogin.jsp?owner=1664271694';
/** Real response captured live from the CAS server (auth.bupt.edu.cn). */
const casLiveHtml = fs.readFileSync(path.join(here, 'fixtures/cas-login-skeleton.html'), 'utf8');
const CAS_URL =
  'https://auth.bupt.edu.cn/authserver/login?service=http%3A%2F%2Fmy.bupt.edu.cn%3A80%2Fsystem%2Fresource%2Fcode%2Fauth%2Fclogin.jsp%3Fowner%3D1664271694';

/** Fixed "now" so window/date assertions never depend on the clock. */
const NOW = new Date(2026, 8, 25); // 2026-09-25

test('parses items and dedups the headline card (same newsId appears 3x)', () => {
  const items = parseListPage(listHtml, { now: NOW, treeId: '1154', source: '校内通知' });

  // newsid 142501 appears in 3 anchors but must yield exactly one item.
  const dup = items.filter((i) => i.newsId === '142501');
  assert.equal(dup.length, 1, 'headline card must dedup to one item');
  assert.equal(dup[0].title, '关于2026年国庆节放假安排的通知');
  assert.equal(dup[0].date, '2026-09-25');
  assert.equal(dup[0].key, '1154:142501');
});

test('treeId filter keeps only the requested column', () => {
  const items = parseListPage(listHtml, { now: NOW, treeId: '1154' });
  assert.ok(items.length > 0);
  assert.ok(
    items.every((i) => i.treeId === '1154'),
    'no items from other columns (e.g. 2001) may leak in',
  );
  assert.ok(!items.some((i) => i.newsId === '142490'), '2001 item must be excluded');
});

/* --------- container columns (verified against the live portal) ---------- */

/**
 * 校内通知 (list.jsp?wbtreeid=1154) is a CONTAINER: it aggregates 12
 * sub-columns, and NONE of the 20 articles on the page carries wbtreeid=1154 —
 * they are 1158, 1787, 2182, 1736, 1741, 2149, 1764, 2157, 1771, 1645, 2170,
 * 1752. A strict treeId filter discarded the whole column, which is exactly the
 * bug that made 校内通知 look permanently empty while 校内文件 worked.
 */
const CONTAINER_HTML = `
<html><head><title>校内通知</title></head><body>
  <a class="clogout" href="/system/resource/code/auth/clogout.jsp">退出</a>
  <ul class="listnotice">
    <li><a href="http://my.bupt.edu.cn/xntz_content.jsp?urltype=news.NewsContentUrl&amp;wbtreeid=1158&amp;wbnewsid=138177">第一条通知<span>2026-09-24</span></a></li>
    <li><a href="http://my.bupt.edu.cn/xntz_content.jsp?urltype=news.NewsContentUrl&amp;wbtreeid=1764&amp;wbnewsid=142451">第二条通知<span>2026-09-24</span></a></li>
    <li><a href="http://my.bupt.edu.cn/xntz_content.jsp?urltype=news.NewsContentUrl&amp;wbtreeid=2149&amp;wbnewsid=142462">第三条通知<span>2026-09-23</span></a></li>
  </ul>
</body></html>`;

test('a container column is not emptied by the treeId filter', () => {
  const items = parseListPage(CONTAINER_HTML, { now: NOW, treeId: '1154', source: '校内通知' });
  assert.equal(items.length, 3, 'all articles on a container page must be kept');
  // Keys still use each article's OWN treeId, which is what stays stable.
  assert.deepEqual(items.map((i) => i.key).sort(), ['1158:138177', '1764:142451', '2149:142462']);
});

test('a container column still excludes unrelated content pages', () => {
  // The portal root aggregates many columns; the homepage fixture has items for
  // 1154 itself, so the strict branch applies there and must still filter.
  const items = parseListPage(listHtml, { now: NOW, treeId: '1154' });
  assert.ok(items.every((i) => i.treeId === '1154'));
});

test('container behaviour is adaptive, not unconditional', () => {
  // Page HAS the configured column -> filter to it.
  const strict = parseListPage(listHtml, { now: NOW, treeId: '2001' });
  assert.equal(strict.length, 1);
  assert.equal(strict[0].key, '2001:142490');
  // Page does NOT have it -> keep what the page offers.
  const container = parseListPage(CONTAINER_HTML, { now: NOW, treeId: '2001' });
  assert.equal(container.length, 3);
});

test('resolves ISO, arcdate and year-less MM-DD dates', () => {
  const items = parseListPage(listHtml, { now: NOW, treeId: '1154' });
  const byId = Object.fromEntries(items.map((i) => [i.newsId, i]));
  assert.equal(byId['142501'].date, '2026-09-25', 'ISO date from hidden anchor');
  assert.equal(byId['142488'].date, '2026-09-24', 'ISO date on plain item');
  assert.equal(byId['136000'].date, '2025-12-01', 'old item keeps its date');
  assert.equal(byId['142480'].date, '2026-09-18', 'year-less MM-DD with inferred year');
});

test('an item with no date is returned with date === null, not dropped', () => {
  const items = parseListPage(listHtml, { now: NOW, treeId: '1154' });
  const undated = items.find((i) => i.newsId === '142000');
  assert.ok(undated, 'undated item is still parsed');
  assert.equal(undated.date, null);
});

test('URLs are absolute and have decoded ampersands', () => {
  const items = parseListPage(listHtml, { now: NOW, treeId: '1154' });
  for (const it of items) {
    assert.ok(it.url.startsWith('http://my.bupt.edu.cn/'), `absolute url: ${it.url}`);
    assert.ok(!it.url.includes('&amp;'), 'entities decoded');
  }
});

test('titles are non-empty and free of dates', () => {
  const items = parseListPage(listHtml, { now: NOW, treeId: '1154' });
  for (const it of items) {
    assert.ok(it.title.length > 0, `title present for ${it.key}`);
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(it.title), `date stripped from title: ${it.title}`);
  }
});

test('extractPaginationLinks finds only the requested column, page >= 2', () => {
  const links = extractPaginationLinks(listHtml, { treeId: '1154' });
  assert.deepEqual(links.map((l) => l.page), [2, 3]);
  assert.ok(links.every((l) => l.url.includes('wbtreeid=1154')), 'other columns excluded');
});

test('pageNumberOf reads the real VSB parameter and ignores `totalpage`', () => {
  // The page COUNT sits immediately before the page number; matching `page`
  // inside `totalpage` is exactly the bug that stopped pagination.
  assert.equal(pageNumberOf('?totalpage=18&PAGENUM=2&urltype=tree.TreeTempUrl&wbtreeid=2001'), 2);
  assert.equal(pageNumberOf('?totalpage=1602&PAGENUM=1602&urltype=tree.TreeTempUrl&wbtreeid=1154'), 1602);
  assert.equal(pageNumberOf('list.jsp?wbtreeid=2001&page=4'), 4);
  assert.equal(pageNumberOf('list.jsp?wbtreeid=2001&amp;PAGENUM=3'), 3, 'entities decoded');
  assert.equal(pageNumberOf('?totalpage=18&urltype=tree.TreeTempUrl&wbtreeid=2001'), null, 'totalpage alone is not a page');
  assert.equal(pageNumberOf('/system/resource/css/pagedown/sys.css'), null);
  assert.equal(pageNumberOf(''), null);
});

test('pagination links from the real markup are found and ordered', () => {
  const links = extractPaginationLinks(pagingHtml, { pageUrl: LIST_URL, treeId: '2001' });
  assert.deepEqual(links.map((l) => l.page), [2, 3, 4, 5, 18], 'page 1 is not a target');
  assert.ok(links.every((l) => l.url.includes('wbtreeid=2001')), 'other columns excluded');
  assert.ok(!links.some((l) => l.page === 1602), 'the other column’s page 2 is not ours');
});

test('query-only paging links resolve against the LIST PAGE, not the portal root', () => {
  // Resolving `?…` against http://my.bupt.edu.cn/ yields the portal root, which
  // answers with a 954-byte JS redirect stub — 0 items, silently.
  const links = extractPaginationLinks(pagingHtml, { pageUrl: LIST_URL, treeId: '2001' });
  const page2 = links.find((l) => l.page === 2);
  // A `?query`-only href replaces the query but keeps the path.
  assert.equal(
    page2.url,
    'http://my.bupt.edu.cn/list.jsp?totalpage=18&PAGENUM=2&urltype=tree.TreeTempUrl&wbtreeid=2001',
  );
  assert.ok(page2.url.includes('/list.jsp'), 'must keep the list page path');
  assert.ok(page2.url.includes('wbtreeid=2001'), 'must keep the column');
  assert.ok(!/^http:\/\/my\.bupt\.edu\.cn\/\?/.test(page2.url), 'must not point at the portal root');

  // Without pageUrl it still resolves against baseUrl (kept for compatibility).
  const viaBase = extractPaginationLinks(pagingHtml, { baseUrl: LIST_URL, treeId: '2001' });
  assert.equal(viaBase.find((l) => l.page === 2).url, page2.url);
});

test('looksLikeLoginPage distinguishes a CAS page from a content page', () => {
  assert.equal(looksLikeLoginPage(loginHtml), true);
  assert.equal(looksLikeLoginPage(listHtml), false);
  assert.equal(looksLikeLoginPage(''), true);
});

test('makeYearInferrer rolls back a year for a future month', () => {
  const infer = makeYearInferrer(new Date(2026, 8, 25)); // Sep 2026
  assert.equal(infer(9, 20), 2026, 'same month, past day → this year');
  assert.equal(infer(12, 1), 2025, 'later month → last year');
  assert.equal(infer(3, 1), 2026, 'earlier month → this year');
});

test('normaliseUrl resolves relative hrefs and decodes entities', () => {
  assert.equal(
    normaliseUrl('/content.jsp?a=1&amp;b=2', 'http://my.bupt.edu.cn/'),
    'http://my.bupt.edu.cn/content.jsp?a=1&b=2',
  );
});

test('extractArticle returns body text without scripts', () => {
  const html = `<html><body><div class="v_news_content"><script>evil()</script><p>正文内容</p></div></body></html>`;
  const { text } = extractArticle(html);
  assert.ok(text.includes('正文内容'));
  assert.ok(!text.includes('evil'));
});

/* ---------------- page classification (regression: real portal) ------------ */

test('classifyPage: a list page with items is CONTENT', () => {
  const r = classifyPage(listHtml, { finalUrl: 'http://my.bupt.edu.cn/list.jsp?wbtreeid=1154' });
  assert.equal(r.kind, PAGE.CONTENT);
  assert.ok(r.itemCount > 0);
});

test('classifyPage: an unauthenticated list.jsp is LOGIN, not a template change', () => {
  // This is the exact trap: the portal answers 200 with a "系统发生错误" shell
  // after redirecting to clogin.jsp. It must be classified as LOGIN so the tool
  // re-authenticates instead of wrongly reporting "模板可能已变更".
  const r = classifyPage(authRequiredHtml, { finalUrl: AUTH_URL });
  assert.equal(r.kind, PAGE.LOGIN, `expected LOGIN, got ${r.kind}: ${r.reason}`);
  assert.equal(r.itemCount, 0);
});

test('classifyPage: the auth redirect URL alone is enough', () => {
  // Even if the body were unrecognisable, the clogin.jsp redirect proves auth.
  const r = classifyPage('<html><body>whatever</body></html>', { finalUrl: AUTH_URL });
  assert.equal(r.kind, PAGE.LOGIN);
});

test('classifyPage: a CAS login form body is LOGIN', () => {
  assert.equal(classifyPage(loginHtml, { finalUrl: 'http://my.bupt.edu.cn/' }).kind, PAGE.LOGIN);
});

test('classifyPage: an unrelated empty page is EMPTY, not LOGIN', () => {
  const r = classifyPage('<html><body><p>页面模板可能已变更</p></body></html>');
  assert.equal(r.kind, PAGE.EMPTY);
});

test('classifyPage: a blank response is EMPTY', () => {
  assert.equal(classifyPage('').kind, PAGE.EMPTY);
});

test('isAuthUrl recognises portal auth endpoints', () => {
  assert.equal(isAuthUrl(AUTH_URL), true);
  assert.equal(isAuthUrl('http://my.bupt.edu.cn/system/resource/code/auth/clogout.jsp?service=x'), true);
  assert.equal(isAuthUrl('http://my.bupt.edu.cn/list.jsp?wbtreeid=1154'), false);
});

test('looksLikeLoginPage stays consistent with classifyPage', () => {
  assert.equal(looksLikeLoginPage(listHtml), false);
  assert.equal(looksLikeLoginPage(loginHtml), true);
  assert.equal(looksLikeLoginPage(''), true);
  // The portal error shell has no login form, so the boolean form is false —
  // the collector relies on classifyPage() for this case.
  assert.equal(classifyPage(authRequiredHtml, { finalUrl: AUTH_URL }).kind, PAGE.LOGIN);
});

/* --------------- real CAS server (auth.bupt.edu.cn) — captured live -------- */

test('classifyPage: the live CAS login page is LOGIN', () => {
  const r = classifyPage(casLiveHtml, { finalUrl: CAS_URL });
  assert.equal(r.kind, PAGE.LOGIN, `got ${r.kind}: ${r.reason}`);
});

test('the CAS authserver URL is recognised as an auth URL', () => {
  assert.equal(isAuthUrl(CAS_URL), true);
  assert.equal(isAuthUrl('https://auth.bupt.edu.cn/authserver/login'), true);
  // The real service parameter is URL-encoded, so the matcher must not rely on
  // a literal "auth/" or "clogin.jsp" appearing unencoded.
  assert.equal(isAuthUrl('https://auth.bupt.edu.cn/authserver/login?service=x'), true);
});

test('looksLikeLoginPage detects the live CAS page', () => {
  assert.equal(looksLikeLoginPage(casLiveHtml), true);
});

test('a real CAS page is never mistaken for content', () => {
  const r = classifyPage(casLiveHtml, { finalUrl: CAS_URL });
  assert.equal(r.itemCount, 0);
  assert.notEqual(r.kind, PAGE.CONTENT);
});


