/**
 * server.test.mjs — the control-panel API.
 *
 * Exercises the real HTTP server the GUI talks to: token auth, status,
 * settings validation (including the 1h–24h interval bounds), credential
 * storage, and the static-asset/path-traversal guards.
 *
 * Uses temp paths for both the store and config.json so it can never clobber
 * the user's real configuration.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Must be set before secrets.js / autostart.js are imported.
const credDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-cred-'));
process.env.BUPT_NOTIFY_CRED_PATH = path.join(credDir, 'credentials.json');
// Never let the suite register or remove real Windows scheduled tasks.
process.env.BUPT_NOTIFY_NO_SYSTEM_CHANGES = '1';

const { createUiServer } = await import('../src/server.js');
const { App } = await import('../src/app.js');
const { Store } = await import('../src/store.js');
const { loadConfig, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES } = await import('../src/config.js');
const { initLogger } = await import('../src/logger.js');

initLogger({ level: 'error', file: false, console: false });

let server;
let baseUrl;
let token;
let workDir;
let cfgPath;

before(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-ui-'));

  const cfg = loadConfig({ quiet: true });
  cfg.output.mode = 'local';
  cfg.output.localDir = path.join(workDir, 'output');
  cfg.email.enabled = false;
  cfg.email.user = '';
  cfg.email.pass = '';
  cfg.email.to = [];

  // Point the network probe at a closed port so any run the tests accidentally
  // start fails immediately instead of touching the real portal or launching a
  // browser.
  cfg.baseUrl = 'http://127.0.0.1:9/';
  cfg.network.probeTimeoutMs = 800;
  cfg.network.waitTimeoutMs = 1000;
  cfg.network.pollIntervalMs = 100;

  cfgPath = path.join(workDir, 'config.json');
  const store = new Store({ file: path.join(workDir, 'state.json') });
  const app = new App(cfg, { store, configPath: cfgPath });

  const started = await createUiServer({ app, port: 0 });
  server = started.server;
  // Handy for tests that need to drive app state directly.
  server.__app = app;
  baseUrl = started.url;
  token = started.token;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

/** baseUrl already ends with "/", so join without adding another slash. */
const u = (p) => `${baseUrl}${String(p).replace(/^\/+/, '')}`;

const authed = (p, opts = {}) =>
  fetch(u(p), {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-BUPT-Token': token, ...(opts.headers || {}) },
  });

const post = (p, body) => authed(p, { method: 'POST', body: JSON.stringify(body ?? {}) });

test('GET / serves the GUI with a token injected', async () => {
  const res = await fetch(baseUrl);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.ok(html.includes('BUPT-Notify'));
  assert.ok(!html.includes('__BUPT_TOKEN__'), 'placeholder must be replaced');
  assert.ok(html.includes(token), 'token injected into the page');
  assert.ok(html.includes('立即抓取'), 'run button present');
  assert.ok(html.includes('定时自动抓取'), 'the schedule card is present');
  assert.ok(html.includes('taskInterval'), 'the interval selector is present');
});

test('API rejects requests without the token', async () => {
  const res = await fetch(u('/api/status'));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test('API rejects a wrong token', async () => {
  const res = await fetch(u('/api/status'), { headers: { 'X-BUPT-Token': 'nope' } });
  assert.equal(res.status, 403);
});

test('GET /api/status returns the live status shape', async () => {
  const res = await authed('/api/status');
  assert.equal(res.status, 200);
  const { status, limits } = await res.json();
  assert.equal(status.busy, false);
  assert.equal(status.outputMode, 'local');
  assert.equal(status.hasCredentials, false);
  assert.ok(Array.isArray(status.events));
  assert.ok(Array.isArray(status.recentItems));
  assert.equal(typeof status.storeSize, 'number');
  assert.equal(limits.minInterval, MIN_INTERVAL_MINUTES);
  assert.equal(limits.maxInterval, MAX_INTERVAL_MINUTES);
});

test('interval bounds are exactly 1h–24h', () => {
  assert.equal(MIN_INTERVAL_MINUTES, 60);
  assert.equal(MAX_INTERVAL_MINUTES, 1440);
});

test('every interval the panel offers is accepted', async () => {
  // The schedule selector offers these; the API must not reject any of them.
  for (const hours of [1, 2, 3, 4, 6, 8, 12, 24]) {
    const res = await post('/api/settings', { intervalMinutes: hours * 60 });
    assert.equal(res.status, 200, `${hours}h should be accepted`);
  }
});

test('the interval the scheduled task is registered with matches the config', async () => {
  await post('/api/settings', { intervalMinutes: 480 });
  const st = (await (await authed('/api/status')).json()).status;
  assert.equal(st.intervalMinutes, 480);
  const auto = await (await authed('/api/autostart')).json();
  assert.equal(auto.defaultIntervalHours, 8, 'the task interval follows the config');
});

test('POST /api/settings accepts a valid interval and persists it', async () => {
  const res = await post('/api/settings', { intervalMinutes: 360 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.applied.some((a) => a.includes('360')));

  assert.ok(fs.existsSync(cfgPath), 'config.json written');
  const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(saved.poll.intervalMinutes, 360);

  const after = await (await authed('/api/status')).json();
  assert.equal(after.status.intervalMinutes, 360);
});

test('POST /api/settings rejects an interval below 1h', async () => {
  const res = await post('/api/settings', { intervalMinutes: 30 });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(body.errors.some((e) => e.includes('60') || e.includes('1440')));
});

test('POST /api/settings rejects an interval above 24h', async () => {
  const res = await post('/api/settings', { intervalMinutes: 3000 });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);
});

test('POST /api/settings accepts the exact boundaries', async () => {
  for (const m of [MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES]) {
    const res = await post('/api/settings', { intervalMinutes: m });
    assert.equal(res.status, 200, `interval ${m} must be accepted`);
  }
});

test('POST /api/settings rejects a malformed recipient email', async () => {
  const res = await post('/api/settings', { emailTo: 'not-an-email' });
  assert.equal(res.status, 400);
});

test('POST /api/settings validates windowDays', async () => {
  assert.equal((await post('/api/settings', { windowDays: 0 })).status, 400);
  assert.equal((await post('/api/settings', { windowDays: 10 })).status, 200);
});

test('credentials can be saved, reported and cleared', async () => {
  const save = await post('/api/credentials', { username: '2021000000', password: 'secret-pw' });
  assert.equal(save.status, 200);
  const saved = await save.json();
  assert.equal(saved.ok, true);

  const st = await (await authed('/api/status')).json();
  assert.equal(st.status.hasCredentials, true);
  assert.equal(st.status.credentialUsername, '2021000000');

  // The password must never be echoed back by the API.
  assert.ok(!JSON.stringify(st).includes('secret-pw'), 'password must not leak in status');

  const del = await authed('/api/credentials', { method: 'DELETE' });
  assert.equal(del.status, 200);
  const st2 = await (await authed('/api/status')).json();
  assert.equal(st2.status.hasCredentials, false);
});

test('credentials endpoint rejects an empty username or password', async () => {
  assert.equal((await post('/api/credentials', { username: '', password: 'x' })).status, 400);
  assert.equal((await post('/api/credentials', { username: 'u', password: '' })).status, 400);
});

test('the stored credential file never contains the plaintext password', async () => {
  await post('/api/credentials', { username: '2021000000', password: 'PLAINTEXT-MARKER-42' });
  const raw = fs.readFileSync(process.env.BUPT_NOTIFY_CRED_PATH, 'utf8');
  assert.ok(!raw.includes('PLAINTEXT-MARKER-42'), 'password must be encrypted at rest');
  const parsed = JSON.parse(raw);
  assert.ok(['dpapi', 'plain'].includes(parsed.enc));
  if (parsed.enc === 'dpapi') assert.ok(!raw.includes('PLAINTEXT-MARKER-42'));
  await authed('/api/credentials', { method: 'DELETE' });
});

test('test-email reports a clear error when email is unconfigured', async () => {
  const res = await post('/api/test-email');
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.ok(/邮箱配置不完整/.test(body.error));
});

test('unknown API routes 404 instead of hanging', async () => {
  const res = await authed('/api/nope');
  assert.equal(res.status, 404);
});

test('static serving refuses path traversal', async () => {
  const res = await fetch(`${baseUrl}../package.json`);
  // Either normalised by the client/fetch or blocked by the server — never leaked.
  if (res.status === 200) {
    const text = await res.text();
    assert.ok(!text.includes('"name": "bupt-notify"'), 'must not serve files outside src/ui');
  } else {
    assert.ok(res.status === 403 || res.status === 404);
  }
});

test('malformed JSON bodies are rejected without crashing', async () => {
  const res = await fetch(u('/api/settings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BUPT-Token': token },
    body: '{not json',
  });
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.ok, false);

  // Server still healthy afterwards.
  assert.equal((await authed('/api/status')).status, 200);
});

/* ------------------------- auto-login backoff -------------------------- */

test('POST /api/auto-login/reset clears the failure count and the pause', async () => {
  // Drive the counter to the limit through the app's own API surface paths.
  const app = server.__app;
  assert.ok(app, 'test needs the App instance');
  for (let i = 0; i < app.status.autoLoginMaxFailures; i += 1) {
    app.recordAutoLoginResult(false, { credentialRejected: true, reason: '用户名或密码错误' });
  }
  let st = (await (await authed('/api/status')).json()).status;
  assert.equal(st.autoLoginPaused, true, 'paused at the limit');
  assert.ok(st.autoLoginCooldownMinutes > 0);

  const res = await post('/api/auto-login/reset');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);

  st = (await (await authed('/api/status')).json()).status;
  assert.equal(st.autoLoginFailures, 0);
  assert.equal(st.autoLoginPaused, false, 'auto-login allowed again');
});

test('saving credentials clears the backoff (a fixed password is not locked out)', async () => {
  const app = server.__app;
  for (let i = 0; i < app.status.autoLoginMaxFailures; i += 1) {
    app.recordAutoLoginResult(false, { credentialRejected: true, reason: '用户名或密码错误' });
  }
  assert.equal((await (await authed('/api/status')).json()).status.autoLoginPaused, true);

  const res = await post('/api/credentials', { username: '2021000000', password: 'corrected-pw' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).backoffCleared, true);

  const st = (await (await authed('/api/status')).json()).status;
  assert.equal(st.autoLoginFailures, 0, 'counter cleared on credential save');
  assert.equal(st.autoLoginPaused, false);
  await authed('/api/credentials', { method: 'DELETE' });
});

test('status exposes why auto-login failed, not just that it did', async () => {
  const app = server.__app;
  app.recordAutoLoginResult(false, { credentialRejected: false, reason: 'browser was closed' });
  const st = (await (await authed('/api/status')).json()).status;
  assert.equal(st.autoLoginFailures, 0, 'a technical failure is not counted');
  assert.match(String(st.autoLoginLastFailureReason), /browser/);
  app.resetAutoLoginBackoff();
});


/* --------------------------- autostart toggle --------------------------- */

test('GET /api/autostart reports a usable status shape', async () => {
  const res = await authed('/api/autostart');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.installed, 'boolean');
  if (process.platform === 'win32') {
    assert.equal(body.supported, true);
    assert.equal(body.taskName, 'BUPT-Notify');
  }
});

test('POST /api/autostart with a bad body does not crash the server', async () => {
  const res = await post('/api/autostart', { enabled: 'not-a-boolean' });
  assert.ok([200, 500].includes(res.status), `unexpected ${res.status}`);
  assert.equal((await authed('/api/status')).status, 200, 'server survives');
});

test('the suite never touches real scheduled tasks', async () => {
  // BUPT_NOTIFY_NO_SYSTEM_CHANGES makes setAutostart a dry run, so this asserts
  // the guard is actually in effect rather than the machine's task state.
  const res = await post('/api/autostart', { enabled: true, intervalHours: 3 });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.dryRun, true, 'expected a dry run — the guard is missing');
});

/* ------------------------- minimised-window state ----------------------- */

test('POST /api/window-state throttles and restores the poll rate', async () => {
  const hidden = await post('/api/window-state', { hidden: true });
  assert.equal(hidden.status, 200);
  const hb = await hidden.json();
  assert.equal(hb.hidden, true);
  assert.ok(hb.pollMs >= 10000, `minimised poll should be slow, got ${hb.pollMs}`);

  const st = (await (await authed('/api/status')).json()).status;
  assert.equal(st.windowHidden, true);
  assert.equal(st.statusPollMs, hb.pollMs);

  const shown = await post('/api/window-state', { hidden: false });
  const sb = await shown.json();
  assert.equal(sb.hidden, false);
  assert.ok(sb.pollMs <= 5000, `visible poll should be fast, got ${sb.pollMs}`);
  assert.equal((await (await authed('/api/status')).json()).status.windowHidden, false);
});

/* ------------------- empty-notification settings via API ---------------- */

test('the empty-notify option is exposed and toggleable', async () => {
  const st = (await (await authed('/api/status')).json()).status;
  assert.equal(typeof st.notifyWhenEmpty, 'boolean');
  assert.equal(typeof st.emptyNotifyIntervalHours, 'number');

  assert.equal((await post('/api/settings', { notifyWhenEmpty: false })).status, 200);
  assert.equal((await (await authed('/api/status')).json()).status.notifyWhenEmpty, false);

  assert.equal((await post('/api/settings', { notifyWhenEmpty: true })).status, 200);
  assert.equal((await (await authed('/api/status')).json()).status.notifyWhenEmpty, true);
});

test('the empty-notify interval is validated', async () => {
  assert.equal((await post('/api/settings', { emptyNotifyIntervalHours: 200 })).status, 400);
  assert.equal((await post('/api/settings', { emptyNotifyIntervalHours: 24 })).status, 200);
  assert.equal((await post('/api/settings', { emptyNotifyIntervalHours: 0 })).status, 200);
});

/* ----------------------------- stop / resume ---------------------------- */

test('POST /api/stop halts scraping and is reflected in the status', async () => {
  const res = await post('/api/stop');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.stopped, true);

  const st = await (await authed('/api/status')).json();
  assert.equal(st.status.stopped, true);
  assert.equal(st.status.schedulerActive, false, 'the scheduler must be halted');
  assert.equal(st.status.nextRunAt, null, 'no run may remain scheduled');
});

test('while stopped, POST /api/run is refused with 409', async () => {
  const res = await post('/api/run');
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.stopped, true);
  assert.match(body.error, /已停止|恢复/);
});

test('a dry-run is also refused while stopped', async () => {
  const res = await post('/api/run?dryRun=1');
  assert.equal(res.status, 409);
  assert.equal((await res.json()).stopped, true);
});

test('POST /api/resume re-enables scraping', async () => {
  const res = await post('/api/resume');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.stopped, false);

  const st = await (await authed('/api/status')).json();
  assert.equal(st.status.stopped, false);
  assert.equal(st.status.schedulerActive, true, 'the scheduler is armed again');
});

test('stop while a run is in flight leaves the app idle and stopped', async () => {
  // The baseUrl is a closed port, so a started run is short-lived but real.
  await post('/api/run');
  await new Promise((r) => setTimeout(r, 120));
  const body = await (await post('/api/stop')).json();
  assert.equal(body.ok, true);
  assert.equal(body.stopped, true);

  await new Promise((r) => setTimeout(r, 2500));
  const st = await (await authed('/api/status')).json();
  assert.equal(st.status.stopped, true);
  assert.equal(st.status.busy, false, 'the in-flight run must have finished');

  await post('/api/resume');
  const st2 = await (await authed('/api/status')).json();
  assert.equal(st2.status.stopped, false);
});
