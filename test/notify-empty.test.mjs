/**
 * notify-empty.test.mjs — the "nothing new" notification.
 *
 * Requirement: when a check finds no new items, still send a mail saying so, so
 * the user can tell the tool is alive. It must be:
 *   - skippable (a checkbox in the panel),
 *   - throttled (nobody wants one every 2 hours forever),
 *   - and never able to fail a run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composeEmptyMail } from '../src/mailer.js';
import { App } from '../src/app.js';
import { Store } from '../src/store.js';

const NOW = new Date(2026, 8, 25, 21, 30, 0);

function cfg(over = {}) {
  return {
    baseUrl: 'http://my.bupt.edu.cn/',
    windowDays: 10,
    targets: [],
    output: {
      mode: 'email',
      localDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-empty-')),
      includeLink: true,
      notifyWhenEmpty: true,
      emptyNotifyIntervalHours: 0,
      ...(over.output || {}),
    },
    email: {
      enabled: true,
      // A closed local port: the send tests must fail fast WITHOUT touching the
      // network, so the suite stays offline and instant.
      host: '127.0.0.1',
      port: 9,
      secure: false,
      user: 'me@qq.com',
      pass: 'x'.repeat(16),
      from: '',
      to: ['you@example.com'],
      subjectPrefix: '[北邮通知]',
      ...(over.email || {}),
    },
    session: {
      profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-prof-')),
      channel: 'chrome',
      headless: true,
      loginTimeoutMs: 100,
      loginPollIntervalMs: 10,
    },
    network: { probeTimeoutMs: 100, waitTimeoutMs: 100, pollIntervalMs: 10, vpnPortalUrl: 'https://vpn.bupt.edu.cn/' },
    poll: { intervalMinutes: 120, jitterSeconds: 0 },
    log: { level: 'error', file: false, console: false },
  };
}

/* ------------------------------ composition ----------------------------- */

test('the "nothing new" mail says so, and is dated', () => {
  const { subject, text, html } = composeEmptyMail(cfg(), { now: NOW });
  assert.match(subject, /没有新内容/);
  assert.match(subject, /2026-09-25/);
  assert.match(text, /本次检查没有新内容/);
  assert.match(html, /没有新内容/);
});

test('it reports the window and the next check when known', () => {
  const next = new Date(2026, 8, 25, 23, 30, 0);
  const { text } = composeEmptyMail(cfg(), { now: NOW, nextRunAt: next, stats: { fetched: 40 } });
  assert.match(text, /最近 10 天/);
  assert.match(text, /已检查 40 条/);
  assert.match(text, /下次检查/);
});

test('it explains how to turn the notice off', () => {
  const { text } = composeEmptyMail(cfg(), { now: NOW });
  assert.match(text, /取消勾选|关闭/);
});

/* --------------------------- App gating logic --------------------------- */

function makeApp(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-emptyapp-'));
  return new App(cfg(over), {
    store: new Store({ file: path.join(dir, 'state.json') }),
    configPath: path.join(dir, 'config.json'),
  });
}

test('local-only mode never sends the empty notice', async () => {
  const app = makeApp({ output: { mode: 'local' } });
  const r = await app.maybeNotifyEmpty({});
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'not-configured');
});

test('the checkbox disables it', async () => {
  const app = makeApp({ output: { notifyWhenEmpty: false } });
  const r = await app.maybeNotifyEmpty({});
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'disabled');
});

test('it is skipped when email is not configured', async () => {
  const app = makeApp({ email: { user: '', pass: '', to: [] } });
  const r = await app.maybeNotifyEmpty({});
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'email-not-configured');
});

test('throttling blocks a second notice inside the interval', async () => {
  // 24h throttle, and pretend we just sent one.
  const app = makeApp({ output: { emptyNotifyIntervalHours: 24 } });
  app.store.setMeta('lastEmptyNotifyAt', new Date().toISOString());
  const r = await app.maybeNotifyEmpty({});
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'throttled');
  assert.ok(app.status.events.some((e) => /节流/.test(e.message)));
});

test('throttling allows a notice once the interval has passed', async () => {
  const app = makeApp({ output: { emptyNotifyIntervalHours: 24 } });
  app.store.setMeta('lastEmptyNotifyAt', new Date(Date.now() - 25 * 3600 * 1000).toISOString());
  // Sending will fail (no network), but it must get PAST the throttle.
  const r = await app.maybeNotifyEmpty({});
  assert.notEqual(r.reason, 'throttled');
});

test('a failed send never throws and is reported', async () => {
  const app = makeApp();
  const r = await app.maybeNotifyEmpty({}); // unreachable SMTP in tests
  assert.equal(r.sent, false);
  assert.ok(['send-failed', 'error'].includes(r.reason), `got ${r.reason}`);
});

test('a dry run never sends the empty notice, not even a courtesy one', async () => {
  const app = makeApp();
  const r = await app.maybeNotifyEmpty({ dryRun: true });
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'dry-run');
  // It must not claim a notice was sent, or arm the throttle for a real one.
  assert.equal(app.store.getMeta('lastEmptyNotifyAt', null), null);
  assert.ok(app.status.events.some((e) => /试运行/.test(e.message)));
});

/* ------------------------------ settings -------------------------------- */

test('settings accept the empty-notify toggles', () => {
  const app = makeApp();
  const r1 = app.applySettings({ notifyWhenEmpty: false });
  assert.equal(r1.ok, true);
  assert.equal(app.cfg.output.notifyWhenEmpty, false);

  const r2 = app.applySettings({ notifyWhenEmpty: true, emptyNotifyIntervalHours: 12 });
  assert.equal(r2.ok, true);
  assert.equal(app.cfg.output.emptyNotifyIntervalHours, 12);
});

test('settings reject an out-of-range empty-notify interval', () => {
  const app = makeApp();
  for (const bad of [-1, 169, 1000]) {
    const r = app.applySettings({ emptyNotifyIntervalHours: bad });
    assert.equal(r.ok, false, `should reject ${bad}`);
    assert.ok(r.errors.some((e) => e.includes('0–168')));
  }
  assert.equal(app.applySettings({ emptyNotifyIntervalHours: 0 }).ok, true);
  assert.equal(app.applySettings({ emptyNotifyIntervalHours: 168 }).ok, true);
});

/* ------------------------- minimised-window state ----------------------- */

test('minimising the window throttles the UI poll rate', () => {
  const app = makeApp();
  assert.equal(app.statusPollMs, 2000);
  app.setWindowHidden(true);
  assert.equal(app.statusPollMs, 30000, 'minimised -> poll every 30s');
  assert.equal(app.status.windowHidden, true);
  app.setWindowHidden(false);
  assert.equal(app.statusPollMs, 2000, 'restored -> back to 2s');
});

test('repeated visibility reports are idempotent', () => {
  const app = makeApp();
  app.setWindowHidden(true);
  app.setWindowHidden(true);
  assert.equal(app.statusPollMs, 30000);
});
