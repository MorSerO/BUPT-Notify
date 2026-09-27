/**
 * lock.js — the single-instance / single-run lock.
 *
 * TWO DIFFERENT JOBS, ONE FILE
 * ---------------------------
 * The lock stops two BUPT-Notify processes from scraping at the same time, which
 * would double-send the same items.
 *
 * It used to be taken for the whole process lifetime. That is right for a
 * `--once` run and for a resident `--serve` poller, but it was WRONG for the
 * control panel: a panel sitting open (doing nothing) held the lock, so every
 * scheduled run logged
 *
 *     已有实例在运行 (pid 38128) —— 本轮跳过（定时任务会自动重试）
 *
 * and skipped. Measured on 2026-09-26: the 14:15 scheduled run was skipped
 * exactly this way, and the task still reported success — a silent outage for as
 * long as the panel stayed open.
 *
 * So a task-mode panel no longer holds the lock while idle; it takes it around
 * each run instead (see App's `lock` option). A single panel instance is still
 * enforced, by the UI port: a second launch gets EADDRINUSE and raises the
 * existing window.
 *
 * Stale locks self-heal: the file holds a pid, and a lock whose pid is gone is
 * taken over instead of blocking forever (a force-killed process cannot clean up
 * after itself).
 */

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ensureDir } from './util.js';
import { log } from './logger.js';

export const LOCK_FILE = path.join(DATA_DIR, 'bupt-notify.lock');

/** Is this pid a live process? (EPERM counts: it exists, just not ours.) */
export function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Read the lock file without judging it. */
export function readLock(file = LOCK_FILE) {
  try {
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    if (!Number.isFinite(pid) || pid <= 0) return { pid: null, alive: false, raw: true };
    return { pid, alive: pidAlive(pid) };
  } catch {
    return null; // no lock file
  }
}

/**
 * Try to take the lock.
 *
 * @returns {{ok:boolean, reason?:string, stale?:boolean, file:string}}
 */
export function acquireLock({ file = LOCK_FILE } = {}) {
  ensureDir(path.dirname(file));
  const held = readLock(file);
  if (held && held.pid && held.pid !== process.pid && held.alive) {
    return { ok: false, file, reason: `已有实例在运行 (pid ${held.pid})` };
  }
  if (held) {
    // Either the holder is gone or the file is garbage — both are ours to take.
    log.debug(`清理陈旧的锁文件 (${held.pid ?? '无法解析'})`);
  }
  fs.writeFileSync(file, String(process.pid), 'utf8');
  return { ok: true, file, stale: Boolean(held) };
}

/** Release the lock, but only if we are the holder. */
export function releaseLock({ file = LOCK_FILE } = {}) {
  try {
    const held = readLock(file);
    if (held && held.pid === process.pid) fs.unlinkSync(file);
  } catch {
    /* best effort */
  }
}

/** Run `fn` while holding the lock. Returns `{busy:true}` when someone else has it. */
export async function withLock(fn, { file = LOCK_FILE } = {}) {
  const lock = acquireLock({ file });
  if (!lock.ok) return { ok: false, busy: true, reason: lock.reason };
  try {
    return await fn();
  } finally {
    releaseLock({ file });
  }
}
