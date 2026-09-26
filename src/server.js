/**
 * server.js — the local control panel.
 *
 * A small HTTP server bound to 127.0.0.1 that serves the GUI and a JSON API.
 * The GUI window is the installed Chrome running in app mode
 * (`--app=http://127.0.0.1:PORT`), which gives a clean desktop window with no
 * browser chrome and no extra runtime to download.
 *
 * The panel is a CONTROL SURFACE, not a daemon: under the default 'task'
 * schedule the actual scraping is done by a short-lived process started by
 * Windows Task Scheduler, so closing the window stops nothing.
 *
 * Security: bound to loopback only, and every /api request must carry the
 * per-run token embedded in the served page. That stops any other local process
 * (or a stray browser tab) from triggering scrapes or reading settings.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { log } from './logger.js';
import {
  saveCredentials,
  clearCredentials,
  hasStoredCredentials,
  storedUsername,
  isDpapiAvailable,
} from './secrets.js';
import { verifyTransport, sendTestMail } from './mailer.js';
import { MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES } from './config.js';
import { getAutostartStatus, setAutostart } from './autostart.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(here, 'ui');

const MAX_BODY_BYTES = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * @param {{app:import('./app.js').App, port:number}} opts
 */
export function createUiServer({ app, port = 0 }) {
  const token = crypto.randomBytes(24).toString('hex');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port || server.address()?.port || 0}`);
    // Collapse duplicate slashes so "//api/status" still routes correctly.
    const route = url.pathname.replace(/\/{2,}/g, '/');

    // ---- API ----
    if (route.startsWith('/api/')) {
      const provided = req.headers['x-bupt-token'] || url.searchParams.get('token');
      if (provided !== token) {
        return sendJson(res, 403, { ok: false, error: '无效的访问令牌' });
      }

      try {
        if (route === '/api/status' && req.method === 'GET') {
          return sendJson(res, 200, {
            ok: true,
            status: app.status,
            limits: { minInterval: MIN_INTERVAL_MINUTES, maxInterval: MAX_INTERVAL_MINUTES },
          });
        }

        if (route === '/api/run' && req.method === 'POST') {
          if (app.stopped) {
            return sendJson(res, 409, { ok: false, stopped: true, error: '抓取已停止，请先点「恢复自动抓取」' });
          }
          if (app.busy) return sendJson(res, 409, { ok: false, error: '已有抓取任务正在进行中' });
          const dryRun = url.searchParams.get('dryRun') === '1';
          // Fire and forget: the UI polls /api/status for progress.
          app
            .runOnce({ reason: dryRun ? '手动试运行' : '手动触发', dryRun })
            .catch((err) => log.error(`手动抓取失败: ${err.message}`));
          return sendJson(res, 202, { ok: true, message: dryRun ? '已开始试运行' : '已开始抓取', dryRun });
        }

        // 彻底停止抓取：halt the schedule, cancel the running task, close the browser.
        if (route === '/api/stop' && req.method === 'POST') {
          const r = await app.stop({ reason: '用户在面板按下停止' });
          return sendJson(res, 200, r);
        }

        if (route === '/api/resume' && req.method === 'POST') {
          const r = app.resume();
          return sendJson(res, 200, r);
        }

        if (route === '/api/settings' && req.method === 'POST') {
          const body = await readBody(req);
          const result = app.applySettings(body);
          return sendJson(res, result.ok ? 200 : 400, result);
        }

        if (route === '/api/credentials' && req.method === 'POST') {
          const body = await readBody(req);
          const username = String(body.username || '').trim();
          const password = String(body.password || '');
          if (!username) return sendJson(res, 400, { ok: false, error: '请输入统一身份认证账号（学号）' });
          if (!password) return sendJson(res, 400, { ok: false, error: '请输入密码' });
          const r = await saveCredentials({ username, password });
          // New credentials invalidate the old failure count — otherwise a
          // corrected password would stay locked out for the remaining cooldown.
          app.resetAutoLoginBackoff();
          app.pushEvent('info', `已保存统一身份认证账号：${username}（加密：${r.enc}），并已清除失败计数`);
          return sendJson(res, 200, { ok: true, enc: r.enc, username, backoffCleared: true });
        }

        if (route === '/api/credentials' && req.method === 'DELETE') {
          clearCredentials();
          app.resetAutoLoginBackoff();
          app.pushEvent('warn', '已删除保存的账号密码');
          return sendJson(res, 200, { ok: true });
        }

        // Let the user clear the lockout pause without re-entering credentials.
        if (route === '/api/auto-login/reset' && req.method === 'POST') {
          const r = app.resetAutoLoginBackoff();
          app.pushEvent('info', '已清除自动登录失败计数，下一次运行会重新尝试自动登录');
          return sendJson(res, 200, { ok: true, ...r });
        }

        /* ------------------- 定时抓取（计划任务） ------------------- */

        if (route === '/api/autostart' && req.method === 'GET') {
          const status = await getAutostartStatus();
          const dpapi = await isDpapiAvailable();
          return sendJson(res, 200, {
            ok: true,
            ...status,
            credentialEncrypted: dpapi,
            hasCredentials: hasStoredCredentials(),
            username: storedUsername(),
            defaultIntervalHours: (app.cfg.poll?.intervalMinutes || 180) / 60,
            pollMode: app.cfg.poll?.mode || 'task',
          });
        }

        if (route === '/api/autostart' && req.method === 'POST') {
          const body = await readBody(req);
          const enabled = Boolean(body.enabled);
          // NOTE: an explicit 0/NaN must NOT silently fall back to the config
          // default — `Number(0) || fallback` did exactly that and accepted 0.
          const raw = body.intervalHours;
          const intervalHours =
            raw === undefined || raw === null || raw === ''
              ? (app.cfg.poll?.intervalMinutes || 180) / 60
              : Number(raw);

          // The slider offers 1-24 whole hours; anything the caller sends must
          // still land in the range the scheduled task can express.
          if (enabled && (!Number.isFinite(intervalHours) || intervalHours < 0.25 || intervalHours > 24)) {
            return sendJson(res, 400, {
              ok: false,
              error: '抓取间隔必须在 0.25–24 小时之间',
              intervalHours: Number.isFinite(intervalHours) ? intervalHours : null,
            });
          }

          const r = await setAutostart(enabled, { intervalHours, mode: 'once' });
          app.pushEvent(
            r.ok ? 'info' : 'error',
            r.ok
              ? enabled
                ? `已启用定时自动抓取：每 ${intervalHours} 小时后台执行一次，跑完即退出`
                : '已取消定时自动抓取'
              : `定时任务操作失败：${r.error}`,
          );
          return sendJson(res, r.ok ? 200 : 500, r);
        }

        /* ------------------- 窗口最小化 / 恢复 ------------------- */

        /**
         * The panel reports when its window is hidden (minimised) or visible
         * again, which throttles the status poll. GPU memory is handled
         * separately: the panel is launched with the GPU disabled (net.js).
         */
        if (route === '/api/window-state' && req.method === 'POST') {
          const body = await readBody(req);
          const hidden = Boolean(body.hidden);
          app.setWindowHidden(hidden);
          return sendJson(res, 200, { ok: true, hidden, pollMs: app.statusPollMs });
        }

        /* ------------------------- 邮件 ------------------------- */

        if (route === '/api/test-email' && req.method === 'POST') {
          const cfg = app.cfg;
          if (!cfg.email?.user || !cfg.email?.pass || !cfg.email?.to?.length) {
            return sendJson(res, 400, { ok: false, error: '邮箱配置不完整：需要发件邮箱、授权码和收件邮箱' });
          }
          const v = await verifyTransport(cfg.email);
          if (!v.ok) return sendJson(res, 200, { ok: false, stage: 'smtp', error: v.error });
          const t = await sendTestMail(cfg);
          app.pushEvent(t.ok ? 'info' : 'error', t.ok ? '测试邮件已发送' : `测试邮件失败：${t.error}`);
          return sendJson(res, 200, { ok: t.ok, stage: t.ok ? 'sent' : 'send', error: t.error });
        }

        if (route === '/api/email' && req.method === 'POST') {
          const body = await readBody(req);
          const patch = {};
          if (body.user !== undefined) patch.emailUser = String(body.user).trim();
          if (body.pass) patch.emailPass = String(body.pass);
          if (body.to !== undefined) patch.emailTo = String(body.to).trim();
          const r = app.applySettings(patch);
          return sendJson(res, r.ok ? 200 : 400, r);
        }

        if (route === '/api/logout' && req.method === 'POST') {
          await app.session.close();
          app.pushEvent('warn', '已清除浏览器会话，下次运行将重新登录');
          return sendJson(res, 200, { ok: true });
        }

        return sendJson(res, 404, { ok: false, error: `未知接口 ${route}` });
      } catch (err) {
        log.error(`API ${route} 出错: ${err.message}`);
        return sendJson(res, 500, { ok: false, error: err.message });
      }
    }

    // ---- static UI ----
    const rel = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
    const filePath = path.join(UI_DIR, rel);

    // Path traversal guard.
    if (!filePath.startsWith(UI_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    let content;
    try {
      content = fs.readFileSync(filePath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }

    // Inject the token so the page can authenticate its API calls.
    let body = content;
    if (rel === 'index.html') {
      const text = content.toString('utf8').replace('__BUPT_TOKEN__', token);
      body = Buffer.from(text, 'utf8');
    }

    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': body.length,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
    return undefined;
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      log.info(`控制面板已启动: http://127.0.0.1:${actual}`);
      resolve({ server, port: actual, url: `http://127.0.0.1:${actual}/`, token });
    });
  });
}
