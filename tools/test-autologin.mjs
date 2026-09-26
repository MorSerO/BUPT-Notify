/**
 * test-autologin.mjs — verify the auto-login machinery against the LIVE CAS page.
 *
 * SAFETY: this deliberately does NOT submit the form. Submitting a guessed
 * password could trip the university's failed-login lockout. We only verify that
 * the production code can *find* and *fill* the real fields, which is the part
 * that depends on the portal's markup.
 *
 * Optionally opens the GUI window (--open-ui) to verify the desktop control panel.
 */
import { loadConfig } from '../src/config.js';
import { PortalSession } from '../src/fetcher.js';
import { classifyPage, PAGE } from '../src/vsb.js';
import { openAppWindow, findChrome } from '../src/net.js';

const CHROME = findChrome();
let failures = 0;
const check = (label, cond, extra = '') => {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? '  [OK]' : '  [FAIL]'} ${label}${extra ? ` — ${extra}` : ''}`);
};

const cfg = loadConfig({ quiet: true });
console.log('Chrome:', CHROME || '(未找到)');

const session = new PortalSession(cfg);
try {
  console.log('\n=== 1. launch ===');
  await session.launch({ headless: true });
  check('Chrome 启动成功', true);

  console.log('\n=== 2. navigate to the portal via the production path ===');
  const page = await session.newPage();
  // Use the REAL production navigation, which recovers from the stale-cookie
  // HTTP 400 that makes the login page render blank.
  const nav = await session.gotoLoginPage(page);
  const html = await page.content();
  const url = page.url();
  const cls = classifyPage(html, { finalUrl: url });
  console.log(`  url: ${url}`);
  console.log(`  gotoLoginPage: ok=${nav.ok} fields=${nav.fields} cleared=${nav.cleared}`);
  console.log(`  classifyPage: ${cls.kind} (${cls.reason})`);
  check('未登录时被识别为 LOGIN', cls.kind === PAGE.LOGIN, `实际 ${cls.kind}`);
  check('登录表单渲染成功（生产代码会自愈过期 Cookie）', nav.ok === true, nav.reason || '');
  check('账号与密码字段各有一个', nav.fields === 2, `实际 ${nav.fields}`);

  console.log('\n=== 3. locate the real login fields (no submit) ===');
  // Same selector lists the production code uses.
  const candidates = {
    username: ['input[name="username"]', '#username', 'input[name="uname"]', 'input[name="userName"]', 'input[type="text"][name*="user" i]', 'input[type="text"]'],
    password: ['input[name="password"]', '#password', 'input[type="password"]'],
    submit: ['input[type="submit"]', 'button[type="submit"]', '.btn-login', '#loginButton', 'button[name="submit"]', 'button'],
  };

  const found = {};
  for (const [key, list] of Object.entries(candidates)) {
    for (const sel of list) {
      const n = await page.locator(sel).first().count().catch(() => 0);
      if (n > 0) {
        found[key] = sel;
        break;
      }
    }
  }
  console.log('  matched selectors:', JSON.stringify(found, null, 2));
  check('找到账号输入框', Boolean(found.username), found.username || '未找到');
  check('找到密码输入框', Boolean(found.password), found.password || '未找到');
  check('找到提交按钮', Boolean(found.submit), found.submit || '未找到');

  if (found.username && found.password) {
    // Fill with throwaway values, then clear — never submit.
    await page.fill(found.username, '__bupt_probe__');
    await page.fill(found.password, '__bupt_probe__');
    const uv = await page.inputValue(found.username);
    const pv = await page.inputValue(found.password);
    check('可以写入账号/密码字段', uv === '__bupt_probe__' && pv === '__bupt_probe__');
    await page.fill(found.username, '');
    await page.fill(found.password, '');
  }

  console.log('\n=== 4. isLoggedIn() reports the truth ===');
  const state = await session.isLoggedIn();
  console.log('  ', JSON.stringify(state));
  check('未登录时 isLoggedIn().ok === false', state.ok === false);
  check('给出了具体原因', Boolean(state.reason));

  await page.close();
} catch (err) {
  console.log('\nFATAL:', err.message.split('\n')[0]);
  failures += 1;
} finally {
  await session.close();
}

if (process.argv.includes('--open-ui')) {
  console.log('\n=== 5. desktop control panel window ===');
  check('找到 Chrome 可执行文件', Boolean(CHROME), CHROME || '');
  if (CHROME) {
    openAppWindow('http://127.0.0.1:17872/');
    check('已发出打开控制面板窗口的指令', true, '窗口应出现在桌面上');
  }
}

console.log(failures === 0 ? '\n自动登录/浏览器验证全部通过 ✓\n' : `\n${failures} 项失败 ✗\n`);
process.exit(failures === 0 ? 0 : 1);
