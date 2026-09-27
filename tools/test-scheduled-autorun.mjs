/**
 * test-scheduled-autorun.mjs — prove that the Windows scheduled task really does
 * start the app and complete a scrape + send **with the software closed**.
 *
 *   node tools/test-scheduled-autorun.mjs              # read-only: checks the real task
 *   node tools/test-scheduled-autorun.mjs --live       # also fire a 2-minute test task
 *   node tools/test-scheduled-autorun.mjs --live --close-app
 *
 * WHY A SEPARATE TOOL
 * -------------------
 * "The task only opens the app, it never scrapes or sends" is the kind of claim
 * that cannot be settled by reading code — the action, the launcher, the working
 * directory, the user's logon state and the DPAPI credentials all have to line up.
 * This tool registers a TEMPORARY task with the SAME launcher
 * (`scripts/run-hidden.vbs`) at a short interval, waits for Windows to fire it on
 * its own, and then reads the log to see whether a full run happened:
 *
 *     network probe → session → 校内通知/校内文件 → 待办中心 → 未读邮件 → mail sent
 *
 * The user's real task is never modified, and the temporary one is always removed.
 *
 * NOTE: a live run really does send mail (usually the 「本次检查没有新内容」 notice).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = path.join(ROOT, 'data', 'bupt-notify.lock');
const LAUNCHER = path.join(ROOT, 'scripts', 'run-hidden.vbs');
const REAL_TASK = 'BUPT-Notify';
const TEST_TASK = 'BUPT-Notify-SelfTest';

const args = process.argv.slice(2);
const live = args.includes('--live');
const closeApp = args.includes('--close-app');
const intervalMinutes = Number((args.find((a) => a.startsWith('--every=')) || '').split('=')[1] || 2);
const timeoutMs = Number((args.find((a) => a.startsWith('--timeout=')) || '').split('=')[1] || 5 * 60) * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ps(command) {
  return execFileSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8' },
  ).trim();
}

const json = (command) => {
  const out = ps(command);
  return out ? JSON.parse(out) : null;
};

function logFile() {
  return path.join(ROOT, 'logs', `bupt-notify-${new Date().toISOString().slice(0, 10)}.log`);
}

const logText = () => (fs.existsSync(logFile()) ? fs.readFileSync(logFile(), 'utf8') : '');
const logLineCount = () => logText().split('\n').filter(Boolean).length;

/** PIDs of BUPT-Notify processes (the panel or a run). */
function appPids() {
  const out = ps(
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      "Where-Object { $_.CommandLine -match 'main\\.js' } | " +
      'ForEach-Object { $_.ProcessId }',
  );
  return out ? out.split(/\s+/).filter(Boolean) : [];
}

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

/* ------------------------------ 1. real task ----------------------------- */

console.log(`=== the real scheduled task (${REAL_TASK}) ===`);
const real = json(
  `$t = Get-ScheduledTask -TaskName '${REAL_TASK}' -ErrorAction Stop; ` +
    `[pscustomobject]@{ ` +
    `enabled = $t.Settings.Enabled; ` +
    `execute = $t.Actions[0].Execute; ` +
    `arguments = $t.Actions[0].Arguments; ` +
    `workingDirectory = $t.Actions[0].WorkingDirectory; ` +
    `startBoundary = "$($t.Triggers[0].StartBoundary)"; ` +
    `interval = "$($t.Triggers[0].Repetition.Interval)"; ` +
    `duration = "$($t.Triggers[0].Repetition.Duration)"; ` +
    `logonType = "$($t.Principal.LogonType)"; ` +
    `startWhenAvailable = $t.Settings.StartWhenAvailable; ` +
    `wakeToRun = $t.Settings.WakeToRun; ` +
    `timeLimit = "$($t.Settings.ExecutionTimeLimit)" ` +
    `} | ConvertTo-Json -Compress`,
);

if (!real) {
  console.log('  the task is not registered — run: npm run autostart');
  process.exit(1);
}
console.log(`      action   : ${real.execute} ${real.arguments}`);
console.log(`      cwd      : ${real.workingDirectory}`);
console.log(`      interval : ${real.interval} (duration '${real.duration}' = forever)`);
console.log(`      next     : ${real.startBoundary}`);
console.log(`      logon    : ${real.logonType}, wake=${real.wakeToRun}, catchUp=${real.startWhenAvailable}`);

check(real.enabled === true, 'the task is enabled');
check(/wscript\.exe$/i.test(real.execute), 'it launches through wscript.exe');
check(/run-hidden\.vbs/.test(real.arguments), 'via the hidden launcher');
check(/--once/.test(fs.readFileSync(LAUNCHER, 'utf8')), 'the launcher runs `--once --quiet`');
check(!/--ui|start-bupt-notify/.test(fs.readFileSync(LAUNCHER, 'utf8')), 'the launcher never opens the panel');
check(real.logonType === 'Interactive', 'runs as the logged-on user (needed for DPAPI credentials)');

const info = json(
  `$i = Get-ScheduledTaskInfo -TaskName '${REAL_TASK}'; ` +
    `[pscustomobject]@{ lastRun = "$($i.LastRunTime)"; result = $i.LastTaskResult; next = "$($i.NextRunTime)" } | ConvertTo-Json -Compress`,
);
console.log(`      last run : ${info?.lastRun}  result=${info?.result}  next=${info?.next}`);

/* ----------------------------- 2. live firing ---------------------------- */

if (!live) {
  console.log('\n(only the configuration was checked — add --live to actually watch a firing)');
  console.log(`\n${failures ? `${failures} check(s) FAILED` : 'config checks passed'}`);
  process.exit(failures ? 1 : 0);
}

let restorePanel = false;
try {
  console.log('\n=== preparing a live test ===');
  let pids = appPids();
  if (pids.length && closeApp) {
    console.log(`  closing ${pids.length} running process(es) so "the software is closed" is true`);
    ps(
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
        "Where-Object { $_.CommandLine -match 'main\\.js' } | " +
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    );
    await sleep(2000);
    restorePanel = true;
    pids = appPids();
  } else if (pids.length) {
    console.log(`  note: ${pids.length} BUPT-Notify process(es) are running (pass --close-app to close them)`);
  }
  fs.rmSync(LOCK, { force: true });
  check(pids.length === 0 || !closeApp, 'no BUPT-Notify process is running');
  check(LAUNCHER, 'the launcher exists', path.relative(ROOT, LAUNCHER));

  const before = logLineCount();
  console.log(`\n=== registering a temporary task: same launcher, every ${intervalMinutes} min ===`);
  ps(
    `try { Unregister-ScheduledTask -TaskName '${TEST_TASK}' -Confirm:$false -ErrorAction Stop } catch { }; 'ok'`,
  );
  const boundary = ps(
    `$a = New-ScheduledTaskAction -Execute 'C:\\Windows\\System32\\wscript.exe' ` +
      `-Argument '"${LAUNCHER}"' -WorkingDirectory '${ROOT}'; ` +
      `$t = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(25) ` +
      `-RepetitionInterval (New-TimeSpan -Minutes ${intervalMinutes}) ` +
      `-RepetitionDuration (New-TimeSpan -Days 1); ` +
      `$p = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType Interactive; ` +
      `$s = New-ScheduledTaskSettingsSet -StartWhenAvailable ` +
      `-ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew; ` +
      `Register-ScheduledTask -TaskName '${TEST_TASK}' -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null; ` +
      `(Get-ScheduledTask -TaskName '${TEST_TASK}').Triggers[0].StartBoundary`,
  );
  console.log(`  first automatic firing at ${boundary} — nobody will touch anything`);
  console.log('  (waiting for Windows to fire it by itself…)\n');

  let fired = null;
  const deadline = Date.now() + timeoutMs;
  let lastTick = 0;
  while (Date.now() < deadline && !fired) {
    await sleep(3000);
    const fresh = logText().split('\n').filter(Boolean).slice(before);
    if (fresh.some((l) => /运行结束: ok=/.test(l))) fired = fresh;
    if (Date.now() - lastTick > 30000) {
      lastTick = Date.now();
      console.log(`  … still waiting (${Math.round((deadline - Date.now()) / 1000)}s left)`);
    }
  }

  console.log('');
  check(Boolean(fired), 'Windows fired the task on its own');
  if (fired) {
    for (const line of fired) {
      console.log(`      ${line.replace(/\u001b\[[0-9;]*m/g, '').trim()}`);
    }
    check(fired.some((l) => /模式: once/.test(l)), 'it ran the short-lived --once pipeline');
    check(fired.some((l) => /校内通知|校内文件/.test(l)), 'it scraped the portal columns');
    check(fired.some((l) => /待办中心/.test(l)), 'it read 校园卡余额 / 未读邮件数');
    check(fired.some((l) => /邮件已发送|无新内容/.test(l)), 'it SENT mail');
    check(fired.some((l) => /运行结束: ok=true/.test(l)), 'the run reported success');
  }

  const testInfo = json(
    `$i = Get-ScheduledTaskInfo -TaskName '${TEST_TASK}'; ` +
      `[pscustomobject]@{ lastRun = "$($i.LastRunTime)"; result = $i.LastTaskResult; next = "$($i.NextRunTime)" } | ConvertTo-Json -Compress`,
  );
  console.log(
    `\n  Windows recorded: last=${testInfo?.lastRun} result=${testInfo?.result} next=${testInfo?.next}`,
  );
  check(testInfo?.result === 0, 'task result code is 0');

  await sleep(4000);
  check(appPids().length === 0, 'no process lingers after the run (nothing stays resident)');
  check(!fs.existsSync(LOCK), 'the lock was released');
} finally {
  console.log('\n=== cleanup ===');
  ps(`try { Unregister-ScheduledTask -TaskName '${TEST_TASK}' -Confirm:$false -ErrorAction Stop } catch { }; 'ok'`);
  const left = ps(`(Get-ScheduledTask -TaskName '${TEST_TASK}' -ErrorAction SilentlyContinue | Measure-Object).Count`);
  console.log(`  temporary task removed: ${Number(left) === 0 ? 'yes' : 'NO — check Task Scheduler'}`);
  if (restorePanel) {
    console.log('  restarting the panel that --close-app closed');
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `Start-Process wscript.exe -ArgumentList '"${path.join(ROOT, 'start-bupt-notify.vbs')}"'`],
      { encoding: 'utf8' },
    );
    await sleep(8000);
    console.log(`  panel running again: ${appPids().length > 0 ? 'yes' : 'no'}`);
  }
}

console.log(`\n${failures ? `${failures} check(s) FAILED` : 'ALL CHECKS PASSED'}`);
process.exit(failures ? 1 : 0);
