// End-to-end verification of the whole chain with REAL credentials:
//   HTTP login -> HTTP scrape of both columns -> 10-day window -> dedup
// Delivers nothing; prints no secrets.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { HttpSession } from '../src/httpSession.js';
import { loadCredentials } from '../src/secrets.js';
import { collectAll } from '../src/collector.js';
import { Store } from '../src/store.js';
import { initLogger } from '../src/logger.js';

initLogger({ level: 'info', file: false, console: true });

let failures = 0;
const check = (label, cond, extra = '') => {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? '  [OK]' : '  [FAIL]'} ${label}${extra ? ` — ${extra}` : ''}`);
};

const cfg = loadConfig({ quiet: true });
const creds = await loadCredentials();
console.log(`account: ${creds.username}\n`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-e2e-'));
const session = new HttpSession(cfg, { cookieFile: path.join(dir, 'cookies.json') });
await session.launch();

try {
  console.log('=== 1. logged out ===');
  session.clearCookies();
  check('未登录时判定为未登录', (await session.isLoggedIn()).ok === false);

  console.log('\n=== 2. auto login over HTTP ===');
  const login = await session.ensureLoggedIn({ credentials: creds });
  console.log('  login ->', JSON.stringify(login));
  check('自动登录成功', login.ok === true, login.reason || '');

  console.log('\n=== 3. session is valid and reusable ===');
  const st = await session.isLoggedIn();
  check('isLoggedIn 通过', st.ok === true, st.reason || '');
  check('Cookie 已持久化', fs.existsSync(path.join(dir, 'cookies.json')));
  check('拿到的条目数 > 0', (st.itemCount || 0) > 0, `${st.itemCount} 条`);

  console.log('\n=== 4. scrape both columns ===');
  const store = new Store({ file: path.join(dir, 'state.json') });
  const { items, stats, loginRequired, errors } = await collectAll(session, cfg, store, { now: new Date() });
  for (const t of cfg.targets) {
    const s = stats.targets[t.key];
    check(`${t.name} 抓到条目`, s && s.items > 0, s ? `${s.items} 条，新 ${s.new} 条` : JSON.stringify(s));
  }
  check('抓取未要求重新登录', loginRequired === false, JSON.stringify(errors));
  console.log(`\n  10 天窗口内、未转发过的新内容: ${items.length} 条`);
  for (const it of items.slice(0, 12)) {
    console.log(`    [${it.source}] ${it.date || '无日期'}  ${it.title.slice(0, 54)}`);
  }

  console.log('\n=== 5. dedup across runs ===');
  for (const it of items) store.markForwarded(it, new Date());
  const again = await collectAll(session, cfg, store, { now: new Date() });
  check('第二次运行没有新内容', again.items.length === 0, `${again.items.length} 条`);

  console.log('\n=== 6. a NEW session object reuses the cookie file (no re-login) ===');
  const session2 = new HttpSession(cfg, { cookieFile: path.join(dir, 'cookies.json') });
  await session2.launch();
  const reuse = await session2.isLoggedIn();
  check('重启后仍复用会话（不会每次都登录）', reuse.ok === true, reuse.reason || '');
  await session2.close();
} catch (err) {
  console.log('FATAL:', err.message.split('\n')[0]);
  failures += 1;
} finally {
  await session.close();
}

console.log(failures === 0 ? '\n端到端验证全部通过 ✓\n' : `\n${failures} 项失败 ✗\n`);
process.exit(failures === 0 ? 0 : 1);
