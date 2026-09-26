/**
 * fetcher.js — authenticated access to my.bupt.edu.cn.
 *
 * The portal is behind CAS single sign-on (the saved homepage shows
 * "田孟阳,欢迎您！" and a clogout.jsp link), so plain unauthenticated HTTP is not
 * enough. We drive the *installed* Chrome through playwright-core with a
 * dedicated persistent profile directory:
 *
 *   - no browser download (playwright-core + channel:"chrome")
 *   - the CAS session cookie lives in data/chrome-profile and survives reboots
 *   - the user's own Chrome profile is never touched, so no "close Chrome first"
 *     friction and no risk to their real session
 *
 * Headless is used for routine polling. If the session has expired we relaunch
 * a VISIBLE window, let the user log in once, and the cookie is persisted.
 */

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { log } from './logger.js';
import { sleep, ensureDir } from './util.js';
import { looksLikeLoginPage, classifyPage, isAuthUrl, PAGE, extractLoginError, isCredentialRejection } from './vsb.js';
import { cancellableSleep, isCancellation } from './cancel.js';
import { loginViaHttp } from './httpLogin.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Selectors for the BUPT CAS login form, verified against the live page
 * captured from https://auth.bupt.edu.cn/authserver/login on 2026-09-25:
 *
 *   <input type="text"     class="form-control" name="username">
 *   <input type="password" class="form-control" name="password" autocomplete="off">
 *   <input class="btn btn-login" type="submit" name="submit" value="登录">
 *   <input name="execution" value="...">      (hidden, per-request)
 *
 * Notably there is NO client-side password encryption (no pwdDefaultEncryptSalt,
 * no AES/CryptoJS), so filling the visible fields and clicking the real submit
 * button is sufficient and correct.
 */
const SEL = {
  username: [
    'input[name="username"]',
    '#username',
    'input[name="uname"]',
    'input[name="userName"]',
    'input[type="text"][name*="user" i]',
    'input[type="text"]',
  ],
  password: ['input[name="password"]', '#password', 'input[type="password"]'],
  submit: [
    'input[type="submit"]',
    'button[type="submit"]',
    '.btn-login',
    '#loginButton',
    'button[name="submit"]',
    'button',
  ],
};

/** Return the first selector in `list` that exists on the page. */
async function firstPresent(page, list) {
  for (const sel of list) {
    const loc = page.locator(sel).first();
    try {
      if ((await loc.count()) > 0) return sel;
    } catch {
      /* selector not usable; try the next */
    }
  }
  return null;
}

/**
 * Is this page a logged-in portal page?
 * Used both for the initial session check and to detect login completion.
 */
function pageIsLoggedIn(html, url) {
  if (!html) return false;
  if (isAuthUrl(url)) return false;
  return /clogout\.jsp/i.test(html) || /欢迎您/.test(html);
}


export class PortalSession {
  constructor(cfg) {
    this.cfg = cfg;
    this.context = null;
    this.headless = cfg.session.headless;
  }

  get profileDir() {
    return this.cfg.session.profileDir;
  }

  async launch({ headless = this.headless } = {}) {
    await this.close();
    ensureDir(this.profileDir);
    this.headless = headless;
    log.info(`启动浏览器 (${headless ? '无头' : '可见'}模式), 配置目录: ${this.profileDir}`);

    // Only override the User-Agent if explicitly configured. Leaving it unset
    // uses Chrome's real UA, which stays consistent with its Sec-CH-UA hints.
    const launchOpts = {
      channel: this.cfg.session.channel || 'chrome',
      headless,
      locale: 'zh-CN',
      viewport: { width: 1280, height: 900 },
      ignoreHTTPSErrors: true,
      args: [
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,OptimizationHints',
        '--disable-background-networking',
      ],
    };
    if (this.cfg.session.userAgent) launchOpts.userAgent = this.cfg.session.userAgent;

    this.context = await chromium.launchPersistentContext(this.profileDir, launchOpts);
    this.context.setDefaultTimeout(30000);
    this.context.setDefaultNavigationTimeout(45000);
    return this.context;
  }

  async close() {
    if (!this.context) return;
    try {
      await this.context.close();
    } catch (err) {
      log.debug(`关闭浏览器上下文时出错: ${err.message}`);
    }
    this.context = null;
  }

  async newPage() {
    if (!this.context) await this.launch();
    const page = await this.context.newPage();
    page.setDefaultTimeout(30000);
    return page;
  }

  /** Fetch a URL's HTML through the browser (carries cookies, runs any JS). */
  async fetchHtml(url, { token } = {}) {
    token?.throwIfCancelled('抓取页面');
    const page = await this.newPage();
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const html = await page.content();
      return { html, status: resp ? resp.status() : null, finalUrl: page.url() };
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Drop cookies for the BUPT portal and its CAS server.
   *
   * WHY THIS IS NEEDED: the CAS server answers **HTTP 400 with an empty body**
   * when the login page is requested again while a stale *anonymous* session
   * cookie is still present. Measured on 2026-09-25 (fresh profile, 3 visits):
   *
   *   with a fake UA        : 200 → 400 → 400
   *   with the real UA      : 200 → 400 → 400
   *   with cookies cleared  : 200 → 200 → 200
   *
   * So the blocker is cookie state, NOT the User-Agent. Without this, the login
   * page renders blank and BOTH automatic and manual login become impossible.
   */
  async clearAuthCookies() {
    if (!this.context) return 0;
    let removed = 0;
    try {
      const all = await this.context.cookies();
      const targets = all.filter((c) => /bupt\.edu\.cn$/i.test(String(c.domain).replace(/^\./, '')));
      for (const c of targets) {
        try {
          await this.context.clearCookies({ name: c.name, domain: c.domain, path: c.path || '/' });
          removed += 1;
        } catch {
          /* fall through to the blanket clear below if this ever fails */
        }
      }
      if (targets.length && removed === 0) {
        await this.context.clearCookies();
        removed = targets.length;
      }
    } catch (err) {
      log.debug(`清除认证 Cookie 失败: ${err.message}`);
    }
    return removed;
  }

  /**
   * How many of the expected login fields exist on `page`.
   * NOTE: existence only. The CAS page keeps a HIDDEN copy of the form in
   * `#default`, so existence is not the same as being usable — use
   * countVisibleLoginFields() before trying to type into them.
   */
  async countLoginFields(page) {
    let n = 0;
    for (const list of [SEL.username, SEL.password]) {
      for (const sel of list) {
        const c = await page.locator(sel).first().count().catch(() => 0);
        if (c > 0) {
          n += 1;
          break;
        }
      }
    }
    return n;
  }

  /**
   * Navigate to the portal and make sure the CAS login form is actually
   * rendered, clearing a stale auth cookie and retrying once if it is not.
   *
   * @returns {Promise<{ok:boolean, reason?:string, cleared:number, fields:number, url:string}>}
   */
  async gotoLoginPage(page) {
    let cleared = 0;
    await page.goto(this.cfg.baseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(900);

    // A CAS page counts as loaded when the login UI is present at all:
    // either visible fields, or the built-in #loginForm (which the page hides by
    // design while it tries to show the iframe). Only a page with NEITHER is
    // genuinely broken — that is the stale-cookie HTTP 400 case.
    let fields = await this.countVisibleLoginFields(page);
    let present = await this.countLoginFields(page);
    if (fields > 0 || present >= 2) {
      return { ok: true, cleared, fields, present, url: page.url() };
    }

    cleared = await this.clearAuthCookies();
    if (cleared > 0) {
      log.info(`登录页未正常渲染，已清除 ${cleared} 个过期认证 Cookie 后重试…`);
      await page.goto('about:blank').catch(() => {});
      await page.goto(this.cfg.baseUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(1200);
      fields = await this.countVisibleLoginFields(page);
      present = await this.countLoginFields(page);
    }

    if (fields > 0 || present >= 2) {
      return { ok: true, cleared, fields, present, url: page.url() };
    }
    return {
      ok: false,
      reason: `登录页没有渲染出登录表单 (url=${page.url()}, 可见字段=${fields}, 隐藏字段=${present})`,
      cleared,
      fields,
      present,
      url: page.url(),
    };
  }

  /**
   * URLs worth probing when deciding whether we hold a valid session.
   *
   * CRUCIALLY not the portal root: `http://my.bupt.edu.cn/` returns a 954-byte
   * JavaScript redirect stub
   *
   *   <script>window.location.href="xs_index.jsp?urltype=tree.TreeTempUrl&..."</script>
   *
   * with no `clogout.jsp` and no `欢迎您`. A real browser follows that redirect,
   * so the old root-only check happened to work in the browser — but it made the
   * tool report "登录状态无效" on every single run (and re-login pointlessly)
   * whenever the marker was looked for without running JS.
   *
   * The list pages we actually need are the best evidence: if we can read them,
   * we are authenticated. They reliably carry `clogout.jsp` + `欢迎您`.
   */
  probeUrls() {
    const urls = [];
    for (const t of this.cfg.targets || []) {
      if (t.url) urls.push(t.url);
    }
    try {
      urls.push(new URL('xs_index.jsp?urltype=tree.TreeTempUrl&wbtreeid=1541', this.cfg.baseUrl).href);
    } catch {
      /* baseUrl unusable */
    }
    urls.push(this.cfg.baseUrl);
    return [...new Set(urls)];
  }

  /** True when the CAS session is still valid. */
  async isLoggedIn() {
    const attempts = [];
    for (const url of this.probeUrls()) {
      try {
        const { html, finalUrl } = await this.fetchHtml(url);
        const page = classifyPage(html, { finalUrl });

        if (page.kind === PAGE.LOGIN) {
          attempts.push(`${url} → 需要登录`);
          continue;
        }
        if (page.kind === PAGE.ERROR) {
          attempts.push(`${url} → 门户错误页`);
          continue;
        }
        // Logged-in portal pages expose the logout link and the greeting.
        if (/clogout\.jsp/i.test(html) || /欢迎您/.test(html)) {
          return { ok: true, url };
        }
        attempts.push(`${url} → 无登录标志 (${page.kind})`);
      } catch (err) {
        attempts.push(`${url} → ${err.message.split('\n')[0]}`);
      }
    }
    return {
      ok: false,
      reason: `所有探测地址都未显示已登录状态：${attempts.join('; ')}`,
    };
  }

  /**
   * Inspect whether the login iframe actually rendered the login form.
   *
   * The CAS page is laid out as a FULL-VIEWPORT iframe containing the real login
   * UI, followed in normal flow by a hidden fallback panel:
   *
   *   <iframe id="loginIframe" src="/authserver/cas/login-normal.html">  ← 1280x900 @0,0
   *   <div id="default" style="display:none"> … <form id="loginForm">     ← behind + below it
   *
   * When login-normal.html fails (verified: HTTP 400 with a 39-byte body), the
   * iframe is an empty sheet of glass: it both COVERS the fallback form and, by
   * still taking part in layout, pushes it ~1285px down the page. That is why the
   * manual-login window looked completely blank.
   */
  async inspectLoginUi(page) {
    return page
      .evaluate(() => {
        const iframe = document.querySelector('#loginIframe');
        const def = document.getElementById('default');
        let iframeUsable = false;
        let iframeLen = 0;
        let iframeInputs = 0;
        let iframeError = null;
        let iframeCrossOrigin = false;
        try {
          const doc = iframe && iframe.contentDocument;
          if (doc) {
            iframeLen = doc.documentElement ? doc.documentElement.outerHTML.length : 0;
            iframeInputs = doc.querySelectorAll('input').length;
            const html = doc.documentElement ? doc.documentElement.innerHTML : '';
            iframeUsable = iframeInputs > 0 && /id=["']?(username|password)["']?/i.test(html);
          } else {
            // No contentDocument: the frame is cross-origin (or not loaded yet).
            // We cannot inspect it, and it may well be working, so we must NOT
            // hide it — assume usable and leave the page alone.
            iframeCrossOrigin = true;
            iframeUsable = true;
            iframeError = 'contentDocument inaccessible (cross-origin)';
          }
        } catch (e) {
          iframeError = String(e && e.message);
        }
        const u = document.querySelector('#loginForm input[name=username]');
        const r = u ? u.getBoundingClientRect() : null;
        return {
          hasIframe: Boolean(iframe),
          iframeUsable,
          iframeLen,
          iframeInputs,
          iframeError,
          iframeCrossOrigin,
          iframeDisplay: iframe ? getComputedStyle(iframe).display : null,
          iframeRect: iframe
            ? (() => {
                const b = iframe.getBoundingClientRect();
                return { w: Math.round(b.width), h: Math.round(b.height), y: Math.round(b.y) };
              })()
            : null,
          hasFallbackPanel: Boolean(def),
          fallbackDisplay: def ? getComputedStyle(def).display : null,
          usernameY: r ? Math.round(r.y) : null,
          viewportHeight: window.innerHeight,
        };
      })
      .catch((err) => ({ error: err.message.split('\n')[0] }));
  }

  /**
   * Make the CAS page usable for a human.
   *
   * Two cases:
   *   - the iframe rendered the real (pretty) login UI → leave it alone;
   *   - the iframe failed → hide it and surface the built-in fallback panel at
   *     the top of the page, so the user gets a working, styled form instead of
   *     a blank window.
   *
   * @returns {Promise<{mode:'iframe'|'fallback'|'none', fields:number, before:object}>}
   */
  async prepareManualLoginUi(page) {
    const before = await this.inspectLoginUi(page);
    if (before.error) return { mode: 'none', fields: 0, before };

    if (before.iframeUsable) {
      return { mode: 'iframe', fields: await this.countVisibleLoginFields(page), before };
    }

    // The iframe is empty/broken: take it out of the layout entirely. Removing it
    // both uncovers and un-offsets the fallback form.
    await page
      .evaluate(() => {
        const iframe = document.querySelector('#loginIframe');
        if (iframe) {
          iframe.style.display = 'none';
          iframe.setAttribute('aria-hidden', 'true');
        }
        const def = document.getElementById('default');
        if (def) {
          def.style.display = 'block';
          // Bootstrap classes assume a full-width container; pin it to the top
          // so it is immediately visible without scrolling.
          def.style.position = 'relative';
          def.style.zIndex = '10';
          def.style.margin = '0 auto';
          def.style.paddingTop = '40px';
          def.style.minHeight = '100vh';
        }
        // Neutralise anything that could keep the page scrolled oddly.
        try {
          document.documentElement.scrollTop = 0;
          document.body.scrollTop = 0;
        } catch {
          /* ignore */
        }
      })
      .catch(() => {});

    await sleep(250);
    const fields = await this.countVisibleLoginFields(page);
    const after = await this.inspectLoginUi(page);
    log.info(
      `登录 iframe 未加载（返回空内容），已隐藏它并显示内置的账号密码登录面板` +
        `（表单位置 y: ${before.usernameY} → ${after.usernameY}）。`,
    );
    return { mode: fields > 0 ? 'fallback' : 'none', fields, before, after };
  }

  /**
   * Make the CAS username/password panel usable even when the login iframe
   * fails to load. Retained as the name used by earlier call sites.
   *
   * @returns {Promise<number>} how many login fields are now visible
   */
  async revealLoginForm(page) {
    const r = await this.prepareManualLoginUi(page);
    if (r.mode === 'iframe') return r.fields;
    if (r.mode === 'fallback') return r.fields;
    // Last resort: try the plain reveal, in case the page differs.
    await page
      .evaluate(() => {
        const d = document.getElementById('default');
        if (d) d.style.display = 'block';
      })
      .catch(() => {});
    await sleep(200);
    return this.countVisibleLoginFields(page);
  }

  /** Count login fields that are actually visible (actionable). */
  async countVisibleLoginFields(page) {
    let n = 0;
    for (const list of [SEL.username, SEL.password]) {
      for (const sel of list) {
        const loc = page.locator(sel).first();
        const c = await loc.count().catch(() => 0);
        if (c > 0 && (await loc.isVisible().catch(() => false))) {
          n += 1;
          break;
        }
      }
    }
    return n;
  }

  /**
   * Log in over plain HTTP and adopt the resulting session in the browser.
   *
   * The site's bot protection answers HTTP 400 to the login POST from an
   * automated Chrome (see src/httpLogin.js), but the same form POST over plain
   * HTTP returns 302 with a CAS ticket. So we authenticate with Node, then copy
   * the cookies into the browser context, which handles the portal itself fine.
   *
   * @returns {Promise<{ok:boolean, reason?:string, cancelled?:boolean, credentialRejected?:boolean}>}
   */
  async loginViaHttpAndAdopt(username, password, { token } = {}) {
    try {
      token?.throwIfCancelled('HTTP 登录');
      log.info(`尝试通过 HTTP 登录（${username}）…`);
      const r = await loginViaHttp({ baseUrl: this.cfg.baseUrl, username, password, token });
      if (token?.cancelled) return { ok: false, cancelled: true, reason: '已被停止' };

      if (!r.ok) {
        log.warn(`HTTP 登录失败：${r.reason}`);
        return { ok: false, reason: r.reason, credentialRejected: Boolean(r.credentialRejected) };
      }

      if (r.cookies?.length && this.context) {
        try {
          await this.context.addCookies(r.cookies);
          log.info(`已将 ${r.cookies.length} 个会话 Cookie 注入浏览器。`);
        } catch (err) {
          log.warn(`注入 Cookie 失败: ${err.message}`);
          return { ok: false, reason: `登录成功但无法把会话交给浏览器: ${err.message}` };
        }
      }

      // Confirm the browser really is authenticated before we trust it.
      const state = await this.isLoggedIn();
      if (!state.ok) {
        log.warn(`HTTP 登录成功，但浏览器仍未通过校验：${state.reason}`);
        return { ok: false, reason: `登录成功但浏览器会话未生效: ${state.reason}` };
      }
      log.info('HTTP 登录成功，浏览器会话已就绪。');
      return { ok: true, reason: 'ok' };
    } catch (err) {
      if (isCancellation(err, token)) return { ok: false, cancelled: true, reason: '已被停止' };
      return { ok: false, reason: `HTTP 登录异常: ${err.message}` };
    }
  }

  /**
   * Log in automatically with saved 统一身份认证 credentials.
   *
   * The portal's CAS page exposes a global submit helper (verified live):
   *
   *   function doLogin(username, password, type, captcha) {
   *     if (firstLogin) firstLogin = false; else return;     // one shot per load
   *     $('#loginForm input[name=username]').val(username);
   *     $('#loginForm input[name=password]').val(password);
   *     $('#loginForm input[name=type]').val(type);
   *     if (captcha) $('#loginForm input[name=captcha]').val(captcha);
   *     $('#loginForm input[name=submit]').click();
   *   }
   *
   * Calling it in the page context is the most robust path: it uses the site's
   * own submission logic, works even though `#default` is display:none, and does
   * not depend on the login iframe loading at all.
   *
   * `doLogin` fires only once per page load (the firstLogin latch), so a retry
   * means reloading the page.
   *
   * @returns {Promise<{ok:boolean, reason?:string, stage?:string, captchaRequired?:boolean}>}
   */
  async loginWithCredentials(username, password, { token } = {}) {
    if (!username || !password) return { ok: false, reason: '凭据为空', stage: 'input' };

    const page = await this.newPage();
    try {
      token?.throwIfCancelled('自动登录');
      log.info(`尝试使用已保存的账号自动登录 (${username})…`);

      const nav = await this.gotoLoginPage(page);
      let html = await page.content();
      if (pageIsLoggedIn(html, page.url())) {
        log.info('自动登录：会话本就有效。');
        return { ok: true, reason: 'already' };
      }

      // --- Primary path: call the page's own doLogin() -----------------------
      const attempt = await page
        .evaluate(
          ({ u, p }) => {
            if (typeof window.doLogin !== 'function') return { ok: false, why: 'no-doLogin' };
            let cfg = {};
            try {
              cfg = typeof window.getPageConfig === 'function' ? window.getPageConfig() || {} : window.config || {};
            } catch {
              cfg = {};
            }
            if (cfg && cfg.captcha) return { ok: false, why: 'captcha-required' };
            try {
              window.doLogin(u, p, 'username_password');
              return { ok: true, why: 'submitted' };
            } catch (e) {
              return { ok: false, why: `throw:${e && e.message ? e.message : e}` };
            }
          },
          { u: username, p: password },
        )
        .catch((e) => ({ ok: false, why: `evaluate-failed:${e.message.split('\n')[0]}` }));

      log.debug(`doLogin 调用结果: ${JSON.stringify(attempt)}`);

      if (attempt.why === 'captcha-required') {
        log.warn('该账号登录需要验证码，无法全自动登录，将转入手动登录。');
        return {
          ok: false,
          stage: 'captcha',
          captchaRequired: true,
          reason: '统一身份认证要求输入验证码，需要手动登录一次',
        };
      }

      // --- Fallback: fill the (possibly hidden) form and click submit --------
      if (!attempt.ok) {
        log.warn(`页面未提供 doLogin（${attempt.why}），改用直接填表提交。`);
        await this.revealLoginForm(page);
        const userSel = await firstPresent(page, SEL.username);
        const passSel = await firstPresent(page, SEL.password);
        if (!userSel || !passSel) {
          return {
            ok: false,
            stage: 'form',
            reason: `${nav.reason || '未找到登录表单'}（doLogin: ${attempt.why}）`,
          };
        }
        await page.fill(userSel, username, { force: true });
        await page.fill(passSel, password, { force: true });
        const submitSel = await firstPresent(page, SEL.submit);
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
          submitSel
            ? page.click(submitSel, { timeout: 15000, force: true })
            : page.press(passSel, 'Enter').catch(() => {}),
        ]);
      }

      // --- Wait for the CAS redirect chain to land back on the portal --------
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (!(await cancellableSleep(1000, token))) {
          return { ok: false, stage: 'cancelled', cancelled: true, reason: '自动登录已被停止' };
        }
        html = await page.content().catch(() => '');
        if (pageIsLoggedIn(html, page.url())) {
          log.info('自动登录成功，会话已保存。');
          await this.context
            .storageState({ path: path.join(this.profileDir, 'storage-state.json') })
            .catch(() => {});
          return { ok: true, reason: 'ok' };
        }
      }

      const cls = classifyPage(html, { finalUrl: page.url() });
      const serverError = extractLoginError(html);
      const stillOnLogin = cls.kind === PAGE.LOGIN || looksLikeLoginPage(html);

      // Distinguish a real credential rejection from a technical failure.
      // Only the former may count towards the account-lockout backoff: killing
      // the browser, a blocked page, or a missing form says nothing about
      // whether the password is right, and must not pause auto-login.
      if (serverError && isCredentialRejection(serverError)) {
        const reason = `统一身份认证拒绝了登录：${serverError}`;
        log.warn(reason);
        return { ok: false, stage: 'rejected', credentialRejected: true, serverError, reason };
      }

      if (stillOnLogin) {
        const reason =
          '提交后仍停留在登录页，但页面没有给出错误提示 —— 可能是表单未真正提交，' +
          '或站点反爬拦截了登录请求（这与密码是否正确无关，因此不计入失败次数）';
        log.warn(reason);
        return { ok: false, stage: 'submit', credentialRejected: false, reason };
      }

      const reason = `自动登录失败：提交后未回到门户 (${cls.kind} @ ${page.url()})`;
      log.warn(reason);
      return { ok: false, stage: 'submit', credentialRejected: false, reason };
    } catch (err) {
      return { ok: false, stage: 'error', credentialRejected: false, reason: `自动登录异常: ${err.message}` };
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Make sure we hold a valid CAS session.
   *
   * Order of attempts:
   *   1. reuse the saved session in the persistent profile
   *   2. if credentials are stored, log in automatically (headless)
   *   3. otherwise open a visible window for a one-time manual login
   *
   * @param {{notify?:Function, credentials?:{username:string,password:string}|null,
   *          allowAutoLogin?:boolean, autoLoginBlockReason?:string}} opts
   */
  async ensureLoggedIn({
    notify = () => {},
    credentials = null,
    allowAutoLogin = true,
    autoLoginBlockReason = '',
    token,
  } = {}) {
    token?.throwIfCancelled('登录检查');
    let state = await this.isLoggedIn();
    if (state.ok) {
      log.info('CAS 登录状态有效，复用已保存的会话。');
      return { ok: true, method: 'reused' };
    }
    log.warn(`登录状态无效: ${state.reason}`);

    // 2. Automatic login with stored credentials.
    if (allowAutoLogin && credentials?.username && credentials?.password) {
      // 2a. Preferred path: log in over plain HTTP, then hand the session to
      // Chrome. Driving the form INSIDE Chrome gets HTTP 400 from the site's
      // bot protection while an identical plain form POST succeeds — see
      // src/httpLogin.js for the measurements.
      const viaHttp = await this.loginViaHttpAndAdopt(credentials.username, credentials.password, { token });
      if (viaHttp.ok) return { ok: true, method: 'auto-http', reason: viaHttp.reason || 'ok' };
      if (viaHttp.cancelled) return { ok: false, method: 'auto-http', cancelled: true, reason: viaHttp.reason };
      if (viaHttp.credentialRejected) {
        return { ok: false, method: 'auto-http', credentialRejected: true, reason: viaHttp.reason };
      }
      log.warn(`HTTP 登录未成功（${viaHttp.reason}），改为在浏览器中尝试。`);

      // 2b. Fallback: drive the login form inside the browser.
      const auto = await this.loginWithCredentials(credentials.username, credentials.password, { token });
      if (auto.ok) return { ok: true, method: 'auto', reason: auto.reason };
      if (auto.cancelled) return { ok: false, method: 'auto', cancelled: true, reason: auto.reason };
      log.warn(`浏览器登录也未成功（${auto.reason}），转入手动登录。`);
      // Re-check: a failed attempt may still have produced a usable session.
      const recheck = await this.isLoggedIn();
      if (recheck.ok) return { ok: true, method: 'auto-recheck' };
      if (auto.captchaRequired) {
        return { ok: false, method: 'auto', reason: auto.reason, captchaRequired: true };
      }
      // Tell the caller whether this was the password's fault; anything else must
      // not count towards the lockout backoff.
      return {
        ok: false,
        method: 'auto',
        credentialRejected: Boolean(auto.credentialRejected),
        serverError: auto.serverError || null,
        reason: auto.reason,
      };
    }

    if (!allowAutoLogin && autoLoginBlockReason === 'no-credentials') {
      log.info('尚未保存统一身份认证账号密码，需要手动登录一次。可在控制面板里保存账号以启用自动登录。');
    } else if (!allowAutoLogin) {
      log.warn('自动登录暂时停用（连续失败过多，避免账号被锁定），转入手动登录。');
    }

    if (this.headless) {
      log.info('切换到可见模式以便手动登录…');
      await this.launch({ headless: false });
    } else if (!this.context) {
      await this.launch({ headless: false });
    }

    const page = await this.newPage();
    try {
      // Make sure the window is actually usable for a human. The CAS login
      // iframe can fail and then sit on top of the fallback form as an empty
      // full-viewport sheet, which is what made this window look blank.
      const nav = await this.gotoLoginPage(page);
      const ui = await this.prepareManualLoginUi(page);
      if (ui.mode === 'fallback') {
        log.info('已切换到内置登录面板（用户名 / 密码 / 登录按钮就在页面顶部）。');
      } else if (ui.mode === 'none') {
        log.warn(`登录表单仍不可用（iframe 可用性: ${ui.before?.iframeUsable}）。`);
        log.warn('请在窗口中按 Ctrl+R 刷新，或运行 npm run doctor 检查网络。');
      } else if (nav.cleared) {
        log.info(`已清除 ${nav.cleared} 个过期认证 Cookie，登录表单已正常显示。`);
      }

      notify(
        '需要登录校内门户',
        `已打开浏览器窗口，请在窗口中完成统一身份认证（CAS）登录。\n` +
          `登录成功后程序会自动继续，最多等待 ${Math.round(
            this.cfg.session.loginTimeoutMs / 60000,
          )} 分钟。`,
      );

      const deadline = Date.now() + this.cfg.session.loginTimeoutMs;
      process.stdout.write('请在浏览器窗口中完成登录 ');
      while (Date.now() < deadline) {
        // Interruptible so "停止抓取" does not have to wait out the timeout.
        if (!(await cancellableSleep(this.cfg.session.loginPollIntervalMs, token))) {
          process.stdout.write(' 已停止\n');
          log.warn('手动登录等待已被用户停止。');
          return { ok: false, method: 'manual', cancelled: true, reason: '手动登录等待已停止' };
        }
        process.stdout.write('.');
        const html = await page.content().catch(() => '');
        if (pageIsLoggedIn(html, page.url())) {
          process.stdout.write(' 登录成功\n');
          log.info('检测到登录成功，会话已保存。');
          // Persist cookies to disk before going headless again.
          await this.context.storageState({ path: path.join(this.profileDir, 'storage-state.json') }).catch(() => {});
          return { ok: true, method: 'manual' };
        }
      }
      process.stdout.write('\n');
      log.error('等待登录超时。');
      return { ok: false, method: 'manual', reason: '等待手动登录超时' };
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** Diagnostics for `npm run doctor`. */
  async diagnose() {
    const out = {};
    out.profileDir = this.profileDir;
    out.profileExists = fs.existsSync(this.profileDir);
    try {
      const cookieFile = path.join(this.profileDir, 'Default', 'Cookies');
      out.cookieDbExists = fs.existsSync(cookieFile);
    } catch {
      out.cookieDbExists = false;
    }
    return out;
  }
}
