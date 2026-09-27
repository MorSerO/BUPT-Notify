/**
 * mailbox.test.mjs — unread mail titles from the Coremail webmail.
 *
 * Two parser bugs are pinned here because both were real:
 *   1. `name="mailid"` also matches the page's hidden form helpers, which
 *      reported phantom messages with empty subjects.
 *   2. The list page is gb18030 with the charset only in a `<meta>` tag, so
 *      decoding it as UTF-8 turned every subject into mojibake.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseMailList,
  extractSsoUrl,
  extractSid,
  cleanText,
  decodeEntities,
  looksLikeMailList,
  mailToItem,
  mailListUrl,
  INBOX_FOLDER_ID,
} from '../src/mailbox.js';
import { decodeBody, sniffCharset } from '../src/httpLogin.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const LIST = fs.readFileSync(path.join(FIXTURES, 'mail-list-unread.html'), 'utf8');
const SSO = fs.readFileSync(path.join(FIXTURES, 'mail-sso-redirect.html'), 'utf8');

/* ------------------------------ list parsing ------------------------------ */

test('parseMailList finds the real rows and ignores the hidden form helpers', () => {
  const r = parseMailList(LIST, { filteredToUnread: true });
  assert.equal(r.mails.length, 3, 'three real messages (the hidden inputs are not messages)');
  assert.deepEqual(
    r.mails.map((m) => m.id),
    ['ZC0001-FIXTUREAAA', 'ZC0002-FIXTUREBBB', 'ZC0003-FIXTURECCC'],
  );
});

test('parseMailList reads subject, sender, address and time', () => {
  const [first] = parseMailList(LIST, { filteredToUnread: true }).mails;
  assert.equal(first.subject, '关于国庆节期间图书馆开放时间的通知');
  assert.equal(first.sender, '图书馆');
  assert.equal(first.senderAddress, 'library@bupt.edu.cn');
  assert.equal(first.unread, true);
  assert.ok(first.preview.includes('开放时间调整'), 'preview snippet kept');
  assert.equal(first.dateText, '9月23日');
  // totime=1758600000000 is 2025-09-23 in UTC; the exact day depends on the
  // machine's zone, so assert the shape rather than a fixed date.
  assert.match(first.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(first.receivedAt, 'epoch ms converted');
});

test('parseMailList respects unread="false" when the list is NOT filtered', () => {
  const r = parseMailList(LIST, { filteredToUnread: false });
  assert.equal(r.mails.filter((m) => m.unread).length, 2, 'the read message is excluded');
  assert.equal(r.mails.find((m) => m.id === 'ZC0003-FIXTURECCC').unread, false);
});

test('a filtered request trusts the server, even without the unread attribute', () => {
  // Some Coremail renderings omit `unread` entirely on a filtered listing.
  const html = LIST.replace(/ unread="[^"]*"/g, '');
  const r = parseMailList(html, { filteredToUnread: true });
  assert.equal(r.mails.length, 3);
  assert.ok(r.mails.every((m) => m.unread), 'flag=new means the server already filtered');
});

test('parseMailList reads the header counts', () => {
  const r = parseMailList(LIST, { filteredToUnread: true });
  assert.equal(r.total, 2);
  assert.equal(r.unread, 2);
});

test('parseMailList returns an empty list rather than throwing on junk', () => {
  for (const junk of ['', '<html></html>', '<input name="mailid" type="hidden" value="">']) {
    const r = parseMailList(junk, { filteredToUnread: true });
    assert.deepEqual(r.mails, []);
  }
});

test('looksLikeMailList distinguishes the list from a login shell', () => {
  assert.equal(looksLikeMailList(LIST), true);
  assert.equal(looksLikeMailList('<html><body>请登录</body></html>'), false);
  assert.equal(looksLikeMailList(''), false);
});

/* ------------------------------- handshake -------------------------------- */

test('extractSsoUrl pulls the one-shot login URL out of the redirect script', () => {
  const url = extractSsoUrl(SSO);
  assert.ok(url, 'url found');
  assert.ok(url.startsWith('http://mail.bupt.edu.cn/cgi-bin/login?'), url);
  assert.ok(url.includes('fun=bizopenssologin'));
  assert.ok(url.includes('authkey='));
  // The scheme must be preserved: the portal hands out http and that is what works.
  assert.ok(!url.startsWith('https://'), 'scheme left as delivered');
});

test('extractSsoUrl returns null when there is no redirect', () => {
  assert.equal(extractSsoUrl('<html>nothing here</html>'), null);
  assert.equal(extractSsoUrl(''), null);
});

test('extractSid reads the sid, including its `,2` suffix', () => {
  assert.equal(extractSid('...frame_html?sid=AbC-123,2&sign_type='), 'AbC-123,2');
  assert.equal(extractSid('https://mail.bupt.edu.cn/cgi-bin/today?sid=XY,2'), 'XY,2');
  assert.equal(extractSid('no sid here'), null);
});

test('mailListUrl requests the server-side unread filter', () => {
  const url = mailListUrl('SID,2');
  assert.ok(url.includes('sid=SID,2'), 'sid inserted verbatim (its comma is part of the id)');
  assert.ok(url.includes('flag=new'), 'flag=new is the unread filter');
  assert.ok(url.includes(`folderid=${INBOX_FOLDER_ID}`));
  assert.ok(!url.includes('%2C'), 'no percent-encoded comma');
});

/* -------------------------------- mapping --------------------------------- */

test('mailToItem makes a mail look like a portal item for dedup/output', () => {
  const m = parseMailList(LIST, { filteredToUnread: true }).mails[0];
  const item = mailToItem(m);
  assert.equal(item.treeId, 'mail');
  assert.equal(item.newsId, 'ZC0001-FIXTUREAAA');
  assert.equal(item.key, 'mail:ZC0001-FIXTUREAAA');
  assert.equal(item.title, '关于国庆节期间图书馆开放时间的通知');
  assert.equal(item.source, '未读邮件');
  assert.equal(item.url, null, 'no link: Coremail read URLs expire with the session');
  assert.equal(item.sender, '图书馆');
});

/* ------------------------------- decoding --------------------------------- */

test('decodeBody decodes the mail system’s gb18030 by reading the meta charset', () => {
  // '收件箱 <span id="_ut_c">2</span> 封' in gb18030 — the mail system sends
  // exactly this shape with no charset in the HTTP header.
  const bytes = Buffer.from([
    0xca, 0xd5, 0xbc, 0xfe, 0xcf, 0xe4, 0x20, 0x3c, 0x73, 0x70, 0x61, 0x6e, 0x20, 0x69, 0x64,
    0x3d, 0x22, 0x5f, 0x75, 0x74, 0x5f, 0x63, 0x22, 0x3e, 0x32, 0x3c, 0x2f, 0x73, 0x70, 0x61,
    0x6e, 0x3e, 0x20, 0xb7, 0xe2,
  ]);
  const plain = decodeBody(bytes);
  assert.ok(plain.includes('收件箱'), `expected 收件箱, got ${plain.slice(0, 12)}`);
  assert.ok(plain.includes('2'));
  assert.ok(!plain.includes('\uFFFD'), 'no mojibake');
});

test('decodeBody prefers an explicit HTTP charset', () => {
  const utf8 = Buffer.from('收件箱', 'utf8');
  assert.equal(sniffCharset(utf8, 'text/html; charset=UTF-8'), 'utf-8');
  assert.equal(decodeBody(utf8, 'text/html; charset=UTF-8'), '收件箱');
  assert.equal(sniffCharset(utf8, 'text/html; charset=gb2312'), 'gb18030');
});

test('decodeBody falls back when a page claims utf-8 but is not', () => {
  const gbk = Buffer.from([0xca, 0xd5, 0xbc, 0xfe, 0xcf, 0xe4]); // 收件箱
  assert.equal(decodeBody(gbk, 'text/html; charset=UTF-8'), '收件箱');
});

/* ------------------------------- text utils ------------------------------- */

test('cleanText strips tags and decodes entities', () => {
  assert.equal(cleanText('<u role="link">A&amp;B</u>'), 'A&B');
  assert.equal(cleanText('  a\n\n  b  '), 'a b');
  assert.equal(decodeEntities('&nbsp;x&nbsp;'), ' x ');
  assert.equal(decodeEntities('&#x5317;&#20140;'), '北京');
});
