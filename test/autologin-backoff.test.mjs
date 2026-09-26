/**
 * autologin-backoff.test.mjs — the "自动登录暂停 30 分钟" behaviour.
 *
 * The rule this file pins down: ONLY a real credential rejection from the
 * identity provider may count towards the lockout backoff.
 *
 * Why it matters: the counter used to be incremented for *any* failed auto-login
 * — including "browser was closed", "page blocked by the site's bot protection",
 * "no login form found" and cancellations. Those say nothing about whether the
 * password is correct, yet they produced a message telling the user auto-login
 * was "paused to avoid locking your account", which was simply untrue.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractLoginError, isCredentialRejection, classifyPage, PAGE } from '../src/vsb.js';
import { App, MAX_AUTO_LOGIN_FAILURES, AUTO_LOGIN_COOLDOWN_MS } from '../src/app.js';
import { Store } from '../src/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cleanLogin = fs.readFileSync(path.join(here, 'fixtures/cas-login-skeleton.html'), 'utf8');
const errorLogin = fs.readFileSync(path.join(here, 'fixtures/cas-login-error.html'), 'utf8');

/* --------------------------- error extraction --------------------------- */

test('extractLoginError reads the message out of #errorDiv', () => {
  const msg = extractLoginError(errorLogin);
  assert.ok(msg, 'an error message should be found');
  assert.match(msg, /密码/);
});

test('extractLoginError returns null on a clean login page', () => {
  assert.equal(extractLoginError(cleanLogin), null);
  assert.equal(extractLoginError(''), null);
});

test('extractLoginError recognises other error containers', () => {
  assert.match(extractLoginError('<div id="errorDiv"><p>验证码错误</p></div>') || '', /验证码/);
  assert.match(extractLoginError('<p class="error">账号已被锁定</p>') || '', /锁定/);
  assert.match(extractLoginError('<span id="errMsg">登录失败，请重试</span>') || '', /登录失败/);
});

test('extractLoginError falls back to rejection phrasing without a container', () => {
  assert.match(extractLoginError('<div>用户名或密码错误</div>') || '', /密码/);
  assert.match(extractLoginError('<div>温馨提示：密码不正确</div>') || '', /密码/);
});

test('a page WITHOUT an error message is not treated as a rejection', () => {
  // "still on the login page" alone proves nothing — this is the exact trap that
  // produced the bogus lockout warning.
  assert.equal(isCredentialRejection(extractLoginError(cleanLogin)), false);
  assert.equal(isCredentialRejection(null), false);
  assert.equal(isCredentialRejection(''), false);
});

test('isCredentialRejection accepts real server wording', () => {
  for (const s of ['用户名或密码错误', '密码不正确', '账号已被锁定', '验证码错误', '登录失败，请重试', '用户名不存在']) {
    assert.equal(isCredentialRejection(s), true, s);
  }
});

test('the error page still parses as a login page, not as content', () => {
  const c = classifyPage(errorLogin, { finalUrl: 'https://auth.bupt.edu.cn/authserver/login' });
  assert.equal(c.kind, PAGE.LOGIN);
});

/* ------------------------------ App backoff ----------------------------- */

function makeApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-backoff-'));
  const cfg = {
    baseUrl: 'http://my.bupt.edu.cn/',
    windowDays: 10,
    targets: [],
    output: { mode: 'local', localDir: path.join(dir, 'out') },
    email: { enabled: false, to: [] },
    session: { profileDir: path.join(dir, 'prof'), channel: 'chrome', headless: true, loginTimeoutMs: 100, loginPollIntervalMs: 10 },
    network: { probeTimeoutMs: 100, waitTimeoutMs: 100, pollIntervalMs: 10, vpnPortalUrl: 'https://vpn.bupt.edu.cn/' },
    poll: { intervalMinutes: 120, jitterSeconds: 0 },
    log: { level: 'error', file: false, console: false },
  };
  return new App(cfg, { store: new Store({ file: path.join(dir, 'state.json') }), configPath: path.join(dir, 'config.json') });
}

test('a technical failure does NOT count towards the backoff', () => {
  const app = makeApp();
  const technical = [
    '自动登录异常: page.content: Target page, context or browser has been closed',
    '登录页没有渲染出登录表单',
    '提交后仍停留在登录页，但页面没有给出错误提示',
    '统一身份认证要求输入验证码',
  ];
  for (const reason of technical) {
    const r = app.recordAutoLoginResult(false, { credentialRejected: false, reason });
    assert.equal(r.counted, false, reason);
    assert.equal(r.failures, 0);
  }
  assert.equal(app.status.autoLoginFailures, 0, 'no failures recorded');
  assert.equal(app.status.autoLoginPaused, false, 'auto-login must NOT be paused');
  // The reason is still remembered for display.
  assert.ok(app.status.autoLoginLastFailureReason);
});

test('a real credential rejection DOES count, and pauses after the limit', () => {
  const app = makeApp();
  for (let i = 1; i <= MAX_AUTO_LOGIN_FAILURES; i += 1) {
    const r = app.recordAutoLoginResult(false, {
      credentialRejected: true,
      reason: '统一身份认证拒绝了登录：用户名或密码错误，请重新输入',
    });
    assert.equal(r.counted, true);
    assert.equal(r.failures, i);
  }
  const st = app.status;
  assert.equal(st.autoLoginFailures, MAX_AUTO_LOGIN_FAILURES);
  assert.equal(st.autoLoginPaused, true, 'paused after the limit');
  assert.ok(st.autoLoginCooldownMinutes > 0);
  assert.match(st.autoLoginLastFailureReason, /密码错误/);
});

test('the pause blocks auto-login but not manual login', () => {
  const app = makeApp();
  for (let i = 0; i < MAX_AUTO_LOGIN_FAILURES; i += 1) {
    app.recordAutoLoginResult(false, { credentialRejected: true, reason: 'x' });
  }
  const gate = app.autoLoginAllowed();
  assert.equal(gate.allowed, false);
  assert.equal(gate.reason, 'cooldown');
});

test('a mixed run of technical failures never reaches the pause', () => {
  const app = makeApp();
  for (let i = 0; i < 10; i += 1) {
    app.recordAutoLoginResult(false, { credentialRejected: false, reason: 'browser closed' });
  }
  assert.equal(app.status.autoLoginFailures, 0);
  assert.equal(app.status.autoLoginPaused, false, 'ten technical failures must not pause anything');
});

test('a success clears the failure count', () => {
  const app = makeApp();
  app.recordAutoLoginResult(false, { credentialRejected: true, reason: 'bad pw' });
  app.recordAutoLoginResult(false, { credentialRejected: true, reason: 'bad pw' });
  assert.equal(app.status.autoLoginFailures, 2);
  app.recordAutoLoginResult(true);
  assert.equal(app.status.autoLoginFailures, 0);
  assert.equal(app.status.autoLoginLastFailureReason, null);
});

test('resetAutoLoginBackoff clears the pause immediately', () => {
  const app = makeApp();
  for (let i = 0; i < MAX_AUTO_LOGIN_FAILURES; i += 1) {
    app.recordAutoLoginResult(false, { credentialRejected: true, reason: 'bad pw' });
  }
  assert.equal(app.status.autoLoginPaused, true);
  app.resetAutoLoginBackoff();
  assert.equal(app.status.autoLoginFailures, 0);
  assert.equal(app.status.autoLoginPaused, false, 'auto-login is allowed again');
  // NOTE: autoLoginAllowed() may still say no for an unrelated reason
  // (no stored credentials); what reset() must clear is the COOLDOWN.
  assert.equal(app.autoLoginCooldown().paused, false);
  assert.notEqual(app.autoLoginAllowed().reason, 'cooldown');
});

test('the cooldown expires on its own', () => {
  const app = makeApp();
  for (let i = 0; i < MAX_AUTO_LOGIN_FAILURES; i += 1) {
    app.recordAutoLoginResult(false, { credentialRejected: true, reason: 'bad pw' });
  }
  assert.equal(app.autoLoginCooldown().paused, true);

  // Pretend the last failure was long ago.
  app.store.setMeta('autoLoginLastFailureAt', new Date(Date.now() - AUTO_LOGIN_COOLDOWN_MS - 60_000).toISOString());
  const cd = app.autoLoginCooldown();
  assert.equal(cd.paused, false, 'cooldown should have expired');
  assert.equal(cd.failures, 0, 'counter reset after the cooldown');
  assert.notEqual(app.autoLoginAllowed().reason, 'cooldown', 'no longer blocked by the cooldown');
});

test('the constants are the documented ones', () => {
  assert.equal(MAX_AUTO_LOGIN_FAILURES, 3);
  assert.equal(AUTO_LOGIN_COOLDOWN_MS, 30 * 60 * 1000, '30 minutes');
});
