/**
 * scheduled-mode.test.mjs — the "short-lived scheduled run" model.
 *
 * The user's requirement changed from "keep a process running and poll inside
 * it" to:
 *
 *   - Windows Task Scheduler runs the scrape every few hours
 *   - it works even with the app closed (nothing needs to stay resident)
 *   - it can be switched off entirely (the toggle)
 *   - a background run must not disturb daily use: no dialogs, no browser window
 *   - an open panel must still SHOW the results of those separate runs
 *
 * These tests pin down each of those.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { App } from '../src/app.js';
import { Store } from '../src/store.js';
import { loadConfig, DEFAULT_CONFIG, toPersistedConfig } from '../src/config.js';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-sched-'));
}

function makeCfg(over = {}) {
  return {
    baseUrl: 'http://my.bupt.edu.cn/',
    windowDays: 10,
    targets: [],
    output: { mode: 'local', localDir: tmpDir(), includeLink: true, notifyWhenEmpty: true },
    email: { enabled: false, host: '127.0.0.1', port: 9, user: '', pass: '', to: [] },
    session: {
      profileDir: tmpDir(),
      channel: 'chrome',
      headless: true,
      loginTimeoutMs: 100,
      loginPollIntervalMs: 10,
    },
    network: { probeTimeoutMs: 100, waitTimeoutMs: 100, pollIntervalMs: 10, vpnPortalUrl: 'https://vpn.bupt.edu.cn/' },
    poll: { mode: 'task', intervalMinutes: 180, jitterSeconds: 0 },
    notify: { desktop: false, manualLoginWindow: false },
    log: { level: 'error', file: false, console: false },
    ...over,
  };
}

function makeApp(over = {}, opts = {}) {
  const dir = tmpDir();
  return new App(makeCfg(over), {
    store: new Store({ file: path.join(dir, 'state.json') }),
    configPath: path.join(dir, 'config.json'),
    ...opts,
  });
}

/* ------------------------------ default mode ---------------------------- */

test('the default schedule is task-based, not resident', () => {
  assert.equal(DEFAULT_CONFIG.poll.mode, 'task');
});

test('notifications are off by default (a background run must not interrupt)', () => {
  assert.equal(DEFAULT_CONFIG.notify.desktop, false);
  assert.equal(DEFAULT_CONFIG.notify.manualLoginWindow, false);
});

test('poll mode and notify flags survive a config save/load round trip', () => {
  const cfg = loadConfig({ quiet: true });
  cfg.poll.mode = 'resident';
  cfg.notify.desktop = true;
  const persisted = toPersistedConfig(cfg);
  assert.equal(persisted.poll.mode, 'resident');
  assert.equal(persisted.notify.desktop, true);
});

/* -------------------------------- quiet mode ---------------------------- */

test('an App is quiet unless desktop notifications are explicitly on', () => {
  assert.equal(makeApp({ notify: { desktop: false } }).quiet, true);
  assert.equal(makeApp({ notify: { desktop: true } }).quiet, false);
});

test('--quiet forces quiet mode even with notifications enabled', () => {
  const app = makeApp({ notify: { desktop: true, manualLoginWindow: true } }, { quiet: true });
  assert.equal(app.quiet, true);
});

test('status exposes the mode so the panel can explain itself', () => {
  const app = makeApp();
  assert.equal(app.status.pollMode, 'task');
  assert.equal(app.status.quiet, true);
});

/* ------------------- results from OTHER processes are visible ----------- */

test('an open panel picks up runs performed by another process', () => {
  const file = path.join(tmpDir(), 'state.json');
  const panelStore = new Store({ file });
  const app = new App(makeCfg(), { store: panelStore, configPath: path.join(tmpDir(), 'config.json') });

  // The panel has not run anything yet.
  assert.equal(app.status.lastRun, null);

  // Simulate the SCHEDULED RUN: a different process writing the same file.
  const otherProcess = new Store({ file });
  otherProcess.recordRun({ at: '2026-09-26T04:58:32.660Z', ok: true, stage: 'done', newItems: 3 });
  otherProcess.markForwarded(
    { treeId: '1154', newsId: '9', title: '来自定时任务', url: 'http://x', source: '校内通知', date: '2026-09-26' },
    new Date(),
  );
  otherProcess.save();

  const st = app.status;
  assert.ok(st.lastRun, 'the panel must see the scheduled run');
  assert.equal(st.lastRun.newItems, 3);
  assert.equal(st.storeSize, 1, 'and the forwarded item');
  assert.equal(st.recentItems[0].title, '来自定时任务');
});

test('reloadIfChanged is a no-op when the file has not moved', () => {
  const file = path.join(tmpDir(), 'state.json');
  const store = new Store({ file });
  store.recordRun({ at: 'x', ok: true });
  store.save();
  assert.equal(store.reloadIfChanged(), false, 'no change -> no reload');
});

test('reloadIfChanged is harmless when the file does not exist', () => {
  const store = new Store({ file: path.join(tmpDir(), 'missing.json') });
  assert.equal(store.reloadIfChanged(), false);
});

/* -------------------------- switching it off ---------------------------- */

test('the schedule is opt-in: an App never arms a scheduler by itself', () => {
  const app = makeApp();
  // Constructing/running the panel must not start any internal polling in task
  // mode — otherwise turning the task off would not actually stop scraping.
  assert.equal(app.schedulerActive, false);
  assert.equal(app.nextRunAt, null);
});

test('a stopped app stays stopped across status reads', async () => {
  const app = makeApp();
  await app.stop();
  for (let i = 0; i < 3; i += 1) assert.equal(app.status.stopped, true);
  const r = await app.runOnce({});
  assert.equal(r.stopped, true, 'manual runs are refused while stopped');
});

/* --------------------------- interval plumbing -------------------------- */

test('the interval accepts the values the panel offers', () => {
  const app = makeApp();
  for (const hours of [1, 2, 3, 4, 6, 8, 12, 24]) {
    const r = app.applySettings({ intervalMinutes: hours * 60 });
    assert.equal(r.ok, true, `${hours}h should be accepted`);
    assert.equal(app.cfg.poll.intervalMinutes, hours * 60);
  }
});

test('the interval still rejects out-of-range values', () => {
  const app = makeApp();
  assert.equal(app.applySettings({ intervalMinutes: 30 }).ok, false);
  assert.equal(app.applySettings({ intervalMinutes: 3000 }).ok, false);
});
