/**
 * vsb.js — Parser for VSB (Visual SiteBuilder) CMS pages used by my.bupt.edu.cn.
 *
 * All functions here are PURE: they take an HTML string and return plain objects.
 * That keeps them unit-testable offline against saved fixtures (see test/).
 *
 * Real markup observed on 2026-09-25 (校内通知 wbtreeid=1154, 校内文件 wbtreeid=2001):
 *
 *   <dd style="...">
 *     <a href="http://my.bupt.edu.cn/content.jsp?urltype=news.NewsContentUrl&wbtreeid=2001&wbnewsid=141749"
 *        target="_blank" style="display: none;;">
 *         关于修订印发《北京邮电大学促进科技成...
 *         <span>2026-08-06</span>
 *     </a>
 *     <div class="toutiao clearfix" style="display: block;">
 *       <a href="...same url..."><div class="arcdate "><span> 08月</span><strong>06</strong></div></a>
 *       <div class="toutiaoinfo">
 *         <div class="toutiaotitle"><a href="...same url...">关于修订印发...</a></div>
 *         <a href="...same url..."><p>summary...</p></a>
 *       </div>
 *     </div>
 *   </dd>
 *
 * The same newsId appears 2-3x inside one block (hidden anchor + headline card),
 * so results must be de-duplicated by (treeId, newsId) preferring the richest entry.
 */

import * as cheerio from 'cheerio';

/** Matches the VSB article link shape, tolerating &amp; and different *.jsp names. */
const NEWS_ID_RE = /wbnewsid=(\d+)/i;
const TREE_ID_RE = /wbtreeid=(\d+)/i;
const ISO_DATE_RE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/;
const CN_MONTH_RE = /(\d{1,2})\s*月/;
/** Year-less `MM-DD`, used by the lecture/event template (tree 1300). */
const MD_DATE_RE = /\b(\d{1,2})-(\d{1,2})\b/;

/** Collapse whitespace and strip leading/trailing junk from link text. */
function cleanText(s) {
  return String(s || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function iso(y, m, d) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function isValidDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Resolve the absolute article URL and normalise the query string.
 * Saved pages use &amp; — cheerio already decodes attribute values, but hrefs
 * coming from raw regex may still contain entities, so handle both.
 */
export function normaliseUrl(href, baseUrl = 'http://my.bupt.edu.cn/') {
  let h = String(href || '').replace(/&amp;/gi, '&').trim();
  if (!h) return '';
  try {
    return new URL(h, baseUrl).href;
  } catch {
    return h;
  }
}

/**
 * Extract the publication date for an item.
 *
 * Strategy, in decreasing order of confidence:
 *   1. An ISO `YYYY-MM-DD` anywhere in the anchor text (VSB renders `<span>2026-08-06</span>`).
 *   2. An ISO date anywhere in the enclosing block (`dd` / `li` / `tr`).
 *   3. A Chinese `MM月` + `<strong>DD</strong>` pair (the headline "arcdate" card),
 *      which carries NO year — the year is inferred via `inferYear`.
 */
function extractDate($, $a, $scope, inferYear) {
  const anchorText = cleanText($a.text());
  let m = anchorText.match(ISO_DATE_RE);
  if (m) {
    const [, y, mo, d] = m.map(Number);
    if (isValidDate(y, mo, d)) return iso(y, mo, d);
  }

  const scopeText = cleanText($scope.text());
  m = scopeText.match(ISO_DATE_RE);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (isValidDate(y, mo, d)) return iso(y, mo, d);
  }

  // Chinese month/day card. Prefer a dedicated .arcdate element.
  const $arc = $scope.find('.arcdate, .arcdate_1, [class*="arcdate"]').first();
  const arcText = cleanText(($arc.length ? $arc : $scope).text());
  const cm = arcText.match(CN_MONTH_RE);
  if (cm) {
    const mo = Number(cm[1]);
    // Day: a <strong> inside the arcdate element, else the first 1-2 digit run after 月.
    let day = null;
    const strongText = cleanText($arc.find('strong').first().text());
    if (/^\d{1,2}$/.test(strongText)) day = Number(strongText);
    if (day == null) {
      const after = arcText.slice(cm.index + cm[0].length).match(/(\d{1,2})/);
      if (after) day = Number(after[1]);
    }
    if (day != null && mo >= 1 && mo <= 12 && day >= 1 && day <= 31) {
      const y = inferYear(mo, day);
      if (isValidDate(y, mo, day)) return iso(y, mo, day);
    }
  }

  // Year-less MM-DD template (lecture/event lists).
  const md = extractMonthDayDate($, $scope, inferYear);
  if (md) return md;

  return null;
}

/**
 * Year-less `MM-DD` fallback, used by the lecture/event list template:
 *   <div class="timedateup">06-10</div>
 * Scoped first to `.timedateup`, then to the enclosing block.
 */
function extractMonthDayDate($, $scope, inferYear) {
  const scopes = [$scope.find('.timedateup').first(), $scope];
  for (const $s of scopes) {
    if (!$s || !$s.length) continue;
    const m = cleanText($s.text()).match(MD_DATE_RE);
    if (!m) continue;
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    const y = inferYear(mo, d);
    if (isValidDate(y, mo, d)) return iso(y, mo, d);
  }
  return null;
}

/**
 * Build a year-inference helper.
 *
 * VSB headline cards show only "MM月 DD". Lists are newest-first, so an item whose
 * month is *later* than the reference month must belong to the previous year.
 */
export function makeYearInferrer(now = new Date()) {
  const refY = now.getFullYear();
  const refM = now.getMonth() + 1;
  return (month, day) => {
    if (month > refM) return refY - 1;
    if (month < refM) return refY;
    // Same month: if the day is in the future by more than a day, it's last year.
    return day > now.getDate() + 1 ? refY - 1 : refY;
  };
}

/** Choose the better of two titles: prefer the longer, non-truncated one. */
function betterTitle(a, b) {
  if (!a) return b;
  if (!b) return a;
  const aTrunc = /(\.\.\.|…)$/.test(a);
  const bTrunc = /(\.\.\.|…)$/.test(b);
  if (aTrunc !== bTrunc) return aTrunc ? b : a;
  return b.length > a.length ? b : a;
}

/**
 * Parse a VSB list page into item objects.
 *
 * @param {string} html
 * @param {{baseUrl?: string, treeId?: string, now?: Date, source?: string}} opts
 * @returns {Array<{key:string,treeId:string,newsId:string,title:string,url:string,date:string|null,summary:string,source:string}>}
 */
export function parseListPage(html, opts = {}) {
  const { baseUrl = 'http://my.bupt.edu.cn/', now = new Date(), source = '' } = opts;
  const inferYear = makeYearInferrer(now);
  const $ = cheerio.load(html || '');

  /** @type {Map<string, any>} */
  const byKey = new Map();

  $('a[href]').each((_, el) => {
    const $a = $(el);
    const rawHref = $a.attr('href') || '';
    if (!NEWS_ID_RE.test(rawHref.replace(/&amp;/gi, '&'))) return;

    const href = rawHref.replace(/&amp;/gi, '&');
    const newsId = href.match(NEWS_ID_RE)[1];
    const treeId = (href.match(TREE_ID_RE) || [, opts.treeId || ''])[1];

    // NOTE: no treeId filtering here on purpose — see the adaptive filter after
    // the loop. An article's own treeId is kept because it is what makes the
    // dedup key stable.

    // Scope = nearest block container, used for date + summary lookups.
    const $scope = ($a.closest('dd, li, tr, .tabinfo').first().length
      ? $a.closest('dd, li, tr, .tabinfo').first()
      : $a.parent());

    // Title: for a headline card the anchor may wrap only a date; then use
    // .toutiaotitle a, else the anchor text with any date stripped out.
    let title = cleanText($a.text()).replace(ISO_DATE_RE, '').replace(/\d{1,2}\s*月\s*\d{1,2}\s*日?/, '').trim();
    if (!title || /^\d{1,2}$/.test(title)) {
      const alt = cleanText($scope.find('.toutiaotitle a').first().text());
      if (alt) title = alt;
    }
    if (!title) {
      // Last resort: any anchor in scope pointing at the same newsId.
      const alt = cleanText($scope.find(`a[href*="wbnewsid=${newsId}"]`).first().text())
        .replace(ISO_DATE_RE, '')
        .trim();
      if (alt) title = alt;
    }

    const date = extractDate($, $a, $scope, inferYear);

    // Summary: the <p> under the headline card, if present.
    let summary = '';
    const $p = $scope.find('.toutiaoinfo p, p').first();
    if ($p.length) summary = cleanText($p.text()).replace(/\.{3}$/, '').trim();

    const key = `${treeId}:${newsId}`;
    const prev = byKey.get(key);
    const entry = {
      key,
      treeId,
      newsId,
      title: prev ? betterTitle(prev.title, title) : title,
      url: normaliseUrl(href, baseUrl),
      date: prev?.date && date ? (prev.date > date ? prev.date : date) : (date || prev?.date || null),
      summary: prev?.summary || summary,
      source: source || prev?.source || '',
    };
    byKey.set(key, entry);
  });

  const all = [...byKey.values()];

  /**
   * Adaptive column filtering.
   *
   * Most columns render their own articles, so every link carries the configured
   * wbtreeid (校内文件 2001 → all 20 links are `wbtreeid=2001`).
   *
   * But some columns are CONTAINERS that aggregate sub-columns. Verified live on
   * 2026-09-25: 校内通知 (list.jsp?wbtreeid=1154) returns 20 articles whose tree
   * ids are 1158, 1787, 2182, 1736, 1741, 2149, 1764, 2157, 1771, 1645, 2170,
   * 1752 — none of them 1154. A strict filter therefore discarded the entire
   * column and the column silently looked empty.
   *
   * So: filter only when the page actually contains the configured column;
   * otherwise trust the page and keep everything on it.
   */
  if (!opts.treeId) return all;

  const matching = all.filter((i) => i.treeId === String(opts.treeId));
  if (matching.length) return matching;
  return all;
}

/**
 * Extract the main body text of a VSB article page, for inclusion in the email.
 * VSB wraps article bodies in a variety of containers; we try the common ones.
 */
export function extractArticle(html, opts = {}) {
  const $ = cheerio.load(html || '');
  $('script, style, noscript').remove();

  const candidates = [
    '.v_news_content',
    '#vsb_content',
    '.content',
    '.article',
    '.news_content',
    '.show_content',
    'form',
    'body',
  ];

  let best = '';
  for (const sel of candidates) {
    const $c = $(sel).first();
    if (!$c.length) continue;
    const text = cleanText($c.text());
    if (text.length > best.length) best = text;
    if (best.length > 200) break;
  }

  const title = cleanText($('title').first().text()) || cleanText(opts.fallbackTitle || '');
  return { title, text: best };
}

/**
 * Page kinds returned by classifyPage().
 */
export const PAGE = {
  CONTENT: 'content', // real list items parsed
  LOGIN: 'login', // the portal wants (re)authentication
  ERROR: 'error', // portal error page
  EMPTY: 'empty', // unrecognised / nothing usable
};

/**
 * Signals that the portal is bouncing us to authentication.
 *
 * Verified against the live portal on 2026-09-25: an unauthenticated request to
 * my.bupt.edu.cn (or to list.jsp) is sent to the CAS server
 *
 *   https://auth.bupt.edu.cn/authserver/login?service=http%3A%2F%2Fmy.bupt.edu.cn...
 *
 * and list.jsp itself answers HTTP 400 with that login page as the final URL.
 * Earlier, a non-browser client saw a 302 to
 * /system/resource/code/auth/clogin.jsp?owner=... which returned a
 * "系统提示 / 系统发生错误" (00BAP) shell instead of a login form.
 *
 * The redirect target is therefore far more reliable than the body, so match
 * the auth host, the CAS authserver path, and the portal's clogin/clogout ends.
 */
const AUTH_URL_RE =
  /(?:authserver|auth\.bupt\.edu\.cn|clogin|clogout|cas\/login|\/cas\/|login\.jsp|\/login\b|system\/resource\/code\/auth)/i;


const AUTH_BODY_PATTERNS = [
  /\/system\/resource\/code\/auth\//i,
  /clogin\.jsp/i,
  /name=["']?execution["']?/i,
  /id=["']?loginForm/i,
  /\/cas\/login/i,
  /统一身份认证/,
  /用户名[\s\S]{0,40}密码/,
  /请先登录|请登录后|登录已过期|会话已过期/,
];

/** The BUPT portal's own error shell (not a login prompt). */
const ERROR_BODY_PATTERNS = [
  /系统发生错误/,
  /错误标识码/,
  /class=["']?prompt(?:One|Two|There)/i,
  /当前页面发生错误/,
  /系统提示[\s\S]{0,200}错误/,
];

function authSignals(s) {
  return AUTH_BODY_PATTERNS.reduce((n, re) => n + (re.test(s) ? 1 : 0), 0);
}

function errorSignals(s) {
  return ERROR_BODY_PATTERNS.reduce((n, re) => n + (re.test(s) ? 1 : 0), 0);
}

/**
 * Decide what a fetched response actually is.
 *
 * A page containing real list items is always CONTENT, even if it also carries
 * a stray "登录" link in the page furniture. Otherwise the URL is checked first
 * (most reliable), then the body.
 *
 * @param {string} html
 * @param {{finalUrl?:string}} [opts]
 * @returns {{kind:string, reason:string, itemCount:number}}
 */
export function classifyPage(html, { finalUrl = '' } = {}) {
  const s = String(html || '');
  const itemCount = (s.match(/wbnewsid=\d+/gi) || []).length;

  // Real content wins: a logged-in list page cannot be a login/error page.
  if (itemCount > 0) {
    return { kind: PAGE.CONTENT, reason: `包含 ${itemCount} 个条目链接`, itemCount };
  }

  // The redirect target is the strongest signal available.
  if (AUTH_URL_RE.test(finalUrl)) {
    return { kind: PAGE.LOGIN, reason: `被重定向到认证地址 (${finalUrl})`, itemCount };
  }
  if (authSignals(s) >= 2 || authSignals(s) >= 1 && /<form/i.test(s)) {
    return { kind: PAGE.LOGIN, reason: '页面要求统一身份认证登录', itemCount };
  }
  if (errorSignals(s) >= 1) {
    return { kind: PAGE.ERROR, reason: '门户返回「系统发生错误」页面', itemCount };
  }
  if (!s.trim()) return { kind: PAGE.EMPTY, reason: '响应为空', itemCount };
  return { kind: PAGE.EMPTY, reason: '未识别到条目、登录页或错误页', itemCount };
}

/**
 * True when a fetched page should be treated as "needs login".
 * Kept as the narrow, boolean form used by the session check.
 */
export function looksLikeLoginPage(html) {
  const s = String(html || '');
  if (!s) return true;
  if (NEWS_ID_RE.test(s)) return false;
  return authSignals(s) >= 2 || (authSignals(s) >= 1 && /<form/i.test(s));
}

/** Backwards-compatible alias used by older call sites. */
export function isAuthUrl(url) {
  return AUTH_URL_RE.test(String(url || ''));
}

/**
 * Extract the CAS page's own error message, if it rendered one.
 *
 * The login page keeps its error slot in `#errorDiv` (see the inline script:
 * `config.error = $("#errorDiv p").text() || null;`), and Apereo-style portals
 * also use `.error` / `.alert` containers.
 *
 * This matters for a specific reason: "still on the login page" does NOT prove
 * the password was wrong. Only a real server-side rejection message does — and
 * we must not count a technical failure towards an account-lockout backoff.
 *
 * @returns {string|null} the message, or null when the page showed none
 */
export function extractLoginError(html) {
  const s = String(html || '');
  if (!s) return null;

  const containers = [
    /<div[^>]*id=["']?errorDiv["']?[^>]*>([\s\S]{0,600}?)<\/div>/i,
    /<p[^>]*class=["'][^"']*\berror\b[^"']*["'][^>]*>([\s\S]{0,400}?)<\/p>/i,
    /<div[^>]*class=["'][^"']*\b(?:error|errmsg|alert-danger|tips-error)\b[^"']*["'][^>]*>([\s\S]{0,400}?)<\/div>/i,
    /<span[^>]*id=["']?errMsg["']?[^>]*>([\s\S]{0,300}?)<\/span>/i,
  ];
  for (const re of containers) {
    const m = s.match(re);
    if (m) {
      // Strip tags: an EMPTY container is common (the portal always renders
      // `<div id="errorDiv"><p></p></div>` and fills it only on failure).
      // Without this the raw markup `<p></p>` was returned as if it were an
      // error message.
      const text = cleanText(m[1].replace(/<[^>]*>/g, ' '));
      if (text) return text.slice(0, 200);
    }
  }

  // Fall back to recognisable rejection phrasing anywhere in the page.
  const phrases = [
    /(用户名或密码[^\s<>，。]{0,24})/,
    /(密码[^\s<>，。]{0,12}(?:错误|不正确|有误))/,
    /(账号[^\s<>，。]{0,12}(?:锁定|被锁|停用|不存在))/,
    /(验证码[^\s<>，。]{0,12}(?:错误|不正确|失效|过期))/,
    /(登录失败[^\s<>，。]{0,40})/,
    /(用户名[^\s<>，。]{0,12}(?:错误|不存在))/,
  ];
  for (const re of phrases) {
    const m = s.match(re);
    if (m) return cleanText(m[1]).slice(0, 200);
  }
  return null;
}

/** True when the message looks like the server rejected the credentials. */
export function isCredentialRejection(message) {
  const s = String(message || '');
  if (!s) return false;
  return /密码|用户名|账号|验证码|锁定|被锁|停用|不存在|不正确|错误|失败/.test(s);
}

/**
 * Page parameters VSB uses, most specific first.
 *
 * This is NOT a guess — the real markup puts the page COUNT immediately before
 * the page number:
 *
 *   ?totalpage=18&PAGENUM=2&urltype=tree.TreeTempUrl&wbtreeid=2001
 *
 * The previous single regex `/(?:pagenum|page|…)[=:](\d+)/` was unanchored, so
 * `page=18` inside `totalpage=18` matched first and every paging link reported
 * "page 18" (1602 for the 校内通知 column). `links.find(l => l.page === 2)` then
 * never matched, and **every run silently read only page 1 of each column** — so
 * 「只看最近多少天」 could not reach older content however large it was set.
 *
 * The leading `[?&]` is what excludes `totalpage`: the `page` inside it is
 * preceded by the letter `l`, not by `?` or `&`.
 */
const PAGE_PARAMS = ['pagenum', 'pageno', 'wbpagenum', 'currentpage', 'page'];

/**
 * The page number a VSB paging href refers to, or null.
 * @returns {number|null}
 */
export function pageNumberOf(href) {
  const s = String(href || '').replace(/&amp;/gi, '&');
  for (const name of PAGE_PARAMS) {
    const m = new RegExp(`[?&]${name}=(\\d+)`, 'i').exec(s);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * Discover pagination links on a VSB list page.
 *
 * VSB names its page parameter inconsistently across templates, so rather than
 * guessing we read the page's own "next / 2 / 3 …" links and return their URLs
 * ordered by page number.
 *
 * @param {string} html
 * @param {{baseUrl?:string, pageUrl?:string, treeId?:string|number}} [opts]
 *        `pageUrl` is the URL the html came from. It matters: paging links are
 *        query-only (`?totalpage=…&PAGENUM=2&…`), and resolving those against the
 *        portal ROOT yields `http://my.bupt.edu.cn/?…`, which answers with the
 *        954-byte JavaScript redirect stub (0 items) instead of page 2.
 * @returns {Array<{page:number,url:string}>}
 */
export function extractPaginationLinks(html, { baseUrl = 'http://my.bupt.edu.cn/', pageUrl, treeId } = {}) {
  const $ = cheerio.load(html || '');
  const found = new Map();
  const resolveAgainst = pageUrl || baseUrl;

  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').replace(/&amp;/gi, '&');
    if (treeId && !new RegExp(`wbtreeid=${treeId}\\b`).test(href)) return;
    const page = pageNumberOf(href);
    if (!page || page < 2) return;
    if (!found.has(page)) found.set(page, normaliseUrl(href, resolveAgainst));
  });

  return [...found.entries()]
    .map(([page, url]) => ({ page, url }))
    .sort((a, b) => a.page - b.page);
}

