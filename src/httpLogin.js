/**
 * httpLogin.js — log in to BUPT CAS over plain HTTP, then hand the session to
 * the browser.
 *
 * WHY THIS EXISTS
 * ---------------
 * Driving the login form inside an automated Chrome does not work: the POST to
 *   https://auth.bupt.edu.cn/authserver/login?service=...
 * comes back **HTTP 400** (a 6-byte body, no error message, page unchanged).
 * Measurements on 2026-09-25:
 *
 *   browser  GET  /authserver/cas/login-normal.html   → 400   (cookies: 3 / 464 bytes)
 *   browser  GET  /authserver/css/index.css           → 200   (cookies: 2 / 127 bytes)
 *   browser  POST /authserver/login?service=...       → 400
 *   plain    POST /authserver/login?service=...       → 302 + ticket=ST-...   ← works
 *
 * The failing requests are exactly the ones carrying a third, large cookie that
 * the login page sets from JavaScript, so this reads as the site's bot
 * protection refusing automated browsers. (Verified separately that faking the
 * User-Agent, forcing HTTP/1.1 and every individual request header all still
 * return 200 from plain HTTP — it is browser-specific, not header-specific.)
 *
 * Rather than fight that, we do the login the way that works — a normal
 * form POST over HTTP — and then inject the resulting cookies into the browser,
 * which handles the portal fine. The account's password is never involved in
 * the blocked path any more.
 *
 * No password is ever logged by this module.
 */

import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { log } from './logger.js';
import { cancellableSleep } from './cancel.js';
import { DATA_DIR, readJson, writeJsonAtomic } from './util.js';

/** Where the session cookies are persisted between runs. */
export const COOKIE_FILE = path.join(DATA_DIR, 'http-cookies.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

const MAX_REDIRECTS = 8;

/** Minimal cookie jar: enough for one site, preserving attributes for Playwright. */
export class CookieJar {
  constructor() {
    /** @type {Map<string, {name:string,value:string,domain:string,path:string,expires:number|null,secure:boolean,httpOnly:boolean}>} */
    this.map = new Map();
  }

  static parseSetCookie(line, requestUrl) {
    const parts = String(line).split(';');
    const [pair, ...attrs] = parts;
    const i = pair.indexOf('=');
    if (i <= 0) return null;
    const cookie = {
      name: pair.slice(0, i).trim(),
      value: pair.slice(i + 1).trim(),
      domain: new URL(requestUrl).hostname,
      path: '/',
      expires: null,
      secure: false,
      httpOnly: false,
    };
    for (const a of attrs) {
      const [k, v = ''] = a.split('=');
      const key = k.trim().toLowerCase();
      if (key === 'domain' && v) cookie.domain = v.trim().replace(/^\./, '');
      else if (key === 'path' && v) cookie.path = v.trim();
      else if (key === 'secure') cookie.secure = true;
      else if (key === 'httponly') cookie.httpOnly = true;
      else if (key === 'max-age') {
        const s = Number(v);
        if (Number.isFinite(s)) cookie.expires = Math.floor(Date.now() / 1000) + s;
      } else if (key === 'expires' && !cookie.expires) {
        const t = Date.parse(v);
        if (Number.isFinite(t)) cookie.expires = Math.floor(t / 1000);
      }
    }
    return cookie;
  }

  absorb(setCookieHeaders, requestUrl) {
    for (const line of setCookieHeaders || []) {
      const c = CookieJar.parseSetCookie(line, requestUrl);
      if (c) this.map.set(c.name, c);
    }
  }

  header(url) {
    const host = new URL(url).hostname;
    const parts = [];
    for (const c of this.map.values()) {
      // Loose same-site matching: all hosts here are *.bupt.edu.cn.
      if (!host.endsWith(c.domain) && c.domain !== host) continue;
      parts.push(`${c.name}=${c.value}`);
    }
    return parts.join('; ');
  }

  get size() {
    return this.map.size;
  }

  /** Convert to the shape Playwright's context.addCookies() expects. */
  toPlaywrightCookies() {
    return [...this.map.values()].map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
      path: c.path || '/',
      secure: Boolean(c.secure),
      httpOnly: Boolean(c.httpOnly),
      ...(c.expires ? { expires: c.expires } : {}),
    }));
  }

  has(name) {
    return this.map.has(name);
  }
}

/* ------------------------------- decoding -------------------------------- */

/** Charset names Node's TextDecoder knows, normalised from page spellings. */
function normaliseCharset(label) {
  const c = String(label || '').trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!c) return 'utf-8';
  if (c === 'gbk' || c === 'gb2312' || c === 'gb-2312' || c === 'gb18030') return 'gb18030';
  if (c === 'utf8') return 'utf-8';
  return c;
}

function tryDecode(buf, charset) {
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return null;
  }
}

/**
 * Which charset is this response actually in?
 *
 * The mail system (Coremail) at mail.bupt.edu.cn answers in **gb18030** with no
 * charset in the HTTP header, only in a `<meta>` tag — decoding it as UTF-8
 * produced mojibake subjects, so the charset is sniffed rather than assumed.
 */
export function sniffCharset(buf, contentType = '') {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(String(contentType || ''));
  if (fromHeader) return normaliseCharset(fromHeader[1]);
  const head = buf.subarray(0, 8192).toString('latin1');
  const meta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head);
  if (meta) return normaliseCharset(meta[1]);
  return 'utf-8';
}

/** Decode a response body using its declared (or sniffed) charset. */
export function decodeBody(buf, contentType = '') {
  const charset = sniffCharset(buf, contentType);
  if (charset === 'utf-8') {
    const s = buf.toString('utf8');
    // Everything here claims UTF-8; if the result is full of replacement
    // characters the claim was wrong, so fall back to the other local charset.
    if (s.includes('\uFFFD')) return tryDecode(buf, 'gb18030') ?? s;
    return s;
  }
  return tryDecode(buf, charset) ?? buf.toString('utf8');
}

/**
 * One HTTP request, following redirects, collecting cookies along the way.
 * @returns {Promise<{status:number,url:string,body:string,chain:string[],location:string|null,error?:string}>}
 */
export function httpRequest(url, { method = 'GET', body = null, jar = null, headers = {}, maxRedirects = MAX_REDIRECTS } = {}) {
  const chain = [];

  const once = (target, hops, reqMethod, reqBody) =>
    new Promise((resolve) => {
      const u = new URL(target);
      const mod = u.protocol === 'https:' ? https : http;
      const cookie = jar ? jar.header(target) : '';
      const req = mod.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: `${u.pathname}${u.search}`,
          method: reqMethod,
          timeout: 25000,
          rejectUnauthorized: false,
          headers: {
            'User-Agent': UA,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Upgrade-Insecure-Requests': '1',
            ...(cookie ? { Cookie: cookie } : {}),
            ...(reqBody
              ? {
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'Content-Length': Buffer.byteLength(reqBody),
                }
              : {}),
            ...headers,
          },
        },
        (res) => {
          if (jar) jar.absorb(res.headers['set-cookie'], target);
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', async () => {
            const loc = res.headers.location || null;
            const isRedirect = [301, 302, 303, 307, 308].includes(res.statusCode) && loc;
            if (isRedirect && hops < maxRedirects) {
              const next = new URL(loc, target).href;
              chain.push(next);
              // 307/308 keep the method and body; everything else becomes a GET.
              // This matters: a 302 after the credential POST must NOT re-post it.
              const keep = res.statusCode === 307 || res.statusCode === 308;
              const r = await once(next, hops + 1, keep ? reqMethod : 'GET', keep ? reqBody : null);
              return resolve(r);
            }
            resolve({
              status: res.statusCode,
              url: target,
              // Charset-aware: the portal is UTF-8, the mail system is gb18030.
              body: decodeBody(Buffer.concat(chunks), res.headers['content-type']),
              location: loc,
              chain,
            });
          });
        },
      );
      req.on('timeout', () => {
        req.destroy();
        resolve({ status: 0, url: target, body: '', location: null, chain, error: 'timeout' });
      });
      req.on('error', (e) => resolve({ status: 0, url: target, body: '', location: null, chain, error: e.code || e.message }));
      if (reqBody) req.write(reqBody);
      req.end();
    });

  return once(url, 0, method, body);
}

/** Pull a hidden input's value out of an HTML form. */
export function extractHiddenInput(html, name) {
  const s = String(html || '');
  const a = s.match(new RegExp(`name=["']${name}["'][^>]*value=["']([^"']*)["']`, 'i'));
  if (a) return a[1];
  const b = s.match(new RegExp(`value=["']([^"']*)["'][^>]*name=["']${name}["']`, 'i'));
  return b ? b[1] : '';
}

/**
 * A page that reliably reflects the authentication state.
 * NOT the portal root — that is a JavaScript redirect stub.
 */
export function defaultVerifyUrl(baseUrl) {
  return new URL('list.jsp?urltype=tree.TreeTempUrl&wbtreeid=1154', baseUrl).href;
}

/* ----------------------------- persistence ------------------------------ */

/** Persist the cookie jar so the session survives a restart. */
export function saveJar(jar, file) {
  writeJsonAtomic(file, {
    version: 1,
    savedAt: new Date().toISOString(),
    cookies: [...jar.map.values()],
  });
  return file;
}

/** Load a persisted cookie jar (empty when the file is missing/corrupt). */
export function loadJar(file) {
  const jar = new CookieJar();
  const raw = readJson(file, null);
  if (raw && Array.isArray(raw.cookies)) {
    for (const c of raw.cookies) {
      if (c && c.name) jar.map.set(c.name, c);
    }
  }
  return jar;
}

/**
 * Log in with the given credentials over HTTP.
 *
 * @returns {Promise<{ok:boolean, reason?:string, credentialRejected?:boolean,
 *                    cookies?:import('playwright-core').BrowserContextCookiesResult,
 *                    ticket?:string, jar?:CookieJar}>}
 */
export async function loginViaHttp({ baseUrl, username, password, token, verifyUrls = [] } = {}) {
  if (!username || !password) return { ok: false, reason: '凭据为空' };

  const jar = new CookieJar();
  token?.throwIfCancelled('HTTP 登录');

  // --- 1. Reach the login page (follows the portal -> CAS redirects) --------
  const entry = await httpRequest(baseUrl, { jar });
  if (entry.error) return { ok: false, reason: `无法访问门户: ${entry.error}` };

  const isLoginPage = /authserver\/login|clogin\.jsp/.test(entry.url) || /id=["']loginForm["']/.test(entry.body);
  if (!isLoginPage) {
    // Already authenticated (or an unexpected page).
    const probe = await httpRequest(baseUrl, { jar });
    if (/clogout\.jsp|欢迎您/.test(probe.body)) {
      return { ok: true, reason: 'already', jar, cookies: jar.toPlaywrightCookies() };
    }
    return { ok: false, reason: `未找到登录表单（最终地址 ${entry.url}）` };
  }

  const execution = extractHiddenInput(entry.body, 'execution');
  const eventId = extractHiddenInput(entry.body, '_eventId') || 'submit';
  if (!execution) {
    return { ok: false, reason: '登录页缺少 execution 字段，无法提交' };
  }

  // --- 2. POST the credentials ---------------------------------------------
  token?.throwIfCancelled('HTTP 登录');
  const form = new URLSearchParams({
    username,
    password,
    type: 'username_password',
    execution,
    _eventId: eventId,
    submit: '登录',
  }).toString();

  const post = await httpRequest(entry.url, {
    method: 'POST',
    body: form,
    jar,
    headers: { Referer: entry.url, Origin: new URL(entry.url).origin },
  });

  if (post.error) return { ok: false, reason: `登录请求失败: ${post.error}`, jar };

  // A CAS service ticket appears in the redirect chain when the credentials were
  // accepted — the authoritative success signal.
  const ticket =
    [...post.chain, post.url].map((u) => (u.match(/[?&]ticket=(ST-[^&]+)/) || [])[1]).find(Boolean) || '';

  // --- 3. Decide whether we are authenticated ------------------------------
  // NOTE: redirects are followed, so `post.status` is the FINAL status (usually
  // 200), never the 302.
  //
  // We deliberately do NOT require logged-in markers on `baseUrl`: the portal
  // root is a 954-byte JavaScript redirect stub with no `clogout.jsp` and no
  // `欢迎您`, which made an earlier version report failure on a good login.
  if (ticket) {
    log.info(`HTTP 登录成功（已取得 CAS 服务票据 ${ticket.slice(0, 16)}…）。`);
    return { ok: true, reason: 'ok', ticket, jar, cookies: jar.toPlaywrightCookies() };
  }

  // No ticket: confirm against pages that really reflect auth state.
  const verifyTargets = [...(verifyUrls || []), defaultVerifyUrl(baseUrl)];
  let sawBadRequest = post.status === 400;
  for (const url of verifyTargets) {
    const r = await httpRequest(url, { jar });
    if (r.status === 400) sawBadRequest = true;
    if (/clogout\.jsp|欢迎您/.test(r.body)) {
      log.info('HTTP 登录成功（门户页面已显示已登录状态）。');
      return { ok: true, reason: 'ok', jar, cookies: jar.toPlaywrightCookies() };
    }
  }

  if (sawBadRequest) {
    return {
      ok: false,
      credentialRejected: false,
      reason: '登录请求被服务器以 HTTP 400 拒绝（协议层拒绝，与账号密码无关）',
      jar,
    };
  }

  const errText = extractHiddenInput(post.body, 'error') || '';
  const pageHint = /用户名或密码|密码错误|验证码/.test(post.body) ? post.body.match(/用户名或密码[^<]{0,20}|密码[^<]{0,10}错误|验证码[^<]{0,10}错误/)?.[0] : '';
  const reason = pageHint || errText || `登录未成功（HTTP ${post.status}${post.location ? ` → ${String(post.location).slice(0, 80)}` : ''}）`;

  return {
    ok: false,
    // Only an explicit credential message counts as a rejection.
    credentialRejected: Boolean(pageHint && /密码|用户名|账号|验证码/.test(pageHint)),
    reason,
    jar,
  };
}
