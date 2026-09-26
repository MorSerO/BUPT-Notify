/**
 * output.js — deliver new items concisely, to a local digest file and/or email.
 *
 * Per the user's requirement the content is deliberately minimal:
 * each entry is just its TITLE plus the time we captured it. No article bodies,
 * no summaries. The original link is kept by default because without it the
 * digest is not actionable; set output.includeLink=false to drop it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';
import { ensureDir, todayLocal } from './util.js';
import { sendNotification } from './mailer.js';
import { describeStatus } from './portal.js';

/** Format one line for the local digest (Markdown). */
export function formatLocalLine(item, cfg, capturedAt) {
  const o = cfg.output || {};
  const parts = [];

  const tag = o.includeSource === false ? '' : `[${item.source || '门户'}] `;
  let line = `- ${tag}**${item.title || '(无标题)'}**`;

  const meta = [];
  if (o.includePublishDate && item.date) meta.push(`发布 ${item.date}`);
  meta.push(`抓取 ${capturedAt}`);
  line += `  \n  <sub>${meta.join(' · ')}</sub>`;

  if (o.includeLink !== false && item.url) {
    line += `  \n  ${item.url}`;
  }
  parts.push(line);
  return parts.join('\n');
}

/**
 * Format one unread mail.
 *
 * No per-mail link on purpose: Coremail read URLs embed the session id, which
 * has expired long before the reader clicks it — a dead link is worse than none.
 * The sender is more useful anyway, since it tells you whether to bother.
 */
export function formatMailLine(mail, cfg, capturedAt) {
  const meta = [];
  if (mail.sender) meta.push(`${mail.sender}${mail.senderAddress ? ` <${mail.senderAddress}>` : ''}`);
  meta.push(`抓取 ${capturedAt}`);
  return `- **${mail.title || '(无主题)'}**  \n  <sub>${meta.join(' · ')}</sub>`;
}

/**
 * Append the batch to today's digest file.
 *
 * The 待办中心 status line is written only alongside real content — appending a
 * balance line on every quiet check would turn the digest into a log of the
 * balance rather than a record of what was forwarded.
 *
 * @returns {{ok:boolean, file:string, appended:number, error?:string}}
 */
export function writeLocalDigest(items, cfg, { now = new Date(), status = null, mails = [] } = {}) {
  if (!items.length && !mails.length) return { ok: true, file: null, appended: 0 };
  const dir = cfg.output?.localDir || path.join(process.cwd(), 'output');

  try {
    ensureDir(dir);
  } catch (err) {
    log.error(`无法创建本地输出目录 ${dir}: ${err.message}`);
    return { ok: false, file: null, appended: 0, error: err.message };
  }

  const day = todayLocal(now);
  const file = path.join(dir, `北邮通知-${day}.md`);
  const stamp = now.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  const bySource = new Map();
  for (const it of items) {
    const k = it.source || '门户';
    if (!bySource.has(k)) bySource.set(k, []);
    bySource.get(k).push(it);
  }

  const lines = [];
  if (!fs.existsSync(file)) {
    lines.push(`# 北邮校内通知 / 校内文件 转发记录 — ${day}`, '');
    lines.push(`> 由 BUPT-Notify 自动生成。仅记录标题与抓取时间，最近 ${cfg.windowDays} 天窗口内去重。`, '');
  }

  const total = items.length + mails.length;
  const statusLine = describeStatus(status);
  lines.push(
    `## 抓取于 ${stamp}（${total} 条${
      mails.length ? `，其中未读邮件 ${mails.length} 封` : ''
    }）`,
    '',
  );
  if (statusLine) lines.push(`> ${statusLine}`, '');

  if (mails.length) {
    lines.push('### 未读邮件', '');
    for (const m of mails) lines.push(formatMailLine(m, cfg, stamp), '');
  }

  for (const [source, list] of bySource) {
    if (bySource.size > 1 || mails.length) lines.push(`### ${source}`, '');
    for (const it of list) lines.push(formatLocalLine(it, cfg, stamp), '');
  }
  lines.push('---', '');

  try {
    fs.appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
    log.info(`本地记录已写入: ${file} (+${total} 条)`);
    return { ok: true, file, appended: total };
  } catch (err) {
    log.error(`写入本地记录失败: ${err.message}`);
    return { ok: false, file, appended: 0, error: err.message };
  }
}

/**
 * Deliver a batch according to cfg.output.mode.
 *
 * IMPORTANT: a mode counts as succeeded only when every enabled channel
 * succeeded, so `--once`/poller will retry the whole batch otherwise and
 * nothing is silently lost.
 *
 * @returns {Promise<{ok:boolean, local:object|null, email:object|null, error?:string}>}
 */
export async function deliver(items, cfg, { now = new Date(), status = null, mails = [] } = {}) {
  const mode = cfg.output?.mode || 'local';
  const wantLocal = mode === 'local' || mode === 'both';
  const wantMail = mode === 'email' || mode === 'both' || cfg.email?.enabled;

  const result = { ok: true, local: null, email: null, error: null };

  if (wantLocal) {
    result.local = writeLocalDigest(items, cfg, { now, status, mails });
    if (!result.local.ok) {
      result.ok = false;
      result.error = `本地写入失败: ${result.local.error}`;
    }
  }

  if (wantMail) {
    result.email = await sendNotification(items, cfg, { now, status, mails });
    if (!result.email.ok && !result.email.skipped) {
      result.ok = false;
      result.error = result.error || `邮件失败: ${result.email.error}`;
    }
  }

  return result;
}

/** Human-readable description of the configured output mode (for logs/setup). */
export function describeOutput(cfg) {
  const dir = cfg.output?.localDir || '(默认)';
  switch (cfg.output?.mode) {
    case 'email':
      return `仅发送邮件 → ${(cfg.email?.to || []).join(', ') || '(未配置收件人)'}`;
    case 'both':
      return `本地文件 (${dir}) + 邮件 → ${(cfg.email?.to || []).join(', ')}`;
    default:
      return `仅保存到本地: ${dir}`;
  }
}
