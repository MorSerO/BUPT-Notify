/**
 * mailer.js — send the notification email via SMTP (default: QQ Mail).
 *
 * Content is intentionally MINIMAL, per the user's request: each entry is the
 * title plus the time we captured it. Article bodies and summaries are not
 * fetched or included.
 *
 * QQ Mail requires an authorisation code ("授权码"), NOT the login password:
 *   设置 → 账户 → POP3/IMAP/SMTP服务 → 开启 → 生成授权码
 * `npm run setup` prompts for it and writes config.json.
 */

import nodemailer from 'nodemailer';
import { log } from './logger.js';
import { todayLocal } from './util.js';
import { describeStatus } from './portal.js';

export function createTransport(emailCfg) {
  return nodemailer.createTransport({
    host: emailCfg.host,
    port: emailCfg.port,
    secure: emailCfg.secure,
    auth: { user: emailCfg.user, pass: emailCfg.pass },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  });
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Group items by their source column, preserving order. */
function groupBySource(items) {
  const bySource = new Map();
  for (const it of items) {
    const k = it.source || '门户';
    if (!bySource.has(k)) bySource.set(k, []);
    bySource.get(k).push(it);
  }
  return bySource;
}

/**
 * Build a concise subject/text/html for a batch of new items.
 *
 * Two kinds of content can ride along: portal notices/files (`items`) and unread
 * mail subjects (`mails`). The 待办中心 status line (校园卡余额 / 未读邮件数) is
 * always included when it could be read.
 */
export function composeMail(items, cfg, { now = new Date(), status = null, mails = [] } = {}) {
  const prefix = cfg.email?.subjectPrefix || '[北邮通知]';
  const day = todayLocal(now);
  const stamp = now.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  const bySource = groupBySource(items);
  const total = items.length + mails.length;
  const counts = [...bySource.entries()].map(([k, v]) => `${k} ${v.length} 条`);
  if (mails.length) counts.push(`未读邮件 ${mails.length} 封`);
  // No stray `（）` when there is nothing to break down.
  const subject = `${prefix} ${day} 新增 ${total} 条${counts.length ? `（${counts.join('，')}）` : ''}`;

  const wantLink = cfg.output?.includeLink !== false;
  const wantDate = cfg.output?.includePublishDate === true;
  const wantSource = cfg.output?.includeSource !== false;

  const statusLine = describeStatus(status);

  /* ------------------------------ plain text ------------------------------ */
  const txt = [
    `北邮校内门户新增内容 — 抓取于 ${stamp}`,
    `共 ${total} 条${mails.length ? `（其中未读邮件 ${mails.length} 封）` : ''}`,
    ...(statusLine ? ['', statusLine] : []),
    '',
  ];

  if (mails.length) {
    // One link for the whole section: per-mail Coremail URLs carry a session id
    // that has expired by the time the mail is read.
    const boxUrl = cfg.portal?.mailBase || 'https://mail.bupt.edu.cn';
    txt.push(`【未读邮件】（在 ${boxUrl} 登录后可看原文）`);
    mails.forEach((m, i) => {
      txt.push(`${i + 1}. ${m.title || '(无主题)'}`);
      const meta = [];
      if (m.sender) meta.push(`${m.sender}${m.senderAddress ? ` <${m.senderAddress}>` : ''}`);
      meta.push(`抓取 ${stamp}`);
      txt.push(`   ${meta.join(' | ')}`);
    });
    txt.push('');
  }

  for (const [source, list] of bySource) {
    txt.push(`【${source}】`);
    list.forEach((it, i) => {
      txt.push(`${i + 1}. ${it.title || '(无标题)'}`);
      const meta = [];
      if (wantDate && it.date) meta.push(`发布 ${it.date}`);
      meta.push(`抓取 ${stamp}`);
      txt.push(`   ${meta.join(' | ')}`);
      if (wantLink && it.url) txt.push(`   ${it.url}`);
    });
    txt.push('');
  }
  txt.push('-- ', '由 BUPT-Notify 自动发送，请勿回复。');

  /* --------------------------------- html -------------------------------- */
  const h = [
    `<div style="font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;font-size:14px;color:#222;max-width:760px">`,
    `<p style="margin:0 0 6px;color:#555">抓取于 <b>${esc(stamp)}</b> · 共 <b>${total}</b> 条${
      mails.length ? `（其中未读邮件 ${mails.length} 封）` : ''
    }</p>`,
  ];
  if (statusLine) {
    h.push(
      `<p style="margin:0 0 14px;padding:8px 12px;background:#f4f7fb;border-left:3px solid #1a5fb4;color:#333;font-size:13px">${esc(
        statusLine,
      )}</p>`,
    );
  } else {
    h.push('<div style="height:8px"></div>');
  }

  if (mails.length) {
    const boxUrl = cfg.portal?.mailBase || 'https://mail.bupt.edu.cn';
    h.push(
      `<div style="margin:18px 0 6px;font-weight:600;color:#b45309;border-bottom:1px solid #e5e7eb;padding-bottom:4px">未读邮件 (${mails.length})</div>`,
      `<div style="color:#999;font-size:12px;margin-bottom:8px">` +
        `标题转自校园邮箱，<a href="${esc(boxUrl)}" style="color:#1a5fb4">登录邮箱</a>可看原文。</div>`,
      '<ol style="margin:0;padding-left:22px">',
    );
    for (const m of mails) {
      const meta = [];
      if (m.sender) meta.push(`${esc(m.sender)}${m.senderAddress ? ` &lt;${esc(m.senderAddress)}&gt;` : ''}`);
      meta.push(`抓取 ${esc(stamp)}`);
      h.push(
        `<li style="margin:0 0 10px;line-height:1.5">${esc(m.title || '(无主题)')}`,
        `<div style="color:#999;font-size:12px">${meta.join(' · ')}</div>`,
        `</li>`,
      );
    }
    h.push('</ol>');
  }

  for (const [source, list] of bySource) {
    if (wantSource) {
      h.push(
        `<div style="margin:18px 0 6px;font-weight:600;color:#1a5fb4;border-bottom:1px solid #e5e7eb;padding-bottom:4px">${esc(
          source,
        )} (${list.length})</div>`,
      );
    }
    h.push('<ol style="margin:0;padding-left:22px">');
    for (const it of list) {
      const meta = [];
      if (wantDate && it.date) meta.push(`发布 ${esc(it.date)}`);
      meta.push(`抓取 ${esc(stamp)}`);
      const title = wantLink && it.url
        ? `<a href="${esc(it.url)}" style="color:#1a5fb4;text-decoration:none">${esc(it.title || '(无标题)')}</a>`
        : esc(it.title || '(无标题)');
      h.push(
        `<li style="margin:0 0 10px;line-height:1.5">${title}`,
        `<div style="color:#999;font-size:12px">${meta.join(' · ')}</div>`,
        `</li>`,
      );
    }
    h.push('</ol>');
  }
  h.push(
    `<p style="color:#aaa;font-size:12px;margin-top:22px">由 BUPT-Notify 自动发送，请勿回复。</p></div>`,
  );

  return { subject, text: txt.join('\n'), html: h.join('\n') };
}

/**
 * Send one notification email covering all new items.
 * @returns {Promise<{ok:boolean, messageId?:string, error?:string, skipped?:boolean, accepted?:string[]}>}
 */
export async function sendNotification(items, cfg, { now = new Date(), status = null, mails = [] } = {}) {
  if (!items.length && !mails.length) return { ok: true, skipped: true };
  if (!cfg.email?.enabled) {
    log.warn(`邮件发送已禁用，跳过 ${items.length + mails.length} 条。`);
    return { ok: true, skipped: true };
  }
  if (!cfg.email.pass) {
    const msg = '未配置 QQ 邮箱授权码，无法发信。请运行 "npm run setup" 填写。';
    log.error(msg);
    return { ok: false, error: msg };
  }

  const { subject, text, html } = composeMail(items, cfg, { now, status, mails });
  const transport = createTransport(cfg.email);
  const from = cfg.email.from || cfg.email.user;

  try {
    const info = await transport.sendMail({
      from: `"BUPT-Notify" <${from}>`,
      to: cfg.email.to.join(', '),
      subject,
      text,
      html,
    });
    log.info(`邮件已发送: ${subject}`);
    log.debug(`messageId=${info.messageId} accepted=${JSON.stringify(info.accepted)}`);
    return { ok: true, messageId: info.messageId, accepted: info.accepted };
  } catch (err) {
    log.error(`邮件发送失败: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    transport.close?.();
  }
}

/**
 * A short "nothing new" notice, sent when a check finds no new items.
 *
 * Deliberately minimal: the point is to prove the tool is alive and ran, not to
 * carry content. It reports the window, the next scheduled check and — since
 * these are read anyway — 校园卡余额 / 未读邮件数, so even a quiet check still
 * tells the user the two numbers they asked to see.
 */
export function composeEmptyMail(cfg, { now = new Date(), nextRunAt = null, stats = null, status = null } = {}) {
  const prefix = cfg.email?.subjectPrefix || '[北邮通知]';
  const day = todayLocal(now);
  const stamp = now.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const next = nextRunAt ? nextRunAt.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : null;

  const subject = `${prefix} ${day} 本次检查没有新内容`;

  const scanned = stats?.fetched ? `已检查 ${stats.fetched} 条` : '';
  const detail = [
    `本次检查时间：${stamp}`,
    `检查范围：最近 ${cfg.windowDays} 天`,
    scanned,
    next ? `下次检查：${next}` : '',
  ].filter(Boolean);

  // The status line is the one piece of *content* a quiet check can carry.
  const statusLine = describeStatus(status);
  const statusText = status && status.unreadMail !== null && status.unreadMail !== undefined
    ? `未读邮件数来自门户待办中心，标题转发${cfg.portal?.mailbox === false ? '已关闭' : '本次没有新增'}。`
    : '';

  const txt = [
    '北邮校内通知 / 校内文件 —— 本次检查没有新内容。',
    '',
    ...(statusLine ? [statusLine, ''] : []),
    ...detail,
    '',
    '这条邮件说明程序正常运行，只是暂时没有需要转发的新通知。',
    ...(statusText ? [statusText] : []),
    '如需关闭此类「无新内容」提醒，可在控制面板的「抓取设置」里取消勾选。',
  ].join('\n');

  const html = [
    `<div style="font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;font-size:14px;color:#222;max-width:640px">`,
    `<p style="margin:0 0 10px;font-size:15px">本次检查<b>没有新内容</b>。</p>`,
    ...(statusLine
      ? [
          `<p style="margin:0 0 12px;padding:8px 12px;background:#f4f7fb;border-left:3px solid #1a5fb4;color:#333;font-size:13px">${esc(
            statusLine,
          )}</p>`,
        ]
      : []),
    `<div style="color:#666;line-height:1.8;font-size:13px">${detail.map((d) => esc(d)).join('<br>')}</div>`,
    `<p style="color:#999;font-size:12px;margin-top:18px">这条邮件说明程序正常运行，只是暂时没有需要转发的新通知。<br>${
      statusText ? `${esc(statusText)}<br>` : ''
    }`,
    `如需关闭此类提醒，可在控制面板的「抓取设置」里取消勾选。</p>`,
    `</div>`,
  ].join('\n');

  return { subject, text: txt, html };
}

/** Send the "nothing new" notice. */
export async function sendEmptyNotification(cfg, { now = new Date(), nextRunAt = null, stats = null, status = null } = {}) {
  if (!cfg.email?.enabled) return { ok: true, skipped: true };
  if (!cfg.email.pass) {
    const msg = '未配置 QQ 邮箱授权码，无法发信。请运行 "npm run setup" 填写。';
    log.error(msg);
    return { ok: false, error: msg };
  }
  const { subject, text, html } = composeEmptyMail(cfg, { now, nextRunAt, stats, status });
  const transport = createTransport(cfg.email);
  const from = cfg.email.from || cfg.email.user;
  try {
    const info = await transport.sendMail({
      from: `"BUPT-Notify" <${from}>`,
      to: cfg.email.to.join(', '),
      subject,
      text,
      html,
    });
    log.info(`已发送「无新内容」提醒: ${subject}`);
    return { ok: true, messageId: info.messageId, empty: true };
  } catch (err) {
    log.error(`发送「无新内容」提醒失败: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    transport.close?.();
  }
}

/** Send a test email to verify credentials (used by setup / doctor). */
export async function sendTestMail(cfg) {
  const now = new Date();
  const probe = {
    title: 'BUPT-Notify 测试邮件 —— 如果你看到这封邮件，说明授权码配置正确',
    url: cfg.baseUrl,
    source: '自检',
    date: null,
    newsId: 'test',
    treeId: 'test',
  };
  const transport = createTransport(cfg.email);
  const from = cfg.email.from || cfg.email.user;
  const { subject, text, html } = composeMail([probe], cfg, { now });
  try {
    const info = await transport.sendMail({
      from: `"BUPT-Notify" <${from}>`,
      to: cfg.email.to.join(', '),
      subject: `${cfg.email.subjectPrefix || '[北邮通知]'} 测试邮件`,
      text,
      html,
    });
    return { ok: true, messageId: info.messageId };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    transport.close?.();
  }
}

/** Verify SMTP credentials without sending anything. */
export async function verifyTransport(emailCfg) {
  const transport = createTransport(emailCfg);
  try {
    await transport.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    transport.close?.();
  }
}
