/**
 * test-manual-login-ui.mjs — regression test for the "blank manual login window"
 * bug, using a LOCAL fixture (no network needed beyond Chrome itself).
 *
 * Background (verified live 2026-09-25):
 *   The CAS page puts the real login UI in a FULL-VIEWPORT iframe. When that
 *   iframe request is blocked (HTTP 400, 6-byte body — the site's bot protection
 *   rejects any automated browser, headed or headless), the iframe becomes an
 *   empty sheet of glass. It COVERS the built-in fallback form and, being in
 *   normal flow, pushes it ~1285px down the page. Result: a totally blank window
 *   with no way for the user to log in.
 *
 *   PortalSession.prepareManualLoginUi() detects the dead iframe, removes it from
 *   the layout, and surfaces the fallback form at the top of the page.
 *
 * Run: node tools/test-manual-login-ui.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import { PortalSession } from '../src/fetcher.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, '..', 'test', 'fixtures');

/**
 * Serve the fixtures over http://127.0.0.1 so the iframe is SAME-ORIGIN, exactly
 * as on the real CAS page (/authserver/cas/login-normal.html). With file:// the
 * frame would be cross-origin and its contentDocument unreadable.
 */
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'cas-layout-blank.html';
  const file = path.join(fixtureDir, rel);
  if (!file.startsWith(fixtureDir)) {
    res.writeHead(403);
    return res.end('no');
  }
  try {
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
    return res.end(body);
  } catch {
    res.writeHead(404);
    return res.end('not found');
  }
});
const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const fixtureUrl = `http://127.0.0.1:${port}/cas-layout-blank.html`;

let failures = 0;
const check = (label, cond, extra = '') => {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? '  [OK]' : '  [FAIL]'} ${label}${extra ? ` — ${extra}` : ''}`);
};

const cfg = loadConfig({ quiet: true });
fs.rmSync(cfg.session.profileDir, { recursive: true, force: true });

const session = new PortalSession(cfg);
try {
  await session.launch({ headless: true });
  const page = await session.newPage();

  console.log('=== 1. reproduce: iframe covers an empty page ===');
  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 400));

  const before = await session.inspectLoginUi(page);
  console.log('  ' + JSON.stringify(before));
  check('检测到 iframe 未渲染登录表单', before.iframeUsable === false);
  check('iframe 覆盖整个视口', before.iframeRect && before.iframeRect.h >= 800, JSON.stringify(before.iframeRect));
  check('回退表单默认为隐藏', before.fallbackDisplay === 'none');

  const textBefore = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim());
  const coveredBefore = await page.evaluate(() => {
    const u = document.querySelector('#loginForm input[name=username]');
    if (!u) return null;
    const b = u.getBoundingClientRect();
    const t = b.width ? document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) : null;
    return t ? t.tagName.toLowerCase() : null;
  });
  console.log(`  修复前: 可见文字="${textBefore.slice(0, 40)}" 覆盖在表单上的是=${coveredBefore}`);
  check('修复前页面基本是空白的（复现了 bug）', textBefore.length < 20 || coveredBefore === 'iframe');

  console.log('\n=== 2. apply the fix ===');
  const ui = await session.prepareManualLoginUi(page);
  console.log(`  mode=${ui.mode} fields=${ui.fields} y: ${ui.before?.usernameY} → ${ui.after?.usernameY}`);
  check('切换到回退面板', ui.mode === 'fallback');
  check('回退表单有两个可见字段', ui.fields === 2, String(ui.fields));

  console.log('\n=== 3. verify what the user now sees ===');
  const v = await page.evaluate(() => {
    const u = document.querySelector('#loginForm input[name=username]');
    const p = document.querySelector('#loginForm input[name=password]');
    const s = document.querySelector('#loginForm input[name=submit]');
    const f = document.querySelector('#loginIframe');
    const rect = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), y: Math.round(b.y) };
    };
    const topAt = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) return null;
      const t = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return t ? `${t.tagName.toLowerCase()}[${t.name || ''}]` : null;
    };
    return {
      iframeDisplay: f ? getComputedStyle(f).display : 'none',
      iframeHeight: f ? Math.round(f.getBoundingClientRect().height) : 0,
      username: rect(u),
      password: rect(p),
      submit: rect(s),
      topAtUsername: topAt(u),
      topAtSubmit: topAt(s),
      viewportH: window.innerHeight,
      text: (document.body.innerText || '').replace(/\s+/g, ' ').trim(),
    };
  });

  check('iframe 已从布局中移除', v.iframeDisplay === 'none' && v.iframeHeight === 0, `display=${v.iframeDisplay} h=${v.iframeHeight}`);
  check('用户名输入框可见', v.username && v.username.w > 50 && v.username.h > 10, JSON.stringify(v.username));
  check('密码输入框可见', v.password && v.password.w > 50 && v.password.h > 10);
  check('登录按钮可见', v.submit && v.submit.w > 10 && v.submit.h > 10);
  check(
    '用户名框在首屏内，不需要滚动',
    v.username && v.username.y >= 0 && v.username.y + v.username.h <= v.viewportH,
    v.username ? `y=${v.username.y}, 视口高=${v.viewportH}` : 'no field',
  );
  check('用户名框没有被任何元素遮挡', /input/.test(String(v.topAtUsername)), String(v.topAtUsername));
  check('登录按钮没有被遮挡', /input|button/.test(String(v.topAtSubmit)), String(v.topAtSubmit));
  check('页面不再是空白', v.text.includes('用户名') && v.text.includes('密码'), JSON.stringify(v.text.slice(0, 60)));

  console.log('\n=== 4. the fields accept typing ===');
  const u = page.locator('#loginForm input[name=username]').first();
  const p = page.locator('#loginForm input[name=password]').first();
  await u.fill('2021000000');
  await p.fill('pw');
  check('可以输入用户名', (await u.inputValue()) === '2021000000');
  check('可以输入密码', (await p.inputValue()) === 'pw');

  console.log('\n=== 5. the fallback form still submits through doLogin() ===');
  // Submitting navigates away; intercept it so we can assert the payload.
  await page.evaluate(() => {
    window.__submit = null;
    const f = document.getElementById('loginForm');
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      window.__submit = {
        username: f.querySelector("input[name='username']").value,
        password: f.querySelector("input[name='password']").value,
        type: f.querySelector("input[name='type']").value,
        execution: f.querySelector("input[name='execution']").value,
      };
    });
  });
  const auto = await page.evaluate(() => {
    if (typeof window.doLogin !== 'function') return 'no doLogin';
    window.doLogin('2021000000', 'pw', 'username_password');
    return window.__submit;
  });
  console.log('  doLogin payload:', JSON.stringify(auto));
  check('提交带上了隐藏的一次性 execution 字段', auto && auto.execution === 'fixture-execution-token');
  check('提交类型为 username_password', auto && auto.type === 'username_password');

  console.log('\n=== 6. a HEALTHY iframe must be left alone ===');
  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
  // Give the iframe real content so it counts as usable.
  await page.evaluate(() => {
    const f = document.getElementById('loginIframe');
    const d = f.contentDocument;
    d.open();
    d.write('<html><body><input id="username"><input id="password" type="password"></body></html>');
    d.close();
  });
  await new Promise((r) => setTimeout(r, 200));
  const healthy = await session.inspectLoginUi(page);
  check('检测到 iframe 可用', healthy.iframeUsable === true, `inputs=${healthy.iframeInputs}`);
  const ui2 = await session.prepareManualLoginUi(page);
  check('可用时不做改动（保留完整登录界面）', ui2.mode === 'iframe', ui2.mode);
  const stillVisible = await page.evaluate(() => getComputedStyle(document.getElementById('loginIframe')).display !== 'none');
  check('可用时 iframe 仍然显示', stillVisible);

  await page.close();
} catch (err) {
  console.log('FATAL:', err.message.split('\n')[0]);
  failures += 1;
} finally {
  await session.close();
  await new Promise((r) => server.close(r));
}

console.log(failures === 0 ? '\n手动登录界面回归测试全部通过 ✓\n' : `\n${failures} 项失败 ✗\n`);
process.exit(failures === 0 ? 0 : 1);
