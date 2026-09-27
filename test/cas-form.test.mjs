/**
 * cas-form.test.mjs — regression tests for the BUPT 统一身份认证 (CAS) login
 * contract, pinned against markup and JS captured live on 2026-09-25.
 *
 * These tests exist because the real login flow is unusual and easy to break:
 *
 *   1. The visible login UI is an IFRAME (login-normal.html) whose request can
 *      answer HTTP 400 with an empty body, leaving the page apparently blank.
 *   2. The same form also exists HIDDEN in <div id="default" style="display:none">.
 *   3. Submitting is done by a page global: doLogin(user, pass, type[, captcha]),
 *      which fills #loginForm and clicks its submit — one shot per page load.
 *
 * If the school changes any of this, these tests fail loudly instead of the tool
 * silently failing to log in.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const here = path.dirname(fileURLToPath(import.meta.url));
const formHtml = fs.readFileSync(path.join(here, 'fixtures/cas-login-normal.html'), 'utf8');
const pageHtml = fs.readFileSync(path.join(here, 'fixtures/cas-login-skeleton.html'), 'utf8');

test('the login form uses the ids the scraper drives', () => {
  const $ = cheerio.load(formHtml);
  assert.equal($('#username').length, 1, '#username must exist');
  assert.equal($('#password').length, 1, '#password must exist');
  assert.ok($('#cptValue').length >= 1, 'captcha field present in the template');
});

test('login is submitted via the page global doLogin, not a plain form post', () => {
  // loginPassword() collects the fields and calls into the PARENT frame.
  assert.ok(/function\s+loginPassword\s*\(/.test(formHtml), 'loginPassword() defined');
  assert.ok(
    /parent\.doLogin\(\s*username\.trim\(\)\s*,\s*password\.trim\(\)\s*,\s*'username_password'/.test(formHtml),
    'loginPassword() delegates to parent.doLogin(username, password, "username_password")',
  );
});

test('captcha is conditional, so password-only login is possible', () => {
  // loginPassword() only requires a captcha when config.captcha is truthy.
  assert.ok(/if\s*\(\s*config\.captcha\s*\)/.test(formHtml), 'captcha is gated by config.captcha');
});

test('the parent page defines doLogin and the one-shot firstLogin latch', () => {
  assert.ok(/function\s+doLogin\s*\(\s*username\s*,\s*password\s*,\s*type\s*,\s*captcha\s*\)/.test(pageHtml), 'doLogin signature');
  assert.ok(/var\s+firstLogin\s*=\s*true/.test(pageHtml), 'firstLogin latch exists');
  // The latch means a second call is a no-op — retries must reload the page.
  assert.ok(/if\s*\(\s*firstLogin\s*\)\s*firstLogin\s*=\s*false\s*;\s*else\s+return/.test(pageHtml), 'one-shot guard');
});

test('doLogin fills #loginForm and clicks its submit input', () => {
  assert.ok(/#loginForm input\[name='username'\]/.test(pageHtml), 'sets username in #loginForm');
  assert.ok(/#loginForm input\[name='password'\]/.test(pageHtml), 'sets password in #loginForm');
  // e.g. $("#loginForm input[name='submit']").click();
  assert.ok(
    /#loginForm input\[name=['"]submit['"]\][^;]*?\.click\(\)/.test(pageHtml),
    'clicks the submit input',
  );
});

test('the hidden #default panel holds the same form (our fallback target)', () => {
  assert.ok(/<div id="default"[^>]*style="display:\s*none;?"/i.test(pageHtml), '#default is display:none in the raw HTML');
  // It contains the form we reveal when the iframe fails.
  const i = pageHtml.indexOf('id="default"');
  assert.ok(i > 0, '#default exists');
  const region = pageHtml.slice(i, i + 2500);
  assert.ok(/id="loginForm"/.test(region), 'the hidden panel contains #loginForm');
});

test('the login iframe is the documented source of the visible UI', () => {
  assert.ok(/<iframe id="loginIframe"/.test(pageHtml), 'loginIframe present');
  assert.ok(/login-normal\.html/.test(pageHtml), 'iframe points at login-normal.html');
});

test('the CAS page exposes getPageConfig for the captcha check', () => {
  assert.ok(/function\s+getPageConfig\s*\(/.test(pageHtml), 'getPageConfig() defined');
});
