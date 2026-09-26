/**
 * output.test.mjs — the concise output format (title + capture time) and the
 * local-digest writer, plus mail composition.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeLocalDigest, formatLocalLine, describeOutput } from '../src/output.js';
import { composeMail } from '../src/mailer.js';

const NOW = new Date(2026, 8, 25, 21, 30, 0);

function cfg(over = {}) {
  return {
    windowDays: 10,
    baseUrl: 'http://my.bupt.edu.cn/',
    output: {
      mode: 'local',
      localDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-out-')),
      includeLink: true,
      includePublishDate: false,
      includeSource: true,
      ...(over.output || {}),
    },
    email: {
      enabled: true,
      host: 'smtp.qq.com',
      port: 465,
      secure: true,
      user: 'me@qq.com',
      pass: 'x'.repeat(16),
      from: '',
      to: ['you@example.com'],
      subjectPrefix: '[北邮通知]',
      ...(over.email || {}),
    },
    ...over,
  };
}

const items = [
  {
    treeId: '1154',
    newsId: '142501',
    title: '关于2026年国庆节放假安排的通知',
    url: 'http://my.bupt.edu.cn/content.jsp?wbtreeid=1154&wbnewsid=142501',
    date: '2026-09-25',
    source: '校内通知',
  },
  {
    treeId: '2001',
    newsId: '142490',
    title: '关于印发《北京邮电大学科研经费管理办法》的通知',
    url: 'http://my.bupt.edu.cn/content.jsp?wbtreeid=2001&wbnewsid=142490',
    date: '2026-09-23',
    source: '校内文件',
  },
];

test('formatLocalLine contains the title and the capture time', () => {
  const line = formatLocalLine(items[0], cfg(), '2026/09/25 21:30');
  assert.ok(line.includes('关于2026年国庆节放假安排的通知'), 'title present');
  assert.ok(line.includes('抓取 2026/09/25 21:30'), 'capture time present');
  assert.ok(line.includes('[校内通知]'), 'source tag present');
});

test('formatLocalLine omits the publish date by default (concise)', () => {
  const line = formatLocalLine(items[0], cfg(), '2026/09/25 21:30');
  assert.ok(!line.includes('发布'), 'publish date not shown unless enabled');
});

test('formatLocalLine can include the publish date when asked', () => {
  const c = cfg({ output: { includePublishDate: true } });
  const line = formatLocalLine(items[0], c, '2026/09/25 21:30');
  assert.ok(line.includes('发布 2026-09-25'));
});

test('formatLocalLine drops the link when includeLink is false', () => {
  const c = cfg({ output: { includeLink: false } });
  const line = formatLocalLine(items[0], c, '2026/09/25 21:30');
  assert.ok(!line.includes('http://'), 'no link');
});

test('writeLocalDigest creates one dated file and appends batches', () => {
  const c = cfg();
  const r1 = writeLocalDigest(items, c, { now: NOW });
  assert.equal(r1.ok, true);
  assert.ok(fs.existsSync(r1.file), 'digest file created');
  assert.ok(path.basename(r1.file).startsWith('北邮通知-2026-09-25'), 'one file per day');

  const r2 = writeLocalDigest([items[0]], c, { now: NOW });
  assert.equal(r2.file, r1.file, 'same day reuses the file');

  const text = fs.readFileSync(r1.file, 'utf8');
  assert.equal((text.match(/## 抓取于/g) || []).length, 2, 'two appended batches');
  assert.ok(text.includes('关于2026年国庆节放假安排的通知'));
  assert.ok(text.includes('关于印发《北京邮电大学科研经费管理办法》的通知'));
});

test('writeLocalDigest is a no-op for an empty batch', () => {
  const c = cfg();
  const r = writeLocalDigest([], c, { now: NOW });
  assert.equal(r.appended, 0);
  assert.equal(r.file, null);
});

test('composeMail subject counts items and names the columns', () => {
  const { subject } = composeMail(items, cfg(), { now: NOW });
  assert.ok(subject.startsWith('[北邮通知]'));
  assert.ok(subject.includes('2026-09-25'));
  assert.ok(subject.includes('新增 2 条'));
  assert.ok(subject.includes('校内通知 1 条'));
  assert.ok(subject.includes('校内文件 1 条'));
});

test('composeMail body is concise: titles + capture time, no bodies/summaries', () => {
  const enriched = items.map((i) => ({ ...i, bodyText: '这是一大段正文，不应该出现在邮件里。' }));
  const { text, html } = composeMail(enriched, cfg(), { now: NOW });
  assert.ok(text.includes('关于2026年国庆节放假安排的通知'));
  assert.ok(text.includes('抓取'), 'capture time labelled');
  assert.ok(!text.includes('这是一大段正文'), 'article body must NOT be included');
  assert.ok(!html.includes('这是一大段正文'), 'article body must NOT be in html');
  // The link stays, so the recipient can open the original.
  assert.ok(text.includes('wbnewsid=142501'));
});
