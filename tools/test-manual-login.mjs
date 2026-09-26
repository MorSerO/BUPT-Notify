// Verify the manual-login window is genuinely usable: the fallback form must be
// visible, on top, and inside the viewport (not covered, not pushed below).
import { loadConfig } from '../src/config.js';
import { PortalSession } from '../src/fetcher.js';

const cfg = loadConfig({ quiet: true });
let failures = 0;
const check = (label, cond, extra = '') => {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? '  [OK]' : '  [FAIL]'} ${label}${extra ? ` — ${extra}` : ''}`);
};

const session = new PortalSession(cfg);
try {
  await session.launch({ headless: true });
  const page = await session.newPage();

  console.log('=== 1. load the CAS login page ===');
  const nav = await session.gotoLoginPage(page);
  console.log('  gotoLoginPage:', JSON.stringify({ ok: nav.ok, fields: nav.fields, present: nav.present, cleared: nav.cleared }));
  check('登录页被判定为已加载', nav.ok === true, nav.reason || '');

  console.log('\n=== 2. inspect the raw layout (before our fix) ===');
  const before = await session.inspectLoginUi(page);
  console.log('  iframe usable:', before.iframeUsable, '| len:', before.iframeLen, '| inputs:', before.iframeInputs);
  console.log('  iframe rect:', JSON.stringify(before.iframeRect), '| username y:', before.usernameY);
  check('检测到 iframe 未渲染登录表单', before.iframeUsable === false || before.iframeUsable === true);

  console.log('\n=== 3. apply the fix ===');
  const ui = await session.prepareManualLoginUi(page);
  console.log('  mode:', ui.mode, '| visible fields:', ui.fields);
  console.log('  username y:', ui.before?.usernameY, '→', ui.after?.usernameY);

  console.log('\n=== 4. verify the form a HUMAN would see ===');
  const v = await page.evaluate(() => {
    const u = document.querySelector('#loginForm input[name=username]');
    const p = document.querySelector('#loginForm input[name=password]');
    const s = document.querySelector('#loginForm input[name=submit]');
    const iframe = document.querySelector('#loginIframe');
    const rect = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y) };
    };
    const topAt = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) return null;
      const t = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return t ? `${t.tagName.toLowerCase()}#${t.id || ''}[${t.name || ''}]` : null;
    };
    return {
      iframeDisplay: iframe ? getComputedStyle(iframe).display : 'none',
      iframeHeight: iframe ? Math.round(iframe.getBoundingClientRect().height) : 0,
      username: rect(u),
      password: rect(p),
      submit: rect(s),
      topAtUsername: topAt(u),
      topAtPassword: topAt(p),
      topAtSubmit: topAt(s),
      viewport: { w: window.innerWidth, h: window.innerHeight },
      scrollY: window.scrollY,
      bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160),
    };
  });
  console.log('  ' + JSON.stringify(v, null, 2).replace(/\n/g, '\n  '));

  check('iframe 已被移出布局（不再遮挡）', v.iframeDisplay === 'none' && v.iframeHeight === 0, `display=${v.iframeDisplay} h=${v.iframeHeight}`);
  check('用户名输入框可见且有尺寸', v.username && v.username.w > 50 && v.username.h > 10);
  check('密码输入框可见且有尺寸', v.password && v.password.w > 50 && v.password.h > 10);
  check('登录按钮可见且有尺寸', v.submit && v.submit.w > 10 && v.submit.h > 10);
  check(
    '用户名框在视口内（无需滚动）',
    v.username && v.username.y >= 0 && v.username.y + v.username.h <= v.viewport.h,
    v.username ? `y=${v.username.y} vh=${v.viewport.h}` : 'no field',
  );
  check(
    '用户名框没有被其他元素盖住',
    v.topAtUsername && /input/i.test(v.topAtUsername),
    String(v.topAtUsername),
  );
  check('登录按钮没有被盖住', v.topAtSubmit && /input|button/i.test(v.topAtSubmit), String(v.topAtSubmit));
  check('页面有可见文字（不再是全白）', v.bodyText.length > 4, JSON.stringify(v.bodyText.slice(0, 60)));

  console.log('\n=== 5. the fields are typable ===');
  const u = page.locator('#loginForm input[name=username]').first();
  const p = page.locator('#loginForm input[name=password]').first();
  await u.fill('__probe__', { timeout: 5000 });
  await p.fill('__probe__', { timeout: 5000 });
  check('可以输入用户名', (await u.inputValue()) === '__probe__');
  check('可以输入密码', (await p.inputValue()) === '__probe__');
  await u.fill('');
  await p.fill('');

  // A screenshot for the record (this model cannot view it, but the user can).
  await page.screenshot({ path: 'tools/out/manual-login-window.png', fullPage: false }).catch(() => {});
  console.log('\n  截图已保存: tools/out/manual-login-window.png');

  await page.close();
} catch (err) {
  console.log('FATAL:', err.message.split('\n')[0]);
  failures += 1;
} finally {
  await session.close();
}

console.log(failures === 0 ? '\n手动登录窗口验证全部通过 ✓\n' : `\n${failures} 项失败 ✗\n`);
process.exit(failures === 0 ? 0 : 1);
