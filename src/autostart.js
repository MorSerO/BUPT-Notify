/**
 * autostart.js — Windows 计划任务管理，供控制面板一键开关。
 *
 * 模型：**短时执行，不常驻**。
 * 计划任务每隔 N 小时运行一次 `node src\main.js --once --quiet`，跑完即退出。
 * 因此：
 *   - 软件关着也能按时抓取（不需要一直开着）
 *   - 两次执行之间没有任何常驻进程，不占内存 / CPU / 显存
 *   - 执行时窗口完全隐藏，不影响日常使用
 *
 * 这里只负责调用 scripts 下的 PowerShell 脚本并汇报结果；脚本本身是唯一事实
 * 来源（它们还生成隐藏启动器、设置任务参数）。注册当前用户的计划任务不需要
 * 管理员权限。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { log } from './logger.js';
import { ROOT } from './util.js';

export const TASK_NAME = 'BUPT-Notify';

const INSTALL_SCRIPT = path.join(ROOT, 'scripts', 'install-autostart.ps1');
const UNINSTALL_SCRIPT = path.join(ROOT, 'scripts', 'uninstall-autostart.ps1');
const STATUS_SCRIPT = path.join(ROOT, 'scripts', 'task-status.ps1');

/** Run a PowerShell script, returning { ok, code, output }. */
function runPowerShell(scriptPath, args = [], { timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      return resolve({ ok: false, code: -1, output: '仅支持 Windows' });
    }
    if (!fs.existsSync(scriptPath)) {
      return resolve({ ok: false, code: -1, output: `找不到脚本: ${scriptPath}` });
    }

    let child;
    try {
      child = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: ROOT },
      );
    } catch (err) {
      return resolve({ ok: false, code: -1, output: err.message });
    }

    let out = '';
    const collect = (buf) => {
      out += buf.toString('utf8');
      if (out.length > 20000) out = out.slice(-20000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, code: -2, output: `${out}\n(超时)` });
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, output: err.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: out.trim() });
    });
  });
}

/** Query the scheduled task (source of truth for the UI toggle). */
export async function getAutostartStatus() {
  if (process.platform !== 'win32') {
    return { supported: false, installed: false, reason: '仅支持 Windows' };
  }
  const r = await runPowerShell(STATUS_SCRIPT, [TASK_NAME], { timeoutMs: 30000 });

  let parsed = null;
  try {
    // The script prints a single JSON line; take the last in case of noise.
    const line = r.output
      .split(/\r?\n/)
      .reverse()
      .find((l) => l.trim().startsWith('{'));
    if (line) parsed = JSON.parse(line.trim());
  } catch {
    parsed = null;
  }

  if (!parsed) {
    return {
      supported: true,
      installed: false,
      taskName: TASK_NAME,
      error: r.output.slice(0, 300) || '无法查询计划任务',
    };
  }
  return { supported: true, taskName: TASK_NAME, ...parsed };
}

/**
 * Enable or disable the periodic scraping task.
 *
 * @param {boolean} enabled
 * @param {{intervalHours?:number, delaySeconds?:number, mode?:'once'|'ui'}} [opts]
 * @returns {Promise<{ok:boolean, installed:boolean, status?:object, error?:string}>}
 */
export async function setAutostart(
  enabled,
  { intervalHours = 0, delaySeconds = 60, mode = 'once' } = {},
) {
  if (process.platform !== 'win32') {
    return { ok: false, installed: false, error: '定时任务仅支持 Windows' };
  }

  /**
   * Test guard: the automated suite must never touch the machine's real
   * scheduled tasks. Without this, a test that POSTs `enabled: true` would
   * actually register (or unregister) the task on whoever runs the tests.
   */
  if (process.env.BUPT_NOTIFY_NO_SYSTEM_CHANGES === '1') {
    log.info(`[dry-run] 跳过真实的计划任务操作（启用=${enabled}，间隔=${intervalHours}h）`);
    return {
      ok: true,
      installed: enabled,
      mode: enabled ? mode : null,
      dryRun: true,
      status: { supported: true, taskName: TASK_NAME, installed: enabled, intervalHours },
    };
  }

  const script = enabled ? INSTALL_SCRIPT : UNINSTALL_SCRIPT;
  const args = enabled
    ? [
        '-TaskName', TASK_NAME,
        '-IntervalHours', String(intervalHours || 0),
        '-DelaySeconds', String(delaySeconds),
        '-Mode', mode === 'ui' ? 'ui' : 'once',
      ]
    : ['-TaskName', TASK_NAME];

  log.info(`${enabled ? '启用' : '取消'}定时自动抓取…`);
  const r = await runPowerShell(script, args, { timeoutMs: 90000 });
  const status = await getAutostartStatus();

  if (!r.ok) {
    log.error(`定时任务${enabled ? '启用' : '取消'}失败: ${r.output.slice(0, 300)}`);
    return {
      ok: false,
      installed: status.installed,
      error: r.output.slice(0, 400) || `退出码 ${r.code}`,
    };
  }

  log.info(`定时自动抓取已${enabled ? '启用' : '取消'}（计划任务: ${TASK_NAME}）`);
  return { ok: true, installed: status.installed, mode: enabled ? mode : null, status };
}
