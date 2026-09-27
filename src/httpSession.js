/**
 * httpSession.js — the normal operating session.
 *
 * WHY THIS REPLACED THE BROWSER FOR SCRAPING
 * ------------------------------------------
 * The portal is a server-rendered VSB site and reads perfectly over plain HTTP
 * (verified: list.jsp for both columns returns HTTP 200 with 20 article links
 * each). Meanwhile an automated Chrome is actively obstructed:
 *
 *   - the login POST from Chrome gets HTTP 400 (bot protection)
 *   - the login iframe (/authserver/cas/login-normal.html) gets HTTP 400
 *   - and injecting the Node session's cookies into Chrome did NOT make the
 *     browser authenticated (verified: still redirected to CAS)
 *
 * So: authenticate over HTTP, scrape over HTTP, and keep Chrome only for the
 * one thing it is genuinely needed for — showing a human a login window when
 * there are no stored credentials.
 *
 * This also makes runs much lighter (no 15-process Chrome per poll) and lets the
 * session be persisted to disk, so we are not logging in on every single run.
 *
 * Interface matches what the collector needs from a session:
 *   launch(), close(), fetchHtml(url, {token}), isLoggedIn(), ensureLoggedIn()
 */

import fs from 'node:fs';
import { log } from './logger.js';
import { httpRequest, loginViaHttp, loadJar, saveJar, defaultVerifyUrl, COOKIE_FILE } from './httpLogin.js';
import { PortalSession } from './fetcher.js';
import { classifyPage, PAGE } from './vsb.js';
import { cancellableSleep, isCancellation } from './cancel.js';

/** How many article links a list page must expose to count as "logged in". */
const MIN_ITEMS_FOR_AUTH = 1;

export class HttpSession {
  constructor(cfg, { cookieFile = COOKIE_FILE } = {}) {
    this.cfg = cfg;
    this.cookieFile = cookieFile;
    this.jar = loadJar(cookieFile);
    this.httpOnly = true;
    /** Created lazily, only when a human needs to log in. */
    this.browser = null;
    this.startedAt = null;
  }

  get cookieCount() {
    return this.jar.size;
  }

  /** No browser to launch on the happy path. */
  async launch() {
    this.startedAt = new Date();
    log.debug(`HTTP 会话就绪（已载入 ${this.jar.size} 个 Cookie）。`);
    return this;
  }

  async close() {
    try {
      saveJar(this.jar, this.cookieFile);
    } catch {
      /* best effort */
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  /** Drop the stored session (used by the "清除登录会话" button). */
  clearCookies() {
    this.jar.map.clear();
    try {
      if (fs.existsSync(this.cookieFile)) fs.unlinkSync(this.cookieFile);
    } catch {
      /* ignore */
    }
    return 0;
  }

  /**
   * Fetch a page over HTTP. Same contract as PortalSession.fetchHtml().
   *
   * `headers` are extra request headers — the 待办中心 widget endpoint refuses
   * any request whose Referer is not the homepage ("错误的访问来源").
   */
  async fetchHtml(url, { token, headers } = {}) {
    token?.throwIfCancelled('抓取页面');
    const r = await httpRequest(url, { jar: this.jar, ...(headers ? { headers } : {}) });
    // Persist whatever the server set (session refresh, CSRF, …).
    saveJar(this.jar, this.cookieFile);
    if (r.error) throw new Error(`请求失败: ${r.error}`);
    return { html: r.body, status: r.status, finalUrl: r.url };
  }

  /** URLs that reliably reflect the authentication state. */
  probeUrls() {
    const urls = [];
    for (const t of this.cfg.targets || []) if (t.url) urls.push(t.url);
    try {
      urls.push(defaultVerifyUrl(this.cfg.baseUrl));
    } catch {
      /* ignore */
    }
    urls.push(this.cfg.baseUrl);
    return [...new Set(urls)];
  }

  /**
   * Are we logged in? Judged on pages that actually need auth — NOT the portal
   * root, which is a JavaScript redirect stub (954 bytes, no `clogout.jsp`).
   */
  async isLoggedIn() {
    const attempts = [];
    for (const url of this.probeUrls()) {
      try {
        const r = await httpRequest(url, { jar: this.jar });
        const page = classifyPage(r.body, { finalUrl: r.url });
        if (page.kind === PAGE.LOGIN) {
          attempts.push(`${url} → 需要登录`);
          continue;
        }
        const itemCount = (r.body.match(/wbnewsid=\d+/g) || []).length;
        const hasMarker = /clogout\.jsp/i.test(r.body) || /欢迎您/.test(r.body);
        if (hasMarker && (itemCount >= MIN_ITEMS_FOR_AUTH || page.kind === PAGE.CONTENT)) {
          return { ok: true, url, itemCount };
        }
        if (hasMarker) return { ok: true, url, itemCount };
        attempts.push(`${url} → 无登录标志 (${page.kind})`);
      } catch (err) {
        attempts.push(`${url} → ${err.message.split('\n')[0]}`);
      }
    }
    return { ok: false, reason: `所有探测地址都未显示已登录状态：${attempts.join('; ')}` };
  }

  /** Start (or reuse) a browser, for the manual-login path only. */
  async ensureBrowser({ headless = this.cfg.session.headless } = {}) {
    if (!this.browser) this.browser = new PortalSession(this.cfg);
    if (!this.browser.context) await this.browser.launch({ headless });
    return this.browser;
  }

  /**
   * Make sure we hold a live session.
   *
   *   1. reuse the persisted cookies
   *   2. log in over HTTP with stored credentials
   *   3. fall back to a browser window for a manual login
   */
  async ensureLoggedIn({
    notify = () => {},
    credentials = null,
    allowAutoLogin = true,
    autoLoginBlockReason = '',
    allowManualLogin = true,
    token,
  } = {}) {
    token?.throwIfCancelled('登录检查');

    // 1. Reuse the persisted session.
    let state = await this.isLoggedIn();
    if (state.ok) {
      log.info(`复用已保存的登录会话（${state.itemCount || 0} 个条目可读）。`);
      return { ok: true, method: 'reused' };
    }
    log.warn(`登录状态无效: ${String(state.reason).slice(0, 140)}`);

    // 2. HTTP login.
    if (allowAutoLogin && credentials?.username && credentials?.password) {
      log.info(`尝试通过 HTTP 自动登录（${credentials.username}）…`);
      const r = await loginViaHttp({
        baseUrl: this.cfg.baseUrl,
        username: credentials.username,
        password: credentials.password,
        token,
        verifyUrls: (this.cfg.targets || []).map((t) => t.url).filter(Boolean),
      });
      if (token?.cancelled) return { ok: false, cancelled: true, reason: '已被停止' };
      if (r.ok) {
        this.jar = r.jar;
        saveJar(this.jar, this.cookieFile);
        const check = await this.isLoggedIn();
        if (check.ok) {
          log.info('自动登录成功，HTTP 会话已保存。');
          return { ok: true, method: 'auto-http' };
        }
        log.warn(`HTTP 登录取得票据，但会话校验未通过：${String(check.reason).slice(0, 120)}`);
      } else {
        log.warn(`HTTP 自动登录失败：${r.reason}`);
        if (r.credentialRejected) {
          return { ok: false, method: 'auto-http', credentialRejected: true, reason: r.reason };
        }
      }
    } else if (!allowAutoLogin && autoLoginBlockReason === 'no-credentials') {
      log.info('尚未保存统一身份认证账号密码，需要手动登录一次。可在控制面板里保存账号以启用自动登录。');
    } else if (!allowAutoLogin) {
      log.warn('自动登录暂时停用（连续失败过多，避免账号被锁定），转入手动登录。');
    }

    // 3. Manual login in a visible browser window.
    //
    // Background runs must not open a window, so unless manual login is allowed
    // we stop here and report it. The next scheduled run will retry, and the
    // control panel is where a human can log in interactively.
    if (!allowManualLogin) {
      log.warn(
        '需要手动登录才能继续，但本次是后台定时任务，不会打开浏览器窗口。' +
          '请打开控制面板（双击桌面图标）登录一次，之后会自动复用会话。',
      );
      return {
        ok: false,
        method: 'manual-skipped',
        reason: '需要手动登录（后台运行不弹窗）；请打开控制面板登录一次',
      };
    }

    const browser = await this.ensureBrowser({ headless: false });
    const result = await browser.ensureLoggedIn({
      notify,
      credentials: null, // do not let the browser retry the blocked login path
      allowAutoLogin: false,
      autoLoginBlockReason,
      token,
    });
    if (!result.ok) return result;

    // Adopt the browser's cookies so subsequent runs can stay HTTP-only.
    try {
      const cookies = await browser.context.cookies();
      const { CookieJar } = await import('./httpLogin.js');
      const jar = new CookieJar();
      for (const c of cookies) {
        if (!/bupt\.edu\.cn$/.test(String(c.domain).replace(/^\./, ''))) continue;
        jar.map.set(c.name, {
          name: c.name,
          value: c.value,
          domain: String(c.domain).replace(/^\./, ''),
          path: c.path || '/',
          expires: c.expires && c.expires > 0 ? Math.floor(c.expires) : null,
          secure: Boolean(c.secure),
          httpOnly: Boolean(c.httpOnly),
        });
      }
      if (jar.size) {
        this.jar = jar;
        saveJar(this.jar, this.cookieFile);
        log.info(`已从浏览器接管 ${jar.size} 个 Cookie，后续运行可直接使用。`);
      }
    } catch (err) {
      log.debug(`接管浏览器 Cookie 失败: ${err.message}`);
    }
    return { ok: true, method: 'manual' };
  }
}
