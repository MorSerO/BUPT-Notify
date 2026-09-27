/**
 * test-open-panel-runs.mjs — prove that an OPEN panel scrapes and sends by
 * itself, without waiting for Task Scheduler.
 *
 *   node tools/test-open-panel-runs.mjs
 *
 * WHY
 * ---
 * Task Scheduler only fires every N hours, so right after saving a setting the
 * next run can be hours away. With the app sitting open and nothing happening it
 * looks like the schedule 「只能让软件被打开」. `poll.runWhileOpen` (default on)
 * makes the panel re-check every few minutes and catch up as soon as the last
 * SUCCESSFUL run is older than the interval.
 *
 * This tool ages the recorded run times past the interval, opens a panel on a
 * spare port, and watches the log for a run that the panel started on its own.
 *
 * SIDE EFFECTS (a live test, not a unit test):
 *   - it sends mail (normally the 「本次检查没有新内容」 notice)
 *   - it backs up and restores data/state.json, so nothing is marked forwarded
 *   - it uses its own port and never touches a panel you already have open
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = path.join(ROOT, 'data', 'state.json');
const LOCK = path.join(ROOT, 'data', 'bupt-notify.lock');
const PORT = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1] || 17930);
const BASE = `http://127.0.0.1:${PORT}/`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How far back to push the recorded runs.
 *
 * It MUST be derived from the configured interval: ageing by a fixed 5 hours
 * proves nothing when the interval is 12, and the panel would correctly report
 * "not due" while the test calls it a failure. Measured the hard way.
 */
function configuredIntervalMinutes() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    return Number(cfg.poll?.intervalMinutes) || 180;
  } catch {
    return 180;
  }
}
const INTERVAL = configuredIntervalMinutes();
const AGE_MINUTES = Number(
  (process.argv.find((a) => a.startsWith('--age=')) || '').split('=')[1] || INTERVAL + 60,
);

const logFile = () => path.join(ROOT, 'logs', `bupt-notify-${new Date().toISOString().slice(0, 10)}.log`);
const logText = () => (fs.existsSync(logFile()) ? fs.readFileSync(logFile(), 'utf8') : '');
const logLineCount = () => logText().split('\n').filter(Boolean).length;

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

const statePath = path.relative(ROOT, STATE);
if (!fs.existsSync(STATE)) {
  console.log(`${statePath} does not exist yet — run the app once first.`);
  process.exit(1);
}
const stateBackup = fs.readFileSync(STATE, 'utf8');
let panel = null;

try {
  console.log('=== 1. make a catch-up due ===');
  const state = JSON.parse(stateBackup);
  const old = new Date(Date.now() - AGE_MINUTES * 60000).toISOString();
  const runs = state.lastRuns || [];
  if (!runs.length) {
    console.log('  no recorded runs yet — the panel will simply run on open, which is also a pass');
  }
  state.lastRuns = runs.map((r) => ({ ...r, at: old, ok: true }));
  fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
  console.log(`  recorded runs moved ${AGE_MINUTES} minutes into the past (${statePath})`);
  console.log(`  configured interval is ${INTERVAL} minutes, so a catch-up is due`);
  fs.rmSync(LOCK, { force: true });

  const before = logLineCount();

  console.log(`\n=== 2. open a panel on port ${PORT} (real, sends mail) ===`);
  panel = spawn(process.execPath, ['src/main.js', '--ui', '--port', String(PORT), '--no-window'], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
  });
  panel.unref();

  let token = null;
  for (let i = 0; i < 25 && !token; i += 1) {
    await sleep(1000);
    token = await fetch(BASE)
      .then((r) => (r.ok ? r.text() : ''))
      .then((h) => (h.match(/const TOKEN = "([a-f0-9]+)"/) || [])[1] || null)
      .catch(() => null);
  }
  check(Boolean(token), 'panel is up');

  const api = async (p, o = {}) => {
    const r = await fetch(BASE + p, {
      ...o,
      headers: { 'X-BUPT-Token': token, 'Content-Type': 'application/json', ...(o.headers || {}) },
    });
    return { code: r.status, body: await r.json().catch(() => null) };
  };

  console.log('\n=== 3. did the panel scrape + send on its own? ===');
  let fresh = '';
  let ran = false;
  for (let i = 0; i < 40 && !ran; i += 1) {
    await sleep(1000);
    fresh = logText().split('\n').filter(Boolean).slice(before).join('\n');
    ran = /运行结束: ok=/.test(fresh);
  }
  for (const line of fresh.split('\n').filter((l) => /once|校内通知|校内文件|待办中心|未读邮件|邮件已发送|无新内容|运行结束/.test(l))) {
    console.log(`      ${line.replace(/\u001b\[[0-9;]*m/g, '').trim()}`);
  }
  check(ran, 'the open panel completed a run by itself (no Task Scheduler involved)');
  check(/邮件已发送|无新内容/.test(fresh), 'and it sent mail');

  const st = (await api('api/status')).body?.status;
  const reasons = (st?.events || []).map((e) => e.message).filter((m) => /开始抓取/.test(m));
  console.log(`      trigger: ${reasons.join(' | ') || '(none)'}`);
  check(reasons.some((m) => /打开面板补跑/.test(m)), 'it was the due-based catch-up that started it');

  console.log('\n=== 4. the live schedule the panel reports ===');
  console.log(
    `      schedulerActive=${st?.schedulerActive} dueBased=${st?.schedulerDueBased} ` +
      `runDueNow=${st?.runDueNow} next=${st?.nextDueAt}`,
  );
  check(st?.schedulerActive === true, 'a scheduler is armed while the panel is open');
  check(st?.schedulerDueBased === true, 'due-based, not a second fixed schedule');
  check(st?.runDueNow === false, 'not due again right after the run');
  check(Boolean(st?.nextDueAt) && Date.parse(st.nextDueAt) > Date.now(), 'the next catch-up is set');

  console.log('\n=== 5. it does not immediately run a second time ===');
  const mark = logLineCount();
  await sleep(8000);
  check(
    !/运行结束/.test(logText().split('\n').filter(Boolean).slice(mark).join('\n')),
    'no duplicate run while the interval has not elapsed',
  );
} finally {
  console.log('\n=== cleanup ===');
  if (panel?.pid) {
    try {
      process.kill(panel.pid);
    } catch {
      /* already gone */
    }
  }
  await sleep(1500);
  fs.writeFileSync(STATE, stateBackup);
  fs.rmSync(LOCK, { force: true });
  // Any stray panel started by this tool on OUR port only.
  try {
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match '--port ${PORT}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
      { encoding: 'utf8' },
    );
  } catch {
    /* best effort */
  }
  console.log(`  ${statePath} restored, lock cleared, test panel stopped`);
}

console.log(`\n${failures ? `${failures} check(s) FAILED` : 'ALL CHECKS PASSED'}`);
console.log('(your own panel, if open, was never touched — this test used its own port)');
process.exit(failures ? 1 : 0);
