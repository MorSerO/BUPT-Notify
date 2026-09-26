/**
 * collector.js — fetch each watched column, apply the 10-day window and dedup.
 *
 * Windowing rules:
 *   - Items with a parsed publish date are kept only when that date is within
 *     `windowDays` of today (inclusive at both ends).
 *   - Items whose date could NOT be parsed are kept only the first time they are
 *     ever seen. We cannot prove they are new, but a never-before-seen id that
 *     just appeared at the top of the list is almost certainly new; afterwards
 *     the store suppresses it forever.
 *   - Anything already forwarded (email succeeded) is dropped.
 */

import { log } from './logger.js';
import { parseListPage, extractPaginationLinks, classifyPage, PAGE } from './vsb.js';
import { fetchPortalStatus } from './portal.js';
import { fetchUnreadMails, mailToItem } from './mailbox.js';
import { daysBetween, todayLocal, minusDays } from './util.js';
import { cancellableSleep, isCancellation } from './cancel.js';

/** Inclusive window test. */
export function withinWindow(dateStr, { windowDays, today = todayLocal() }) {
  if (!dateStr) return null; // unknown
  const d = daysBetween(dateStr, today);
  if (d === null) return null;
  return d >= 0 && d <= windowDays;
}

/** Hard ceiling on pages per column, whatever the window asks for. */
export const HARD_MAX_PAGES = 12;

/**
 * How many pages a column may be walked.
 *
 * `maxPages` alone is not enough once the window gets wide. Each list page
 * carries 20 items, so a 「只看最近 365 天」 setting that stops after 3 pages
 * silently returns only a fraction of the period it promises — the setting looks
 * broken. One page per month of window is a good approximation, `maxPages` stays
 * the floor, and HARD_MAX_PAGES bounds the cost (~1s per page).
 *
 * (This only became reachable at all after extractPaginationLinks was fixed; it
 * used to stop after page 1 for every window because it mis-read the page number
 * from `totalpage`.)
 *
 * @returns {number}
 */
export function derivePageBudget(maxPages, windowDays) {
  const configured = Math.max(1, Number(maxPages) || 1);
  const byWindow = Math.ceil((Number(windowDays) || 0) / 30);
  return Math.max(1, Math.min(HARD_MAX_PAGES, Math.max(configured, byWindow)));
}

/**
 * Fetch one column, walking pagination only while the oldest item on a page is
 * still inside the window (no point paging past the window).
 */
export async function fetchTarget(session, target, cfg, { now = new Date(), maxPages, token } = {}) {
  const configured = maxPages ?? cfg.maxPages ?? 1;
  const pages = maxPages ?? derivePageBudget(configured, cfg.windowDays);
  const today = todayLocal(now);
  const cutoff = minusDays(today, cfg.windowDays);

  // A target without a resolvable URL would otherwise silently yield zero items,
  // which looks exactly like "nothing new" — fail loudly instead.
  const startUrl = target.url || (target.path ? new URL(target.path, cfg.baseUrl).href : null);
  if (!startUrl) {
    throw new Error(`栏目 "${target.name || target.key}" 缺少 url/path 配置，无法抓取`);
  }

  const all = [];
  const seenUrls = new Set();
  let url = startUrl;
  let pageNo = 0;
  let emptyPages = 0;

  while (url && pageNo < pages && !seenUrls.has(url)) {
    token?.throwIfCancelled('抓取');
    seenUrls.add(url);
    pageNo += 1;
    log.debug(`抓取 ${target.name} 第 ${pageNo} 页: ${url}`);

    const { html, status, finalUrl } = await session.fetchHtml(url, { token });

    // Distinguish "needs login" from "portal error" from "template changed".
    // An unauthenticated list.jsp 302s to clogin.jsp, which answers 200 with a
    // "系统发生错误" shell — that must NOT be mistaken for a changed template.
    const page = classifyPage(html, { finalUrl });
    if (page.kind === PAGE.LOGIN) {
      return { target, items: [], loginRequired: true, pages: pageNo, error: `需要登录 (${finalUrl})` };
    }
    if (page.kind === PAGE.ERROR) {
      return {
        target,
        items: [],
        loginRequired: false,
        pages: pageNo,
        error: `门户返回错误页 (${page.reason})，通常是会话失效或需要重新登录`,
        needsRelogin: true,
      };
    }

    const items = parseListPage(html, { baseUrl: cfg.baseUrl, treeId: target.treeId, now, source: target.name });
    if (!items.length) {
      emptyPages += 1;
      // Include the raw link count so a future mismatch is diagnosable rather
      // than just "0 items".
      const rawLinks = (html.match(/wbnewsid=\d+/g) || []).length;
      log.warn(
        `${target.name} 第 ${pageNo} 页未解析到任何条目 (HTTP ${status}, ${page.reason})；` +
          `页面共 ${rawLinks} 个条目链接，配置的 treeId=${target.treeId}。请检查栏目配置。`,
      );
      break;
    }
    all.push(...items);
    log.debug(`${target.name} 第 ${pageNo} 页解析到 ${items.length} 条`);

    // Decide whether paging further can still yield in-window items.
    const dated = items.filter((i) => i.date);
    const oldest = dated.length ? dated.map((i) => i.date).sort()[0] : null;
    if (!oldest) {
      log.debug(`${target.name}: 本页无日期，停止翻页。`);
      break;
    }
    if (oldest < cutoff) {
      log.debug(`${target.name}: 最旧条目 ${oldest} 早于窗口起点 ${cutoff}，停止翻页。`);
      break;
    }

    // Paging links are query-only, so they must be resolved against the page
    // they came from (`finalUrl`), not against the portal root.
    const links = extractPaginationLinks(html, {
      baseUrl: cfg.baseUrl,
      pageUrl: finalUrl || url,
      treeId: target.treeId,
    });
    const next = links.find((l) => l.page === pageNo + 1);
    if (!next) {
      log.debug(
        `${target.name}: 第 ${pageNo} 页没有第 ${pageNo + 1} 页链接（发现 ${links.length} 个分页链接），停止翻页。`,
      );
      break;
    }
    if (pageNo >= pages) {
      // Be explicit rather than silently stopping: with a wide window this is the
      // reason older in-window items are not reached. Raise maxPages to go deeper.
      log.debug(
        `${target.name}: 已达本次翻页上限 ${pages} 页，不再翻页（更旧的窗口内内容不会被读取）。`,
      );
      break;
    }
    url = next.url;
    // Interruptible: do not sit in a sleep while the user is trying to stop.
    if (!(await cancellableSleep(500, token))) token?.throwIfCancelled('抓取');
  }

  return {
    target,
    items: all,
    loginRequired: false,
    needsRelogin: false,
    pages: pageNo,
    emptyPages,
    // A page that parsed to nothing is a real problem (template change / wrong
    // treeId), so surface it instead of reporting a silent "nothing new".
    error: emptyPages ? `第 ${emptyPages} 页解析到 0 条，页面模板可能已变更` : null,
  };
}

/**
 * Collect all new (in-window, not-yet-forwarded) items across every target.
 *
 * @returns {Promise<{items:Array, stats:object, loginRequired:boolean, errors:string[]}>}
 */
export async function collectAll(session, cfg, store, { now = new Date(), token } = {}) {
  const today = todayLocal(now);
  const cutoff = minusDays(today, cfg.windowDays);
  const stats = { targets: {}, fetched: 0, inWindow: 0, alreadyForwarded: 0, undatedNew: 0, newItems: 0 };
  const errors = [];
  let loginRequired = false;
  /** @type {Map<string, any>} */
  const fresh = new Map();

  log.info(`窗口: ${cutoff} ~ ${today} (最近 ${cfg.windowDays} 天)`);

  for (const target of cfg.targets) {
    token?.throwIfCancelled('抓取');
    let result;
    try {
      result = await fetchTarget(session, target, cfg, { now, token });
    } catch (err) {
      if (isCancellation(err, token)) throw err;
      const msg = `${target.name}: 抓取失败 ${err.message}`;
      log.error(msg);
      errors.push(msg);
      stats.targets[target.key] = { name: target.name, error: err.message, items: 0, new: 0 };
      continue;
    }

    if (result.loginRequired || result.needsRelogin) {
      // Either an explicit auth redirect, or the portal's error shell that it
      // serves once the session has expired. Both mean: log in again.
      loginRequired = true;
      errors.push(`${target.name}: ${result.error || '需要重新登录'}`);
      stats.targets[target.key] = { name: target.name, loginRequired: true, items: 0, new: 0 };
      continue;
    }

    let newCount = 0;
    stats.fetched += result.items.length;

    if (result.error) errors.push(`${target.name}: ${result.error}`);

    for (const item of result.items) {
      const w = withinWindow(item.date, { windowDays: cfg.windowDays, today });

      if (w === false) continue; // provably older than the window
      stats.inWindow += 1;

      if (w === null) {
        // The page gave us no usable date. We cannot prove it is inside the
        // window, so we rely purely on the "already forwarded" gate: such an
        // item is forwarded exactly once and never again. Gating on
        // "never seen" instead would permanently lose it if the delivery
        // failed, because markSeen happens even when sending does not.
        stats.undatedNew += 1;
        item.dateUnknown = true;
      }

      if (store.isForwarded(item)) {
        stats.alreadyForwarded += 1;
        continue;
      }

      newCount += 1;
      // Later occurrences of the same id (other pages) should not duplicate.
      if (!fresh.has(item.key)) fresh.set(item.key, item);
    }

    stats.targets[target.key] = {
      name: target.name,
      treeId: target.treeId,
      pages: result.pages,
      items: result.items.length,
      new: newCount,
      error: result.error,
    };
    log.info(`${target.name}: 共 ${result.items.length} 条，其中新内容 ${newCount} 条`);
  }

  const items = [...fresh.values()];
  stats.newItems = items.length;
  return { items, stats, loginRequired, errors };
}

/**
 * Collect the extra facts that ride along with the digest:
 *
 *   - the 待办中心 widgets (校园卡余额 / 未读邮件数 / 借阅 / 欠款), and
 *   - the subjects of unread mail.
 *
 * Both are strictly optional: a failure here is recorded as a warning and never
 * fails the run, because losing the balance line must not cost the user the
 * notices they actually subscribed to.
 *
 * @returns {Promise<{status:object|null, mails:Array, unreadTotal:number|null,
 *                    stats:object, errors:string[]}>}
 */
export async function collectExtras(session, cfg, store, { now = new Date(), token } = {}) {
  const opts = cfg.portal || {};
  let status = null;
  let unreadTotal = null;
  const errors = [];
  const mails = [];

  // 1. Balance / unread count / borrowings.
  if (opts.status !== false) {
    status = await fetchPortalStatus(session, cfg, { token, now });
    if (!status.ok && status.error) errors.push(`待办中心: ${status.error}`);
  }

  // 2. Unread mail subjects.
  if (opts.mailbox !== false) {
    const r = await fetchUnreadMails(session, cfg, { token, now });
    unreadTotal = r.unread ?? null;
    if (!r.ok) {
      errors.push(`未读邮件: ${r.error}`);
    } else {
      /**
       * Prefer the listing's own count for display. The portal widget is read a
       * moment earlier and can lag, which produced the confusing pair
       * 「未读邮件 0 封」 next to one freshly listed unread message.
       */
      if (status && unreadTotal !== null) status.unreadMail = unreadTotal;
      for (const m of r.mails) {
        const item = mailToItem(m);
        // Same rule as notices: never forward the same thing twice.
        if (store.isForwarded(item)) continue;
        mails.push(item);
      }
      if (r.mails.length > mails.length) {
        log.debug(`未读邮件中 ${r.mails.length - mails.length} 条此前已转发，跳过。`);
      }
    }
  }

  return {
    status,
    mails,
    // The mail listing is the more trustworthy count; the widget is the fallback
    // (and the only source when unread-mail forwarding is switched off).
    unreadTotal: unreadTotal ?? status?.unreadMail ?? null,
    stats: {
      unreadTotal,
      unreadCount: unreadTotal ?? status?.unreadMail ?? null,
      newMails: mails.length,
    },
    errors,
  };
}

