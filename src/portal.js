/**
 * portal.js — the 「待办中心」 widgets on the student homepage.
 *
 * WHAT THIS ADDS
 * --------------
 * The student homepage (xs_index.jsp?wbtreeid=1541) shows a 待办中心 panel with
 * four one-line facts the user asked to have forwarded:
 *
 *   【邮箱】      您有 3 封未读邮件
 *   【北 邮 通】  您当前余额 216.010 元      ← 校园卡 / 北邮通余额
 *   【图书借阅】  共计借阅 0 本
 *
 * Those numbers are NOT in the page HTML — it ships placeholders and fills them
 * with a single AJAX call:
 *
 *   GET /system/resource/app/cuser/getwxtsA.jsp
 *   → {"qkje":"0","yjcs":"0","oddfare":"216.010","mail":"0","cgtodo":"0","a":"…"}
 *
 *     oddfare  校园卡（北邮通）余额，单位元
 *     mail     未读邮件数
 *     yjcs     图书借阅册数
 *     qkje     欠款金额
 *     cgtodo   待办数
 *
 * TWO GOTCHAS (both measured live on 2026-09-26)
 * ---------------------------------------------
 *  1. Without a `Referer` pointing at the homepage the endpoint refuses:
 *       {"result":"false","errorinfo":"错误的访问来源！"}
 *     So the Referer is sent explicitly.
 *  2. When a number is unavailable the page substitutes `【-】` (or `-`).
 *     That must become `null` — treating it as a value would print 「余额 ¥- 元」.
 *
 * Nothing here is fatal: a widget failure only drops one line from the digest.
 */

import { log } from './logger.js';

/** The student homepage — the page the widgets live on. */
export const HOMEPAGE_PATH = 'xs_index.jsp?urltype=tree.TreeTempUrl&wbtreeid=1541';

/** The JSON endpoint behind 待办中心. */
export const WIDGETS_PATH = 'system/resource/app/cuser/getwxtsA.jsp';

export function homepageUrl(baseUrl) {
  return new URL(HOMEPAGE_PATH, baseUrl).href;
}

export function widgetsUrl(baseUrl) {
  return new URL(WIDGETS_PATH, baseUrl).href;
}

/**
 * Turn one widget value into a number or null.
 *
 * The portal uses `【-】` / `-` / `--` / empty as "no data". Anything that is not
 * a plain number is reported as unknown rather than coerced (Number('') === 0
 * and Number('【-】') === NaN both lie about it).
 *
 * @returns {number|null}
 */
export function parseWidgetValue(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/[,\s]/g, '');
  if (!s || s === '-' || s === '--') return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the widget payload.
 *
 * @param {string|object} raw JSON text (or an already-parsed object)
 * @returns {{ok:boolean, error?:string, balance:number|null, unreadMail:number|null,
 *            borrowed:number|null, owed:number|null, todo:number|null, account:string|null}}
 */
export function parseWidgets(raw) {
  const empty = {
    ok: false,
    balance: null,
    unreadMail: null,
    borrowed: null,
    owed: null,
    todo: null,
    account: null,
  };

  let data = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return { ...empty, error: '接口返回空内容' };
    try {
      data = JSON.parse(text);
    } catch {
      // The endpoint sometimes wraps JSON in whitespace/HTML; try to salvage it.
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return { ...empty, error: `接口未返回 JSON（${text.slice(0, 60)}）` };
      try {
        data = JSON.parse(m[0]);
      } catch {
        return { ...empty, error: '接口返回的 JSON 无法解析' };
      }
    }
  }

  if (!data || typeof data !== 'object') return { ...empty, error: '接口返回内容不是对象' };
  // {"result":"false","errorinfo":"错误的访问来源！"} — a refusal, not data.
  if (String(data.result).toLowerCase() === 'false') {
    return { ...empty, error: data.errorinfo ? String(data.errorinfo) : '接口拒绝了本次请求' };
  }

  const account = data.a ? String(data.a).trim() : null;
  return {
    ok: true,
    balance: parseWidgetValue(data.oddfare),
    unreadMail: parseWidgetValue(data.mail),
    borrowed: parseWidgetValue(data.yjcs),
    owed: parseWidgetValue(data.qkje),
    todo: parseWidgetValue(data.cgtodo),
    account,
  };
}

/** `216.01` → `¥216.01`; null → null. */
export function formatMoney(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return `¥${n.toFixed(2)}`;
}

/**
 * One-line summary used by both the digest and the panel.
 * @returns {string|null} e.g. `校园卡余额 ¥216.01 · 未读邮件 0 封`
 */
export function describeStatus(status) {
  if (!status || status.ok !== true) return null;
  const parts = [];
  if (status.balance !== null && status.balance !== undefined) {
    parts.push(`校园卡余额 ${formatMoney(status.balance)}`);
  }
  if (status.unreadMail !== null && status.unreadMail !== undefined) {
    parts.push(`未读邮件 ${status.unreadMail} 封`);
  }
  if (status.borrowed) parts.push(`借阅 ${status.borrowed} 本`);
  if (status.owed) parts.push(`欠款 ${formatMoney(status.owed)}`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Fetch and parse the widgets.
 *
 * @returns {Promise<{ok:boolean, error?:string, balance:number|null, unreadMail:number|null,
 *                    borrowed:number|null, owed:number|null, todo:number|null,
 *                    account:string|null, fetchedAt:string}>}
 */
export async function fetchPortalStatus(session, cfg, { token, now = new Date() } = {}) {
  const fetchedAt = now.toISOString();
  const url = widgetsUrl(cfg.baseUrl);
  const referer = homepageUrl(cfg.baseUrl);

  try {
    token?.throwIfCancelled('读取校园卡余额');
    // The Referer is mandatory — see the "错误的访问来源" note at the top.
    const r = await session.fetchHtml(url, {
      token,
      headers: { Referer: referer, 'X-Requested-With': 'XMLHttpRequest' },
    });

    const status = parseWidgets(r.html);
    if (!status.ok) {
      log.warn(`读取校园卡余额 / 未读邮件数失败：${status.error}`);
      return { ...status, fetchedAt };
    }
    log.info(`待办中心：${describeStatus(status) || '(无数据)'}`);
    return { ...status, fetchedAt };
  } catch (err) {
    log.warn(`读取校园卡余额 / 未读邮件数出错：${err.message}`);
    return { ...parseWidgets(''), error: err.message, fetchedAt };
  }
}
