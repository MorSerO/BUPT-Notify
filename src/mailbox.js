/**
 * mailbox.js — unread mail from the campus mail system (Coremail).
 *
 * WHY THIS IS NOT JUST ANOTHER LIST PAGE
 * --------------------------------------
 * The mail runs on Coremail at mail.bupt.edu.cn and is a separate application
 * from the portal: the portal only tells us the *count*
 * (see portal.js → `mail`). To get the *subjects* we have to get into the mail
 * session, and that session is a `sid` (session id) carried in URLs.
 *
 * The handshake, measured live on 2026-09-26:
 *
 *   1. GET https://register.bupt.cn/mail/login          (portal CAS cookies needed)
 *      → 200, a 275-byte script:
 *        <script>parent.window.location.href =
 *          'http://mail.bupt.edu.cn/cgi-bin/login?fun=bizopenssologin&method=openapi
 *           &userid=…@bupt.cn&authkey=<one-shot key>'</script>
 *   2. GET that URL → 200, an html shell whose body contains `sid=<sid>`
 *      (and which sets the `sid`/`qm_sid` cookies in our jar)
 *   3. GET https://mail.bupt.edu.cn/cgi-bin/mail_list?sid=<sid>&folderid=1&flag=new
 *      → the UNREAD messages, filtered server-side
 *
 * Notes that cost real debugging time:
 *  - `flag=new` is the filter that means "unread". `s=unread` alone is accepted
 *    but returns the whole folder, which would have forwarded read mail.
 *  - The list page is **gb18030**. Bare UTF-8 decoding turned every subject into
 *    mojibake; httpLogin.decodeBody now sniffs the charset, and we also ask for
 *    `resp_charset=UTF8` for good measure.
 *  - The page contains hidden `<input name="mailid" type="hidden" value="">`
 *    form helpers. Matching `name="mailid"` naively counts those as messages —
 *    real rows are the `<input type="checkbox" … value="ZC…">` ones.
 */

import { log } from './logger.js';
import { todayLocal } from './util.js';

/** Entry point the portal homepage links to. */
export const MAIL_SSO_ENTRY = 'https://register.bupt.cn/mail/login';

/** Mail application root (only the origin is needed to build URLs). */
export const DEFAULT_MAIL_BASE = 'https://mail.bupt.edu.cn';

/** 收件箱 folder id in Coremail. */
export const INBOX_FOLDER_ID = 1;

/* ------------------------------ small helpers ----------------------------- */

/** Decode the handful of entities Coremail emits in titles. */
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/gi, '&');
}

/** Strip tags, decode entities, collapse whitespace. */
export function cleanText(s) {
  return decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/* --------------------------- handshake primitives ------------------------- */

/**
 * The one-shot SSO URL out of the 275-byte redirect script.
 * @returns {string|null}
 */
export function extractSsoUrl(html) {
  const s = String(html || '');
  const m =
    s.match(/location\.href\s*=\s*['"]([^'"]*cgi-bin\/login[^'"]*)['"]/i) ||
    s.match(/location\.href\s*=\s*['"]([^'"]+)['"]/i) ||
    s.match(/(https?:\/\/[^\s'"]*cgi-bin\/login\?[^\s'"]+)/i);
  if (!m) return null;
  // The script writes an unescaped URL; &amp; can appear in saved copies.
  // NOTE: the scheme is deliberately left alone — the portal hands out an
  // `http://mail.bupt.edu.cn/...` URL and that is the one measured to work.
  return decodeEntities(m[1]);
}

/** Pull `sid=…` out of a URL, and account for the `,2` suffix Coremail appends. */
export function extractSid(text) {
  const s = String(text || '');
  const m = s.match(/[?&]sid=([A-Za-z0-9_\-%,.]+)/);
  return m ? m[1] : null;
}

/** Milliseconds-since-epoch from the row's `totime` attribute (or null). */
export function parseRowTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n);
}

/* ------------------------------- list parsing ----------------------------- */

/**
 * Is this response actually the mail list, or did the session expire?
 * An expired Coremail session answers with a login/redirect shell instead.
 */
export function looksLikeMailList(html) {
  const s = String(html || '');
  if (!s) return false;
  return /name="mailid"/.test(s) || /id="_ut_c"/.test(s) || /收件箱/.test(s);
}

/**
 * Parse a Coremail `mail_list` page.
 *
 * @param {string} html
 * @param {{filteredToUnread?:boolean}} [opts] when the request used `flag=new`,
 *        the server already filtered, so every returned row is unread.
 * @returns {{total:number|null, unread:number|null, mails:Array<object>}}
 */
export function parseMailList(html, { filteredToUnread = false } = {}) {
  const s = String(html || '');

  const total = Number((s.match(/id="_ut_c"[^>]*>\s*(\d+)/) || [])[1]);
  const unread = Number((s.match(/id="_ur_c"[^>]*>\s*(\d+)/) || [])[1]);

  // Real message rows are checkboxes with a non-empty id; the hidden form
  // helpers (`name="mailid" type="hidden" value=""`) must not count.
  const heads = [
    ...s.matchAll(/<input\b[^>]*\bname="mailid"[^>]*>/gi),
  ]
    .map((m) => ({ tag: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
    .filter((h) => !/type="hidden"/i.test(h.tag))
    .filter((h) => {
      const v = (h.tag.match(/\bvalue="([^"]*)"/) || [])[1] || '';
      return v.trim() !== '';
    });

  const mails = [];
  for (let i = 0; i < heads.length; i += 1) {
    const head = heads[i];
    const stop = i + 1 < heads.length ? heads[i + 1].start : Math.min(s.length, head.end + 6000);
    const row = s.slice(head.end, stop);

    const attr = (name) => {
      const m = head.tag.match(new RegExp(`\\b${name}="([^"]*)"`));
      return m ? decodeEntities(m[1]).trim() : '';
    };

    const id = attr('value');
    if (!id) continue;

    const subject = cleanText((row.match(/<u\b[^>]*>([\s\S]*?)<\/u>/i) || [])[1] || '');
    const preview = cleanText(
      (row.match(/<b\b[^>]*class="no[^"]*"[^>]*>([\s\S]*?)<\/b>/i) || [])[1] || '',
    );
    const dateText = cleanText((row.match(/<td class="dt"><div>([\s\S]*?)<\/div>/i) || [])[1] || '');

    // `unread` is only present on some renderings; when the request was
    // filtered with flag=new, the server already guaranteed unread.
    const unreadAttr = (head.tag.match(/\bunread="([^"]*)"/) || [])[1];
    const isUnread = unreadAttr === undefined ? filteredToUnread : /^true$/i.test(unreadAttr);

    const when = parseRowTime(attr('totime'));

    mails.push({
      id,
      subject: subject || '(无主题)',
      preview: preview.replace(/^[-–—\s]+/, ''),
      sender: attr('fn'),
      senderAddress: attr('fa'),
      dateText,
      date: when ? todayLocal(when) : null,
      receivedAt: when ? when.toISOString() : null,
      unread: Boolean(isUnread),
    });
  }

  return {
    total: Number.isFinite(total) ? total : null,
    unread: Number.isFinite(unread) ? unread : null,
    mails,
  };
}

/* --------------------------- mailbox operations --------------------------- */

/** Read one cookie out of the session jar (if present). */
function jarCookie(session, name) {
  const jar = session?.jar;
  if (!jar || !jar.map) return null;
  const c = jar.map.get(name);
  return c ? c.value : null;
}

/**
 * Get a usable mail `sid`.
 *
 * Reuses the persisted `sid` cookie when it still works — that saves the whole
 * handshake on every run and, more importantly, keeps the mail session alive the
 * way a browser would.
 *
 * @returns {Promise<{ok:boolean, sid?:string, reused?:boolean, error?:string, reason?:string}>}
 */
export async function openMailbox(session, cfg, { token, mailBase = DEFAULT_MAIL_BASE } = {}) {
  token?.throwIfCancelled('连接邮箱');

  const existing = jarCookie(session, 'sid');
  if (existing) {
    const probe = await listUnreadPage(session, existing, cfg, { token, mailBase });
    if (probe.ok) {
      log.debug('复用已保存的邮箱会话。');
      return { ok: true, sid: existing, reused: true };
    }
  }

  // 1. Ask the portal for a one-shot SSO URL.
  const entry = await session.fetchHtml(MAIL_SSO_ENTRY, { token });
  const sso = extractSsoUrl(entry.html);
  if (!sso) {
    return {
      ok: false,
      reason: 'sso-link-missing',
      error: `门户未返回邮箱登录跳转（HTTP ${entry.status}，${String(entry.html).length} 字节）`,
    };
  }

  // 2. Follow it. The response body carries the fresh sid.
  token?.throwIfCancelled('登录邮箱');
  const landed = await session.fetchHtml(sso, { token });
  const sid =
    extractSid(landed.finalUrl) ||
    extractSid(landed.html) ||
    jarCookie(session, 'sid');
  if (!sid) {
    return { ok: false, reason: 'sid-missing', error: '邮箱登录成功但未取得会话 ID (sid)' };
  }
  log.debug(`邮箱会话已建立 (sid=${sid.slice(0, 12)}…)。`);
  return { ok: true, sid, reused: false };
}

/** Build the URL of the unread listing. */
export function mailListUrl(sid, { mailBase = DEFAULT_MAIL_BASE, folderId = INBOX_FOLDER_ID } = {}) {
  // `flag=new` is the unread filter; `resp_charset=UTF8` avoids the gb18030 path.
  // The sid is interpolated verbatim (its `,2` suffix is part of the id and is
  // what the site's own links emit) rather than percent-encoded.
  return (
    `${mailBase}/cgi-bin/mail_list?sid=${sid}` +
    `&s=unread&folderid=${folderId}&flag=new&page=0&topmails=0&resp_charset=UTF8`
  );
}

/** Fetch the unread listing. */
async function listUnreadPage(session, sid, cfg, { token, mailBase = DEFAULT_MAIL_BASE } = {}) {
  try {
    const r = await session.fetchHtml(mailListUrl(sid, { mailBase, folderId: cfg?.portal?.mailFolderId }), {
      token,
    });
    if (!looksLikeMailList(r.html)) {
      return { ok: false, error: `邮箱返回的不是邮件列表（HTTP ${r.status}）`, html: r.html };
    }
    return { ok: true, html: r.html, status: r.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Read the unread messages.
 *
 * @returns {Promise<{ok:boolean, mails:Array<object>, total:number|null,
 *                    unread:number|null, error?:string}>}
 */
export async function fetchUnreadMails(session, cfg, { token, max, mailBase = DEFAULT_MAIL_BASE } = {}) {
  const limit = Number(max ?? cfg?.portal?.maxMails ?? 20) || 20;

  const box = await openMailbox(session, cfg, { token, mailBase });
  if (!box.ok) {
    log.warn(`读取未读邮件失败：${box.error}`);
    return { ok: false, mails: [], total: null, unread: null, error: box.error };
  }

  const page = await listUnreadPage(session, box.sid, cfg, { token, mailBase });
  if (!page.ok) {
    log.warn(`读取未读邮件失败：${page.error}`);
    return { ok: false, mails: [], total: null, unread: null, error: page.error };
  }

  const parsed = parseMailList(page.html, { filteredToUnread: true });
  const mails = parsed.mails.slice(0, limit);
  log.info(`未读邮件 ${parsed.unread ?? mails.length} 封（本次读取 ${mails.length} 条标题）`);
  return { ok: true, mails, total: parsed.total, unread: parsed.unread ?? mails.length, sid: box.sid };
}

/**
 * Convert a mail into the same shape as a portal item, so the digest renderer,
 * the dedup store and the "is anything new?" test all work unchanged.
 *
 * The dedup id is `mail:<Coremail id>`; Coremail ids are stable, so a mail that
 * stays unread is reported exactly once.
 */
export function mailToItem(mail) {
  return {
    treeId: 'mail',
    newsId: mail.id,
    key: `mail:${mail.id}`,
    title: mail.subject,
    date: mail.date,
    url: null, // per-mail URLs embed a session id that expires before the reader clicks
    source: '未读邮件',
    sender: mail.sender,
    senderAddress: mail.senderAddress,
    preview: mail.preview,
    dateText: mail.dateText,
    unread: true,
    isMail: true,
  };
}
