/**
 * portal.test.mjs — the 待办中心 widgets (校园卡余额 / 未读邮件数).
 *
 * The interesting cases are all about NOT lying: the portal uses `【-】` for
 * "no data", `Number('')` is 0, and the endpoint answers with a refusal object
 * instead of an HTTP error when the Referer is wrong.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseWidgets,
  parseWidgetValue,
  describeStatus,
  formatMoney,
  homepageUrl,
  widgetsUrl,
  HOMEPAGE_PATH,
  WIDGETS_PATH,
} from '../src/portal.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = fs.readFileSync(path.join(FIXTURES, 'portal-widgets.json'), 'utf8');

const BASE = 'http://my.bupt.edu.cn/';

test('parseWidgetValue treats the portal’s empty markers as unknown, not as 0', () => {
  // 「【-】」 is what the page renders before the AJAX call fills it in.
  assert.equal(parseWidgetValue('【-】'), null);
  assert.equal(parseWidgetValue('-'), null);
  assert.equal(parseWidgetValue('--'), null);
  assert.equal(parseWidgetValue(''), null);
  assert.equal(parseWidgetValue(null), null);
  assert.equal(parseWidgetValue(undefined), null);
  assert.equal(parseWidgetValue('abc'), null);
  // …while a real zero must survive.
  assert.equal(parseWidgetValue('0'), 0);
  assert.equal(parseWidgetValue(0), 0);
});

test('parseWidgetValue accepts the real value shapes', () => {
  assert.equal(parseWidgetValue('216.010'), 216.01);
  assert.equal(parseWidgetValue('1,234.5'), 1234.5);
  assert.equal(parseWidgetValue('-12.5'), -12.5);
});

test('parseWidgets reads every field of the live payload shape', () => {
  const s = parseWidgets(fixture);
  assert.equal(s.ok, true);
  assert.equal(s.balance, 123.45); // oddfare = 校园卡余额
  assert.equal(s.unreadMail, 3); // mail    = 未读邮件数
  assert.equal(s.borrowed, 2); // yjcs    = 借阅册数
  assert.equal(s.owed, 0); // qkje    = 欠款
  assert.equal(s.todo, 1); // cgtodo  = 待办
  assert.equal(s.account, 'example');
});

test('parseWidgets accepts an already-parsed object', () => {
  const s = parseWidgets({ oddfare: '8.00', mail: '0' });
  assert.equal(s.ok, true);
  assert.equal(s.balance, 8);
  assert.equal(s.unreadMail, 0);
});

test('parseWidgets survives the JSON being wrapped in whitespace/HTML', () => {
  const s = parseWidgets(`\n\n  {"oddfare":"1.00","mail":"2"}\n\n`);
  assert.equal(s.ok, true);
  assert.equal(s.balance, 1);
});

test('parseWidgets reports the endpoint refusal instead of faking data', () => {
  // Exactly what the endpoint answers without a homepage Referer.
  const s = parseWidgets('{"result":"false","errorinfo":"错误的访问来源！"}');
  assert.equal(s.ok, false);
  assert.match(s.error, /访问来源/);
  assert.equal(s.balance, null);
  assert.equal(s.unreadMail, null);
});

test('parseWidgets reports empty and non-JSON responses', () => {
  assert.equal(parseWidgets('').ok, false);
  assert.equal(parseWidgets('<html>login</html>').ok, false);
  assert.equal(parseWidgets('null').ok, false);
});

test('formatMoney and describeStatus render what the user sees', () => {
  assert.equal(formatMoney(216.01), '¥216.01');
  assert.equal(formatMoney(216.5), '¥216.50', 'always two decimals');
  assert.equal(formatMoney(0), '¥0.00');
  assert.equal(formatMoney(null), null);

  assert.equal(
    describeStatus({ ok: true, balance: 216.01, unreadMail: 3 }),
    '校园卡余额 ¥216.01 · 未读邮件 3 封',
  );
  // A failed widget read must not produce a line at all.
  assert.equal(describeStatus({ ok: false, balance: null, unreadMail: null }), null);
  assert.equal(describeStatus(null), null);
  // Partial data still yields a usable line.
  assert.equal(describeStatus({ ok: true, balance: null, unreadMail: 0 }), '未读邮件 0 封');
});

test('the widget URL is built from the configured portal base', () => {
  assert.equal(widgetsUrl(BASE), `${BASE}${WIDGETS_PATH}`);
  assert.equal(homepageUrl(BASE), `${BASE}${HOMEPAGE_PATH}`);
  assert.match(widgetsUrl(BASE), /getwxtsA\.jsp$/);
});
