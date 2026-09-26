/**
 * cancel.test.mjs — the 停止抓取 behaviour.
 *
 * The requirement is a stop button that *completely* stops scraping:
 *   - it halts automatic polling
 *   - it aborts the run already in flight (including long waits)
 *   - it must never deliver or mark anything as forwarded
 *   - it must be resumable
 *
 * A run can be blocked for up to 15 minutes in the network wait and 10 minutes
 * in the manual-login wait, so "check a flag at the top of the run" is not
 * enough — these tests specifically cover interruption mid-wait.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CancellationToken, CancelledError, cancellableSleep, isCancellation } from '../src/cancel.js';
import { waitForReachable } from '../src/net.js';
import { collectAll } from '../src/collector.js';
import { App } from '../src/app.js';
import { Store } from '../src/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const listHtml = fs.readFileSync(path.join(here, 'fixtures/notice-list.html'), 'utf8');
const NOW = new Date(2026, 8, 25);

/* ------------------------------ the token ------------------------------- */

test('a fresh token is not cancelled', () => {
  const t = new CancellationToken();
  assert.equal(t.isCancelled, false);
  assert.doesNotThrow(() => t.throwIfCancelled('测试'));
});

test('cancel() is idempotent and reports only the first call', () => {
  const t = new CancellationToken();
  assert.equal(t.cancel('第一次'), true);
  assert.equal(t.cancel('第二次'), false);
  assert.equal(t.reason, '第一次');
  assert.equal(t.isCancelled, true);
});

test('throwIfCancelled throws a CancelledError naming the step', () => {
  const t = new CancellationToken();
  t.cancel('用户停止');
  assert.throws(() => t.throwIfCancelled('抓取'), (err) => {
    assert.ok(err instanceof CancelledError);
    assert.match(err.message, /抓取/);
    assert.match(err.message, /用户停止/);
    return true;
  });
});

test('onCancel hooks fire immediately when the token is already cancelled', () => {
  const t = new CancellationToken();
  t.cancel('早于注册');
  let called = 0;
  t.onCancel(() => { called += 1; });
  assert.equal(called, 1);
});

test('onCancel hooks fire once and can be unsubscribed', () => {
  const t = new CancellationToken();
  let called = 0;
  const off = t.onCancel(() => { called += 1; });
  off();
  t.cancel();
  assert.equal(called, 0);

  const t2 = new CancellationToken();
  let n = 0;
  t2.onCancel(() => { n += 1; });
  t2.cancel();
  t2.cancel();
  assert.equal(n, 1, 'hook must not fire twice');
});

test('a throwing cleanup hook does not prevent the others', () => {
  const t = new CancellationToken();
  let reached = false;
  t.onCancel(() => { throw new Error('boom'); });
  t.onCancel(() => { reached = true; });
  t.cancel();
  assert.equal(reached, true);
});

/* ------------------------- cancellable sleep ---------------------------- */

test('cancellableSleep returns false immediately for a cancelled token', async () => {
  const t = new CancellationToken();
  t.cancel();
  const started = Date.now();
  assert.equal(await cancellableSleep(5000, t), false);
  assert.ok(Date.now() - started < 100, 'must not wait');
});

test('cancellableSleep wakes up early when cancelled mid-sleep', async () => {
  const t = new CancellationToken();
  const started = Date.now();
  setTimeout(() => t.cancel('中途停止'), 60);
  assert.equal(await cancellableSleep(10000, t), false);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `should abort promptly, took ${elapsed}ms`);
});

test('cancellableSleep sleeps fully when never cancelled', async () => {
  const t = new CancellationToken();
  assert.equal(await cancellableSleep(120, t), true);
});

/* ------------------- interrupting the long network wait ----------------- */

test('waitForReachable aborts promptly instead of waiting out its timeout', async () => {
  const t = new CancellationToken();
  // 10.255.255.1 is a black hole: the probe will hang until it times out.
  const promise = waitForReachable('http://10.255.255.1/', {
    timeoutMs: 10 * 60 * 1000,
    pollIntervalMs: 5000,
    token: t,
  });
  setTimeout(() => t.cancel('用户停止'), 80);
  const started = Date.now();
  const r = await promise;
  const elapsed = Date.now() - started;
  assert.equal(r.cancelled, true);
  assert.equal(r.ok, false);
  assert.ok(elapsed < 15000, `should abort quickly, took ${elapsed}ms`);
});

/* ------------------ interrupting the collector mid-loop ----------------- */

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-cancel-'));
  return new Store({ file: path.join(dir, 'state.json') });
}

function makeCfg() {
  return {
    baseUrl: 'http://my.bupt.edu.cn/',
    windowDays: 10,
    maxPages: 1,
    targets: [
      { key: 'notice', name: '校内通知', treeId: '1154', url: 'http://my.bupt.edu.cn/n' },
      { key: 'document', name: '校内文件', treeId: '2001', url: 'http://my.bupt.edu.cn/d' },
    ],
    output: {
      mode: 'local',
      localDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-out-')),
      includeLink: true,
    },
    email: { enabled: false, host: 'smtp.qq.com', port: 465, secure: true, user: '', pass: '', to: [] },
    // Needed by PortalSession / ensureNetwork; nothing here actually launches.
    session: {
      profileDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-prof-')),
      channel: 'chrome',
      headless: true,
      loginTimeoutMs: 1000,
      loginPollIntervalMs: 100,
    },
    network: {
      probeTimeoutMs: 5000,
      vpnPortalUrl: 'https://vpn.bupt.edu.cn/',
      waitTimeoutMs: 5000,
      pollIntervalMs: 100,
    },
    poll: { intervalMinutes: 120, jitterSeconds: 0 },
    log: { level: 'error', file: false, console: false },
  };
}

test('collectAll stops before fetching when the token is already cancelled', async () => {
  const cfg = makeCfg();
  const t = new CancellationToken();
  t.cancel('用户停止');
  let fetches = 0;
  const session = { async fetchHtml() { fetches += 1; return { html: listHtml, status: 200, finalUrl: 'x' }; } };

  await assert.rejects(() => collectAll(session, cfg, tmpStore(), { now: NOW, token: t }), CancelledError);
  assert.equal(fetches, 0, 'no page may be fetched after a stop');
});

test('collectAll aborts between targets when cancelled mid-run', async () => {
  const cfg = makeCfg();
  const t = new CancellationToken();
  let fetches = 0;
  const session = {
    async fetchHtml(url) {
      fetches += 1;
      // Cancel after the first column is fetched.
      t.cancel('用户停止');
      return { html: listHtml, status: 200, finalUrl: url };
    },
  };

  await assert.rejects(() => collectAll(session, cfg, tmpStore(), { now: NOW, token: t }), CancelledError);
  assert.equal(fetches, 1, 'must not start the second column');
});

test('a cancelled run reports cancellation instead of a scary error', () => {
  const t = new CancellationToken();
  t.cancel('用户停止');
  const err = new Error('Target page, context or browser has been closed');
  assert.equal(isCancellation(err, t), true);
  assert.equal(isCancellation(new CancelledError('x'), t), true);
  // An unrelated failure must NOT be swallowed as a cancellation.
  assert.equal(isCancellation(new Error('ETIMEDOUT'), t), false);
  assert.equal(isCancellation(err, null), false);
});

/* ------------------------- App: stop / resume --------------------------- */

function makeApp() {
  const cfg = makeCfg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-app-'));
  return new App(cfg, { store: new Store({ file: path.join(dir, 'state.json') }), configPath: path.join(dir, 'config.json') });
}

test('App.stop() halts the scheduler and marks the app stopped', async () => {
  const app = makeApp();
  app.startScheduler({ runImmediately: false });
  assert.equal(app.schedulerActive, true);
  assert.ok(app.nextRunAt, 'a next run should be armed');

  const r = await app.stop();
  assert.equal(r.ok, true);
  assert.equal(r.stopped, true);
  assert.equal(app.stopped, true);
  assert.equal(app.schedulerActive, false, 'scheduler must be halted');
  assert.equal(app.nextRunAt, null, 'no next run may remain armed');
  assert.equal(app.status.stopped, true);
});

test('a stopped App refuses to start a run', async () => {
  const app = makeApp();
  await app.stop();
  const r = await app.runOnce({ reason: '手动触发' });
  assert.equal(r.ok, false);
  assert.equal(r.stopped, true);
  assert.match(r.error, /已停止|恢复/);
  assert.equal(app.busy, false, 'must not enter the busy state');
});

test('App.stop() cancels the in-flight run and reports it', async () => {
  const app = makeApp();
  // Simulate a run that is blocked mid-flight.
  const inflight = new CancellationToken();
  app.currentToken = inflight;
  app.busy = true;

  const r = await app.stop();
  assert.equal(r.wasBusy, true);
  assert.equal(r.cancelledRun, true);
  assert.equal(inflight.isCancelled, true);
  assert.equal(inflight.reason, '用户按下停止');

  app.busy = false;
  // sanity: the token really is armed for the pipeline checkpoints
  assert.throws(() => inflight.throwIfCancelled('抓取'), CancelledError);
});

test('App.resume() re-arms the scheduler and allows runs again', async () => {
  const app = makeApp();
  await app.stop();
  const r = app.resume();
  assert.equal(r.ok, true);
  assert.equal(r.stopped, false);
  assert.equal(app.stopped, false);
  assert.equal(app.schedulerActive, true, 'scheduler must be running again');
  app.stopScheduler();
});

test('resume() on a running app is a no-op', () => {
  const app = makeApp();
  const r = app.resume();
  assert.equal(r.ok, true);
  assert.match(r.message, /本来就在运行/);
});

test('startScheduler does nothing while stopped', () => {
  const app = makeApp();
  app.stopped = true;
  app.startScheduler({ runImmediately: false });
  assert.equal(app.schedulerActive, false);
  assert.equal(app.nextRunAt, null);
});

test('changing settings does not fire an immediate run', async () => {
  const app = makeApp();
  app.startScheduler({ runImmediately: false });
  const before = app.busy;
  const r = app.applySettings({ intervalMinutes: 480 });
  assert.equal(r.ok, true);
  assert.equal(app.busy, before, 'a settings change must not start a scrape');
  assert.equal(app.cfg.poll.intervalMinutes, 480);
  assert.equal(app.schedulerActive, true, 'scheduler stays armed');
  app.stopScheduler();
});

test('App.stop() aborts a run that is blocked, and records it as cancelled', async () => {
  const app = makeApp();
  // A black-hole address makes the very first network probe hang, which is the
  // realistic "stuck run" the stop button has to get us out of.
  app.cfg.baseUrl = 'http://10.255.255.1/';
  app.cfg.network.probeTimeoutMs = 60000; // deliberately long
  app.cfg.network.waitTimeoutMs = 60000;
  app.store = new Store({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-st-')), 's.json') });

  const running = app.runOnce({ reason: '测试停止' });
  // Give the run a moment to enter the probe, then stop it.
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(app.busy, true, 'run should be in flight');

  const started = Date.now();
  await app.stop();
  const summary = await running;
  const elapsed = Date.now() - started;

  assert.equal(summary.ok, false);
  assert.equal(summary.cancelled, true, 'outcome must be "cancelled", not a generic failure');
  assert.match(summary.error, /已停止/);
  assert.ok(elapsed < 5000, `stop must abort quickly, took ${elapsed}ms`);
  assert.equal(app.busy, false);
  assert.equal(app.store.lastRun.cancelled, true, 'the cancelled run is recorded as cancelled');
});

test('a stopped run never marks anything as forwarded', async () => {
  const app = makeApp();
  app.cfg.baseUrl = 'http://10.255.255.1/';
  app.cfg.network.probeTimeoutMs = 60000;
  app.cfg.network.waitTimeoutMs = 60000;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-st2-'));
  app.store = new Store({ file: path.join(dir, 's.json') });

  const running = app.runOnce({ reason: '测试停止' });
  await new Promise((r) => setTimeout(r, 150));
  await app.stop();
  await running;

  assert.equal(app.store.size, 0, 'no item may be recorded by a stopped run');
  assert.equal(app.recentItems().length, 0, 'nothing may appear as forwarded');
});

test('stop() during the network wait aborts without waiting out the timeout', async () => {
  const app = makeApp();
  app.cfg.baseUrl = 'http://10.255.255.1/';
  app.cfg.network.probeTimeoutMs = 60000;
  app.cfg.network.waitTimeoutMs = 60000;

  const running = app.runOnce({ reason: '测试停止' });
  await new Promise((r) => setTimeout(r, 150));
  const started = Date.now();
  await app.stop();
  await running;
  assert.ok(Date.now() - started < 5000, 'must not sit in the 60s timeout');
});
