/**
 * shortcuts.js — 检查 / 修复桌面与开始菜单快捷方式。
 *
 * 为什么需要它：快捷方式里存的是**绝对路径**。启动器一旦改名、或者整个文件夹
 * 被移动，快捷方式就会指向一个不存在的文件，双击时只弹一句
 * 「无法启动脚本文件」，很难看出原因（这个坑真的踩过一次：把
 * `启动 BUPT-Notify.vbs` 改名为 `start-bupt-notify.vbs` 后，桌面图标失效了）。
 *
 * 所以 `npm run doctor` 会顺带检查，`repairShortcuts()` 可以一键修好。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { log } from './logger.js';
import { ROOT } from './util.js';

const CHECK_SCRIPT = path.join(ROOT, 'scripts', 'check-shortcuts.ps1');
const CREATE_SCRIPT = path.join(ROOT, 'scripts', 'create-shortcut.ps1');

function runPowerShell(scriptPath, args = [], { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ ok: false, output: '仅支持 Windows' });
    if (!fs.existsSync(scriptPath)) return resolve({ ok: false, output: `找不到脚本: ${scriptPath}` });

    let child;
    try {
      child = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, cwd: ROOT },
      );
    } catch (err) {
      return resolve({ ok: false, output: err.message });
    }

    let out = '';
    const collect = (b) => {
      out += b.toString('utf8');
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
      resolve({ ok: false, output: `${out}\n(超时)` });
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: err.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: out.trim() });
    });
  });
}

/**
 * Inspect the desktop and Start Menu shortcuts.
 * @returns {Promise<{supported:boolean, desktop:object|null, startMenu:object|null,
 *                    anyMissing:boolean, anyStale:boolean, error?:string}>}
 */
export async function checkShortcuts() {
  if (process.platform !== 'win32') {
    return { supported: false, desktop: null, startMenu: null, anyMissing: false, anyStale: false };
  }
  const r = await runPowerShell(CHECK_SCRIPT, [], { timeoutMs: 30000 });

  let parsed = null;
  try {
    const line = r.output
      .split(/\r?\n/)
      .reverse()
      .find((l) => l.trim().startsWith('{'));
    if (line) parsed = JSON.parse(line.trim());
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.error) {
    return {
      supported: true,
      desktop: null,
      startMenu: null,
      anyMissing: false,
      anyStale: false,
      error: parsed?.error || r.output.slice(0, 200) || '无法读取快捷方式',
    };
  }

  const links = [parsed.desktop, parsed.startMenu].filter(Boolean);
  return {
    supported: true,
    desktop: parsed.desktop || null,
    startMenu: parsed.startMenu || null,
    // No shortcut at all is not an error — the app can be started with npm run ui.
    anyMissing: links.length === 0,
    anyStale: links.some((l) => l.exists && !l.valid),
  };
}

/** Recreate the desktop / Start Menu shortcuts (fixes a stale target). */
export async function repairShortcuts() {
  log.info('正在重建快捷方式…');
  const r = await runPowerShell(CREATE_SCRIPT, [], { timeoutMs: 90000 });
  const status = await checkShortcuts();
  if (!r.ok) {
    return { ok: false, error: r.output.slice(0, 400) || '重建失败', status };
  }
  return { ok: true, status, output: r.output };
}

/** Human-readable one-liner for a single shortcut entry. */
export function describeShortcut(entry) {
  if (!entry) return '(不存在)';
  if (!entry.exists) return '未创建';
  if (entry.valid) return `正常 -> ${entry.target}`;
  if (entry.reason === 'script-missing') return `失效：指向的启动器不存在 -> ${entry.target}`;
  if (entry.reason === 'exe-missing') return `失效：wscript.exe 不存在 -> ${entry.exe}`;
  return `异常：${entry.reason}`;
}
