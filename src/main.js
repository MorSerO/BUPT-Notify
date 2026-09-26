/**
 * main.js — BUPT 校内通知/校内文件 自动转发助手.
 *
 * Boot sequence (matching the user's requirement):
 *   1. Probe my.bupt.edu.cn with a real HTTP request.
 *   2. If unreachable → open vpn.bupt.edu.cn in the browser and wait for the
 *      user to log in, re-probing until the portal answers.
 *   3. Ensure a valid session: reuse the saved profile → auto-login with saved
 *      credentials → otherwise a visible window for a one-time manual login.
 *   4. Scrape 校内通知 + 校内文件, keep items from the last N days.
 *   5. Drop anything already forwarded, deliver the rest (local file / email).
 *   6. Persist state, then repeat every `poll.intervalMinutes`.
 *
 * All of that lives in App (src/app.js) so the CLI and the desktop GUI share it.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, validateConfig, CONFIG_PATH, wantsEmail } from './config.js';
import { initLogger, log, getLogFile } from './logger.js';
import { App } from './app.js';
import { createUiServer } from './server.js';
import { verifyTransport } from './mailer.js';
import { isDpapiAvailable, hasStoredCredentials } from './secrets.js';
import { ensureNetwork, probeUrl, describeProbe, openAppWindow, findChrome } from './net.js';
import { PortalSession } from './fetcher.js';
import { parseListPage } from './vsb.js';
import { Store, STATE_PATH } from './store.js';
import { DATA_DIR, ROOT, ensureDir, sleep } from './util.js';
import { acquireLock as acquireFileLock, releaseLock as releaseFileLock } from './lock.js';

const LOCK_FILE = path.join(DATA_DIR, 'bupt-notify.lock');
const DEFAULT_UI_PORT = 17872;

/* ------------------------------------------------------------------ CLI ---- */

function parseArgs(argv) {
  const flags = {
    mode: 'serve',
    dryRun: false,
    fixture: null,
    verbose: false,
    port: 0,
    noWindow: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--once') flags.mode = 'once';
    else if (a === '--check') flags.mode = 'check';
    else if (a === '--doctor') flags.mode = 'doctor';
    else if (a === '--ui') flags.mode = 'ui';
    else if (a === '--serve') flags.mode = 'serve';
    else if (a === '--quiet') flags.quiet = true;
    else if (a === '--no-window') flags.noWindow = true;
    else if (a === '--port') flags.port = Number(argv[++i]) || 0;
    else if (a === '--dry-run' || a === '-n') flags.dryRun = true;
    else if (a === '--verbose' || a === '-v') flags.verbose = true;
    else if (a === '--parse-fixture') {
      flags.mode = 'fixture';
      flags.fixture = argv[++i];
    } else if (a === '--help' || a === '-h') flags.mode = 'help';
  }
  return flags;
}

/**
 * Another instance already holds the lock.
 *
 * For a one-click launcher this must NOT be an error: double-clicking the icon
 * again should simply bring the control panel up, which is what the user means
 * by "start it". We probe the default UI port and open a window if it answers.
 */
async function openExistingInstanceUi(flags) {
  const port = flags.port || DEFAULT_UI_PORT;
  const url = `http://127.0.0.1:${port}/`;
  const probe = await probeUrl(url, { timeoutMs: 2500 });
  if (!probe.ok) return false;

  log.info(`已有一个 BUPT-Notify 实例在运行，正在打开它的控制面板…`);
  if (flags.noWindow) log.info(`控制面板地址: ${url}`);
  else openAppWindow(url);

  // A tiny self-check: the panel is served by our own UI server.
  try {
    const { html } = await new Promise((resolve, reject) => {
      http
        .get(url, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8') }));
        })
        .on('error', reject);
    });
    if (!/BUPT-Notify/.test(html)) {
      log.warn(`端口 ${port} 上有服务在运行，但看起来不是 BUPT-Notify。`);
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function printHelp() {
  process.stdout.write(`
BUPT-Notify — 北邮校内通知/校内文件 自动转发助手

用法: node src/main.js [选项]

  --ui                  启动桌面控制面板（设置 + 立即抓取），不会常驻轮询   ← 推荐
  --once                只运行一次然后退出（定时任务用的就是这个）
  --once --quiet        后台模式：不弹窗、不开浏览器，适合计划任务
  --serve               常驻进程内部轮询（需要 poll.mode = "resident"）
  --dry-run, -n         配合 --once：抓取并打印，但不投递、不记录
  --check               只检查网络连通性与登录状态，不抓取、不发信
  --doctor              全面自检：配置、网络、邮箱授权码、登录会话、快捷方式
  --parse-fixture FILE  离线解析一个已保存的 HTML 文件（调试用）
  --port N              指定控制面板端口（默认 ${DEFAULT_UI_PORT}）
  --no-window           只开服务，不自动打开面板窗口
  -v, --verbose         输出 debug 日志
  -h, --help            显示本帮助

定时执行由 Windows 计划任务负责（面板里可一键开关）：
    npm run autostart   注册每 N 小时执行一次的计划任务
    npm run unautostart 取消

首次使用请先运行: npm run setup   或直接 npm run ui（在面板里设置）

配置文件: ${CONFIG_PATH}
状态文件: ${STATE_PATH}
`);
}

/* --------------------------------------------------------- desktop notify -- */

/** Show a Windows message box, detached so it never blocks the run. */
function desktopNotify(title, message) {
  try {
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      `[System.Windows.Forms.MessageBox]::Show(${JSON.stringify(message)}, ${JSON.stringify(
        title,
      )}, 'OK', 'Information') | Out-Null;`,
    ].join(' ');
    const child = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    /* notification is best-effort */
  }
}

/* ------------------------------------------------------- single instance --- */

/*
 * The lock lives in src/lock.js so the panel can take it around each run
 * instead of holding it for its whole lifetime (see that file for why).
 */
const acquireLock = () => acquireFileLock({ file: LOCK_FILE });
const releaseLock = () => releaseFileLock({ file: LOCK_FILE });

/* ---------------------------------------------------------------- modes --- */

/** Notifications for a human-driven run (panel / --once without --quiet). */
function makeNotify() {
  return (title, msg) => {
    log.warn(`[提示] ${title}: ${msg.split('\n')[0]}`);
    desktopNotify(title, msg);
  };
}

/**
 * Notifications for a background/scheduled run: log only.
 *
 * A scheduled task fires while you are working; popping a dialog over whatever
 * you are doing would be exactly the "影响日常使用" the user asked to avoid.
 */
function makeQuietNotify() {
  return (title, msg) => {
    log.warn(`[后台] ${title}: ${msg.split('\n')[0]}`);
  };
}

async function modeFixture(cfg, file) {
  // Default to a bundled fixture so this works in a fresh clone. Point it at a
  // real saved page (--parse-fixture path\to\page.html) to debug live markup.
  const target = file || path.join(ROOT, 'test', 'fixtures', 'notice-list.html');
  if (!fs.existsSync(target)) {
    log.error(`文件不存在: ${target}`);
    return 1;
  }
  const html = fs.readFileSync(target, 'utf8');
  const items = parseListPage(html, { baseUrl: cfg.baseUrl, now: new Date(), source: 'fixture' });
  log.info(`从 ${path.basename(target)} 解析出 ${items.length} 条:`);
  for (const it of items) {
    process.stdout.write(`  ${it.date || '(无日期)'}  [${it.key}]  ${it.title}\n     ${it.url}\n`);
  }
  return 0;
}

async function modeCheck(cfg) {
  log.info('--- 网络检查 ---');
  const probe = await probeUrl(cfg.baseUrl, { timeoutMs: cfg.network.probeTimeoutMs });
  log.info(`${cfg.baseUrl} → ${describeProbe(probe)}`);
  if (!probe.ok) {
    log.warn('校内门户不可达：请先连接校园网或启动 VPN (vpn.bupt.edu.cn)。');
    return 2;
  }
  log.info('--- 登录检查 ---');
  const session = new PortalSession(cfg);
  try {
    await session.launch({ headless: cfg.session.headless });
    const state = await session.isLoggedIn();
    if (state.ok) {
      log.info('CAS 会话有效。');
      return 0;
    }
    log.warn(`CAS 会话无效: ${state.reason}`);
    if (hasStoredCredentials()) log.info('已保存账号密码，运行时将尝试自动登录。');
    else log.warn('未保存账号密码：会话过期时需要手动登录。可在控制面板中设置。');
    return 3;
  } finally {
    await session.close();
  }
}

async function modeDoctor(cfg) {
  const problems = validateConfig(cfg);
  log.info('=== 1. 配置检查 ===');
  if (problems.length) for (const p of problems) log.warn(`  ✗ ${p}`);
  else log.info('  ✓ 配置完整');
  log.info(`  Node: ${process.version}  平台: ${process.platform}`);
  log.info(`  配置文件: ${CONFIG_PATH} (${fs.existsSync(CONFIG_PATH) ? '存在' : '缺失，使用默认值'})`);

  log.info('=== 2. 网络检查 ===');
  const probe = await probeUrl(cfg.baseUrl, { timeoutMs: cfg.network.probeTimeoutMs });
  log.info(`  ${cfg.baseUrl} → ${describeProbe(probe)}`);
  if (!probe.ok) log.warn(`  ! 需要校园网/VPN。VPN 门户: ${cfg.network.vpnPortalUrl}`);

  log.info('=== 3. 输出方式检查 ===');
  const { describeOutput } = await import('./output.js');
  log.info(`  方式: ${cfg.output?.mode}  →  ${describeOutput(cfg)}`);
  if (wantsEmail(cfg) && !problems.some((p) => p.startsWith('email.'))) {
    const v = await verifyTransport(cfg.email);
    if (v.ok) log.info(`  ✓ SMTP 登录成功 (${cfg.email.host}:${cfg.email.port} as ${cfg.email.user})`);
    else log.warn(`  ✗ SMTP 失败: ${v.error}`);
  } else if (wantsEmail(cfg)) {
    log.warn('  ! 邮箱配置不完整，跳过 SMTP 测试。可在控制面板中设置。');
  } else {
    log.info(`  本地目录: ${cfg.output?.localDir}`);
  }

  log.info('=== 4. 登录凭据检查 ===');
  log.info(`  已保存账号: ${hasStoredCredentials() ? '是' : '否'}`);
  log.info(`  Windows DPAPI 加密: ${(await isDpapiAvailable()) ? '可用（密码加密存储）' : '不可用（将明文存储）'}`);

  log.info('=== 5. 会话检查（实际使用的 HTTP 会话）===');
  // Check what the app actually uses. Reporting on a browser session here was
  // misleading: it said "CAS 会话无效" while a run was succeeding on HTTP.
  const { HttpSession } = await import('./httpSession.js');
  const { COOKIE_FILE } = await import('./httpLogin.js');
  const httpSession = new HttpSession(cfg);
  await httpSession.launch();
  log.info(`  会话 Cookie 文件: ${COOKIE_FILE} (${fs.existsSync(COOKIE_FILE) ? '存在' : '尚未创建'})`);
  log.info(`  已载入 Cookie: ${httpSession.cookieCount} 个`);
  if (probe.ok) {
    const st = await httpSession.isLoggedIn();
    if (st.ok) {
      log.info(`  ✓ HTTP 会话有效（${st.itemCount || 0} 个条目可读，经 ${String(st.url).slice(0, 60)}）`);
    } else {
      log.warn(`  ! HTTP 会话无效：${String(st.reason).slice(0, 120)}`);
      log.info('    运行时会用已保存的账号自动登录（HTTP）。');
    }
    log.info(`  Chrome: ${findChrome() || '未找到'}（仅手动登录时使用）`);
  } else {
    log.warn('  ! 网络不可达，跳过会话检查。');
  }

  log.info('=== 6. 快捷方式检查 ===');
  // Shortcuts store ABSOLUTE paths, so renaming the launcher or moving the folder
  // silently breaks the desktop icon ("无法启动脚本文件"). Report it here.
  const { checkShortcuts, describeShortcut } = await import('./shortcuts.js');
  const sc = await checkShortcuts();
  if (!sc.supported) {
    log.info('  非 Windows，跳过。');
  } else if (sc.error) {
    log.warn(`  无法读取快捷方式: ${sc.error}`);
  } else {
    log.info(`  桌面    : ${describeShortcut(sc.desktop)}`);
    log.info(`  开始菜单: ${describeShortcut(sc.startMenu)}`);
    if (sc.anyStale) {
      log.warn('  ! 快捷方式已失效（通常是因为启动器改名或文件夹被移动）。');
      log.warn('    运行 npm run shortcut 即可重建。');
    } else if (sc.anyMissing) {
      log.info('  未创建快捷方式；运行 npm run shortcut 可以创建。');
    }
  }

  log.info('=== 7. 状态文件 ===');
  const store = new Store();
  log.info(`  ${STATE_PATH}`);
  log.info(`  已记录条目: ${store.size}`);
  const last = store.lastRun;
  log.info(`  上次运行: ${last ? `${last.at} ok=${last.ok} new=${last.newItems ?? 0}${last.newMails ? ` mails=${last.newMails}` : ''}` : '无'}`);
  log.info(`  日志文件: ${getLogFile() || '(仅控制台)'}`);
  return problems.length ? 1 : 0;
}

/** Desktop control panel + background poller. */
async function modeUi(app, flags) {
  let created;
  try {
    created = await createUiServer({ app, port: flags.port || DEFAULT_UI_PORT });
  } catch (err) {
    // The port is taken. Almost always this means an instance is already
    // running (and possibly its lock file was removed by a stray cleanup), so a
    // second launch should surface the existing panel instead of crashing.
    if (String(err.code) === 'EADDRINUSE') {
      const url = `http://127.0.0.1:${flags.port || DEFAULT_UI_PORT}/`;
      log.warn(`端口 ${flags.port || DEFAULT_UI_PORT} 已被占用，可能已有实例在运行。`);
      if (flags.noWindow) log.info(`尝试打开已有控制面板: ${url}`);
      else openAppWindow(url);
      return 0;
    }
    throw err;
  }

  const { url, port, server } = created;

  if (!flags.noWindow) {
    openAppWindow(url);
  } else {
    log.info(`控制面板已就绪（未自动打开窗口）: ${url}`);
  }

  /**
   * Whether the panel drives its own polling loop.
   *
   * Default (`poll.mode = "task"`): NO. Windows Task Scheduler runs a
   * short-lived `--once --quiet` every N hours, so the app never needs to stay
   * resident — closing the panel stops nothing and costs nothing. The panel is
   * purely a control surface, and it picks up runs done by other processes
   * through Store.reloadIfChanged().
   *
   * `poll.mode = "resident"`: keep the old always-on behaviour, for anyone who
   * prefers the process to stay up and poll internally.
   */
  const resident = app.cfg.poll?.mode === 'resident';
  if (resident) {
    app.startScheduler({ notify: makeNotify() });
    log.info(`常驻模式：面板打开期间每 ${app.cfg.poll.intervalMinutes} 分钟自动检查一次。`);
  } else {
    log.info(
      `定时模式：由 Windows 计划任务每 ${app.cfg.poll.intervalMinutes} 分钟执行一次，` +
        '本面板不会常驻轮询，关闭它不会影响定时抓取。',
    );
  }

  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return;
    stopping = true;
    log.info(`收到 ${sig}，正在退出…`);
    app.stopScheduler();
    await app.drain();
    await app.session.close();
    server.close();
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  // Keep the process alive; the server holds the loop open anyway.
  await new Promise(() => {});
  return 0;
}

/** Headless常驻轮询 (no UI). */
async function modeServe(app) {
  app.startScheduler({ notify: makeNotify() });
  log.info(`进入轮询模式：每 ${app.cfg.poll.intervalMinutes} 分钟检查一次。按 Ctrl+C 退出。`);

  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return;
    stopping = true;
    log.info(`收到 ${sig}，正在退出…`);
    app.stopScheduler();
    await app.drain();
    await app.session.close();
    releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  while (!stopping) await sleep(60000);
  return 0;
}

/* ----------------------------------------------------------------- main --- */

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.mode === 'help') {
    printHelp();
    return 0;
  }

  const cfg = loadConfig({ quiet: flags.mode === 'help' });
  if (flags.verbose) cfg.log.level = 'debug';
  initLogger(cfg.log);

  log.info(`BUPT-Notify 启动 (模式: ${flags.mode}${flags.dryRun ? ', dry-run' : ''})`);

  if (flags.mode === 'fixture') return modeFixture(cfg, flags.fixture);
  if (flags.mode === 'check') return modeCheck(cfg);
  if (flags.mode === 'doctor') return modeDoctor(cfg);

  /**
   * Who holds the lock, and for how long?
   *
   *   --once                  one process = one run  → hold for the process
   *   --serve (resident poll) keeps polling          → hold for the process
   *   --ui + poll.mode=task   an idle control panel  → do NOT hold; lock per run
   *
   * The last case is the fix for a silent outage: an open panel used to hold the
   * lock while doing nothing, so every scheduled run skipped with 「已有实例在
   * 运行」and the task still reported success. A second panel is still prevented
   * by the UI port (EADDRINUSE → raise the existing window).
   */
  const residentPoll = cfg.poll?.mode === 'resident';
  const holdLifetime = flags.mode === 'once' || flags.mode === 'serve' || (flags.mode === 'ui' && residentPoll);

  if (holdLifetime) {
    const lock = acquireLock();
    if (!lock.ok) {
      //  - a SCHEDULED run (--once / --quiet) exits quietly: overlapping runs are
      //    expected, and the next tick does the work;
      //  - an interactive launch (double-click) should raise the existing panel.
      if (flags.mode === 'once' || flags.quiet) {
        log.info(`${lock.reason} —— 本轮跳过（定时任务会自动重试）。`);
        return 0;
      }
      const opened = await openExistingInstanceUi(flags);
      if (opened) return 0;
      log.error(lock.reason);
      return 4;
    }
  }

  const app = new App(cfg, {
    quiet: flags.quiet,
    // A task-mode panel locks around each run instead of the whole lifetime.
    lock: holdLifetime ? null : { acquire: acquireLock, release: releaseLock },
  });
  app.on('run-complete', (s) => {
    const extra = s.newMails ? ` 未读邮件=${s.newMails} 封` : '';
    log.info(`运行结束: ok=${s.ok} 新增=${s.newItems ?? 0}${extra} 耗时=${s.durationMs}ms`);
  });

  try {
    if (flags.mode === 'once') {
      const summary = await app.runOnce({
        dryRun: flags.dryRun,
        reason: flags.quiet ? '定时任务' : '单次运行',
        notify: flags.quiet ? makeQuietNotify() : makeNotify(),
      });
      return summary.ok ? 0 : 1;
    }
    if (flags.mode === 'ui') return await modeUi(app, flags);
    return await modeServe(app);
  } finally {
    await app.session.close();
    // Only unlinks when this process is the holder, so it is safe for a panel
    // that never took the lifetime lock.
    releaseLock();
  }
}

main()
  .then((code) => {
    if (process.env.BUPT_NOTIFY_NO_EXIT !== '1') process.exit(code ?? 0);
  })
  .catch((err) => {
    log.error(`未捕获异常: ${err.message}`);
    log.error(err.stack || '');
    releaseLock();
    process.exit(1);
  });
