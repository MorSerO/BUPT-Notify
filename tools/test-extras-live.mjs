/**
 * test-extras-live.mjs — live verification of the two extra sources, going
 * through the SAME code path the app uses (collector.collectExtras).
 *
 *   node tools/test-extras-live.mjs              # read-only
 *   node tools/test-extras-live.mjs --self-mail  # send ONE test mail to your own
 *                                                # campus mailbox, then re-read
 *
 * Read-only by default. `--self-mail` exists because the unread filter can only
 * be proven with a genuinely unread message, and the account's own mailbox is the
 * only one available. The message is clearly labelled and safe to delete.
 *
 * Nothing here writes the real dedup state — it uses a throwaway state file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { HttpSession } from '../src/httpSession.js';
import { loadCredentials } from '../src/secrets.js';
import { Store } from '../src/store.js';
import { collectExtras } from '../src/collector.js';
import { describeStatus, parseWidgets } from '../src/portal.js';
import { parseMailList, mailToItem, openMailbox } from '../src/mailbox.js';
import { composeMail, createTransport } from '../src/mailer.js';
import { sleep } from '../src/util.js';

const selfMail = process.argv.includes('--self-mail');
const cfg = loadConfig({ quiet: true });
const creds = await loadCredentials();
if (!creds?.username) {
  console.log('no saved credentials — cannot run');
  process.exit(1);
}

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures += 1;
};

const session = new HttpSession(cfg);
await session.launch();
const login = await session.ensureLoggedIn({ credentials: creds, allowManualLogin: false });
check(login.ok, 'portal session', login.method || login.reason);
if (!login.ok) process.exit(1);

/* --------------------------- optional test mail --------------------------- */

if (selfMail) {
  const to = `${creds.username}@bupt.cn`;
  const stamp = new Date().toLocaleString('zh-CN');
  console.log(`\n=== 给自己发一封测试邮件 (${to}) ===`);
  const transport = createTransport(cfg.email);
  try {
    const info = await transport.sendMail({
      from: `"BUPT-Notify 自测" <${cfg.email.from || cfg.email.user}>`,
      to,
      subject: `[BUPT-Notify 自测] 未读邮件抓取验证 ${stamp}`,
      text:
        '这是一封由 BUPT-Notify 发出的自测邮件，用来验证「未读邮件标题转发」。\n' +
        `发送时间：${stamp}\n收到后可以直接删除。\n`,
    });
    check(Boolean(info.messageId), 'test mail accepted by SMTP', info.messageId);
  } catch (err) {
    check(false, 'test mail accepted by SMTP', err.message);
  } finally {
    transport.close?.();
  }
  // Give the campus mailbox a moment to deliver it.
  await sleep(20000);
}

/* ------------------- the real path: collector.collectExtras ---------------- */

console.log('\n=== collectExtras()（应用实际走的路径）===');
const store = new Store({ file: path.join(os.tmpdir(), 'bupt-extras-live-state.json') });
const extras = await collectExtras(session, cfg, store, {});

const status = extras.status;
check(Boolean(status), 'widgets read', status?.error || describeStatus(status));
check(status?.ok === true, 'widget endpoint returned data');
check(typeof status?.balance === 'number', '校园卡余额 is a number', `¥${status?.balance}`);
check(typeof status?.unreadMail === 'number', '未读邮件数 is a number', String(status?.unreadMail));
if (extras.errors.length) console.log(`      warnings: ${extras.errors.join('; ')}`);

console.log('\n=== 未读邮件 ===');
console.log(`      未读合计 ${extras.unreadTotal ?? '(未知)'} 封，其中本次新增 ${extras.mails.length} 条`);
for (const m of extras.mails) {
  console.log(`      ${m.date || '?'}  ${m.sender} <${m.senderAddress}> :: ${m.title}`);
  if (m.preview) console.log(`            ${m.preview}`);
}
check(
  extras.mails.every((m) => m.title && m.title !== '(无主题)' && !/\uFFFD/.test(m.title)),
  'every unread title parsed without mojibake',
);
check(
  extras.status?.unreadMail === extras.unreadTotal ||
    extras.unreadTotal === null ||
    extras.status?.unreadMail === null,
  'displayed unread count agrees with the listing',
  `status=${extras.status?.unreadMail} list=${extras.unreadTotal}`,
);

if (selfMail) {
  check(
    extras.mails.some((m) => m.title.includes('BUPT-Notify 自测')),
    'the self-sent test mail was picked up as unread',
  );
}

/* ----------------------------- read-only extra ---------------------------- */
// The inbox itself (not just the unread filter) is a good real-world parser
// sample: subjects, senders, dates and the gb18030 decoding all get exercised.
console.log('\n=== 收件箱解析（只读抽样）===');
const box = await openMailbox(session, cfg, {});
const inbox = box.ok
  ? await session
      .fetchHtml(
        `${cfg.portal.mailBase}/cgi-bin/mail_list?sid=${box.sid}&folderid=1&flag=&page=0&topmails=0&resp_charset=UTF8`,
        {},
      )
      .catch(() => null)
  : null;
if (inbox && inbox.html.includes('name="mailid"')) {
  const parsed = parseMailList(inbox.html, { filteredToUnread: false });
  check(parsed.mails.length > 0, 'inbox rows parsed', `${parsed.mails.length} 封`);
  check(parsed.mails.every((m) => m.subject !== '(无主题)'), 'every row has a real subject');
  for (const m of parsed.mails.slice(0, 5)) {
    console.log(`      ${m.date || '?'}  ${m.sender} :: ${m.subject}`);
  }
} else {
  console.log('      (skipped: the mail list did not load in this run)');
}

/* -------------------------------- digest --------------------------------- */

console.log('\n=== 通知正文预览 ===');
const { subject, text } = composeMail([], cfg, { status, mails: extras.mails });
console.log(`subject: ${subject}`);
console.log(text.split('\n').slice(0, 24).join('\n'));

console.log('\n=== 面板会显示的状态行 ===');
console.log(`      ${describeStatus(status) || '(无)'}`);

console.log('\n=== 空值/异常输入的自检 ===');
check(parseWidgets('{"result":"false","errorinfo":"错误的访问来源！"}').ok === false, 'refusal detected');
check(parseWidgets('{"oddfare":"【-】","mail":"-"}').balance === null, '【-】 treated as unknown');

await session.close();
fs.rmSync(path.join(os.tmpdir(), 'bupt-extras-live-state.json'), { force: true });
console.log(`\n${failures ? `${failures} check(s) FAILED` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
