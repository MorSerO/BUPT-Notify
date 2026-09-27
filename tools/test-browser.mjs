/**
 * test-browser.mjs — integration test of the PRODUCTION browser path.
 *
 * Verifies, against the live portal:
 *   1. Playwright can drive the installed Chrome (channel:"chrome")
 *   2. PortalSession.isLoggedIn() reports the truth (no session yet)
 *   3. Fetching list.jsp without a session is classified as LOGIN — i.e. the
 *      clogin.jsp "系统发生错误" shell is NOT mistaken for a changed template
 *   4. The VPN portal page is reachable and openable
 *
 * Saves every page it receives under tools/out/ for parser work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { PortalSession } from '../src/fetcher.js';
import { classifyPage, PAGE } from '../src/vsb.js';
import { openInBrowser, probeUrl, describeProbe } from '../src/net.js';

const outDir = path.resolve('tools/out');
fs.mkdirSync(outDir, { recursive: true });

const cfg = loadConfig({ quiet: true });
let failures = 0;
const check = (label, cond, extra = '') => {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? '  [OK]' : '  [FAIL]'} ${label}${extra ? ` — ${extra}` : ''}`);
};

console.log('profileDir:', cfg.session.profileDir);
console.log('chrome channel:', cfg.session.channel);

if (process.argv.includes('--open-vpn')) {
  console.log('\n--- opening VPN portal in default browser ---');
  openInBrowser(cfg.network.vpnPortalUrl);
}

const session = new PortalSession(cfg);
try {
  console.log('\n=== 1. launch Chrome ===');
  await session.launch({ headless: true });
  check('Chrome 已通过 playwright-core 启动', true);

  console.log('\n=== 2. portal homepage: session state ===');
  const home = await session.fetchHtml(cfg.baseUrl);
  fs.writeFileSync(path.join(outDir, 'live-home.html'), home.html);
  const homePage = classifyPage(home.html, { finalUrl: home.finalUrl });
  console.log(`   status=${home.status} finalUrl=${home.finalUrl} len=${home.html.length}`);
  console.log(`   classifyPage → ${homePage.kind} (${homePage.reason})`);
  const state = await session.isLoggedIn();
  console.log('   isLoggedIn:', JSON.stringify(state));
  check('isLoggedIn 返回明确结论', typeof state.ok === 'boolean');

  console.log('\n=== 3. list.jsp without session must classify as LOGIN ===');
  for (const t of cfg.targets) {
    const r = await session.fetchHtml(t.url);
    fs.writeFileSync(path.join(outDir, `live-${t.key}.html`), r.html);
    const page = classifyPage(r.html, { finalUrl: r.finalUrl });
    console.log(`   ${t.name}: status=${r.status} finalUrl=${r.finalUrl}`);
    console.log(`     classifyPage → ${page.kind} (${page.reason})  items=${page.itemCount}`);

    if (page.kind === PAGE.CONTENT) {
      check(`${t.name}: 会话有效，拿到真实列表`, true, `${page.itemCount} 个条目链接`);
      const { parseListPage } = await import('../src/vsb.js');
      const items = parseListPage(r.html, { baseUrl: cfg.baseUrl, treeId: t.treeId, source: t.name });
      console.log(`     解析出 ${items.length} 条：`);
      for (const it of items.slice(0, 8)) {
        console.log(`       ${it.date ?? '(无日期)'}  [${it.newsId}]  ${it.title}`);
      }
    } else {
      // Expected while logged out: must be LOGIN, never "template changed".
      check(`${t.name}: 未登录被正确识别为 LOGIN（而非模板变更）`, page.kind === PAGE.LOGIN, `实际 ${page.kind}`);
    }
  }

  console.log('\n=== 4. VPN portal reachability ===');
  const vpn = await probeUrl(cfg.network.vpnPortalUrl, { timeoutMs: 15000 });
  console.log(`   ${cfg.network.vpnPortalUrl} → ${describeProbe(vpn)}`);
  check('VPN 门户可达', vpn.ok);
} catch (err) {
  console.log('\nFATAL:', err.message.split('\n')[0]);
  failures += 1;
} finally {
  await session.close();
}

console.log(failures === 0 ? '\n浏览器集成测试全部通过 ✓\n' : `\n${failures} 项失败 ✗\n`);
process.exit(failures === 0 ? 0 : 1);
