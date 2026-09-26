/**
 * net.js — network reachability gate.
 *
 * IMPORTANT: the Sangfor aTrust VPN client hijacks DNS for my.bupt.edu.cn and
 * answers with a fake IP (198.18.0.3, and an AAAA that literally spells
 * "SANGFOR" in hex). Even public resolvers return that fake address, so DNS
 * tells us nothing. Reachability MUST be decided by an actual HTTP request.
 *
 * Also note: "reachable" means the campus network / VPN is up. It does NOT mean
 * we are logged in — a redirect to CAS still proves the network is fine.
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { log } from './logger.js';
import { cancellableSleep } from './cancel.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Single reachability probe.
 * Resolves (never rejects) with { ok, status, error, elapsedMs, location }.
 * ok === true for ANY HTTP status: receiving a response at all proves the
 * network path exists. Only transport errors count as unreachable.
 *
 * Pass a CancellationToken to abort an in-flight request immediately — the
 * probe can otherwise sit for the full timeout, which would make the stop
 * button feel unresponsive.
 */
export function probeUrl(url, { timeoutMs = 15000, method = 'GET', token } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let off = null;
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (off) off();
      resolve({ ...result, elapsedMs: Date.now() - started });
    };

    if (token?.cancelled) return done({ ok: false, cancelled: true, error: '已停止' });

    let target;
    try {
      target = new URL(url);
    } catch (err) {
      return done({ ok: false, error: `非法 URL: ${url}` });
    }

    const mod = target.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method,
        timeout: timeoutMs,
        // The portal may present a private/institutional certificate.
        rejectUnauthorized: false,
        headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      },
      (res) => {
        done({ ok: true, status: res.statusCode, location: res.headers.location || null });
        // Do not drain the whole body: reachability is all we need.
        res.destroy();
      },
    );

    req.on('timeout', () => {
      req.destroy();
      done({ ok: false, error: `超时 (${timeoutMs}ms)` });
    });
    req.on('error', (err) =>
      done({
        ok: false,
        cancelled: Boolean(token?.cancelled),
        error: token?.cancelled ? '已停止' : `${err.code || ''} ${err.message}`.trim(),
      }),
    );

    // Abort the socket the moment the user stops.
    if (token) {
      off = token.onCancel(() => {
        try {
          req.destroy();
        } catch {
          /* already gone */
        }
        done({ ok: false, cancelled: true, error: '已停止' });
      });
    }

    req.end();
    return undefined;
  });
}

/** Distinguish "no campus network" from other failures, for logging. */
export function describeProbe(r) {
  if (r.ok) return `可达 (HTTP ${r.status}${r.location ? ` → ${r.location}` : ''}, ${r.elapsedMs}ms)`;
  return `不可达: ${r.error}`;
}

/** Open a URL in the user's default browser (Windows). */
export function openInBrowser(url) {
  try {
    const child = spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    log.info(`已在浏览器中打开: ${url}`);
    return true;
  } catch (err) {
    log.error(`打开浏览器失败: ${err.message}`);
    return false;
  }
}

/** Common Chrome install locations on Windows. */
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];

export function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Chrome flags for the control-panel window.
 *
 * The panel is a static page: it needs neither hardware acceleration nor any of
 * Chrome's background machinery. Everything below exists to keep its footprint
 * as small as possible while it sits in the background.
 *
 * NOTE on the GPU: `--disable-gpu` does not remove Chrome's GPU process — Chrome
 * still spawns one, running in software. What it removes is the *hardware*
 * context, so the window stops claiming video memory.
 */
const PANEL_GPU_ARGS = [
  // No hardware acceleration => no VRAM claim.
  '--disable-gpu',
  '--disable-gpu-compositing',
  '--disable-accelerated-2d-canvas',
  '--disable-accelerated-video-decode',
  '--disable-accelerated-video-encode',
  '--disable-gpu-rasterization',
  // Trim the process tree and background work: one renderer, no extensions,
  // no sync, no component updates, no crash reporting, no pings.
  '--renderer-process-limit=1',
  '--disable-extensions',
  '--disable-component-update',
  '--disable-sync',
  '--disable-client-side-phishing-detection',
  '--disable-breakpad',
  '--disable-crash-reporter',
  '--no-service-autorun',
  '--metrics-recording-only',
  '--disable-domain-reliability',
  '--disable-features=Translate,BackForwardCache,CalculateNativeWinOcclusion,OptimizationHints,MediaRouter,InterestFeedContentSuggestions',
];

/**
 * Open `url` as a standalone desktop-style window.
 *
 * Chrome's `--app=` mode renders the page without tabs, address bar or toolbar,
 * so the control panel looks and behaves like a native app window while reusing
 * the Chrome that is already installed (nothing extra to download).
 * Falls back to a normal browser tab if Chrome cannot be found.
 */
export function openAppWindow(url, { title = 'BUPT-Notify' } = {}) {
  const chrome = findChrome();
  if (!chrome) {
    log.warn('未找到 Google Chrome，改为在默认浏览器中打开控制面板。');
    return openInBrowser(url);
  }
  try {
    const child = spawn(
      chrome,
      [
        `--app=${url}`,
        `--user-data-dir=${path.join(process.env.LOCALAPPDATA || '', 'BUPT-Notify', 'ui-profile')}`,
        ...PANEL_GPU_ARGS,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1120,860',
      ],
      { detached: true, stdio: 'ignore', windowsHide: false },
    );
    child.unref();
    log.info(`已打开控制面板窗口: ${url}（已禁用 GPU 以节省显存）`);
    return true;
  } catch (err) {
    log.error(`打开控制面板窗口失败: ${err.message}，改用默认浏览器。`);
    return openInBrowser(url);
  }
}

/**
 * Wait until `url` is reachable, polling until timeout.
 * Used after opening the VPN portal so the user can finish logging in.
 *
 * Interruptible: pass a CancellationToken and the loop stops immediately.
 */
export async function waitForReachable(url, { timeoutMs, pollIntervalMs = 5000, onTick, token } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let last = null;

  while (Date.now() < deadline) {
    if (token?.cancelled) return { ok: false, cancelled: true, attempts: attempt, probe: last };
    attempt += 1;
    last = await probeUrl(url, { timeoutMs: 10000 });
    if (last.ok) return { ok: true, attempts: attempt, probe: last };
    if (onTick) onTick(attempt, last, deadline - Date.now());
    const slept = await cancellableSleep(pollIntervalMs, token);
    if (!slept) return { ok: false, cancelled: true, attempts: attempt, probe: last };
  }
  return { ok: false, attempts: attempt, probe: last };
}

/**
 * Ensure the campus network / VPN is up.
 *
 * Flow required by the user: try my.bupt.edu.cn first; if that fails, open
 * vpn.bupt.edu.cn so they can log in by hand, then keep re-probing until the
 * portal becomes reachable.
 *
 * @returns {Promise<{ok:boolean, probe:object, openedVpn:boolean, userNotified:boolean}>}
 */
export async function ensureNetwork(cfg, { notify = () => {}, token } = {}) {
  const probeUrlTarget = cfg.baseUrl;
  const netCfg = cfg.network;

  token?.throwIfCancelled('网络检查');
  log.info(`检查校园网连通性: ${probeUrlTarget}`);
  let probe = await probeUrl(probeUrlTarget, { timeoutMs: netCfg.probeTimeoutMs, token });
  log.info(`连通性: ${describeProbe(probe)}`);

  if (probe.cancelled) return { ok: false, cancelled: true, probe, openedVpn: false, userNotified: false };
  if (probe.ok) return { ok: true, probe, openedVpn: false, userNotified: false };

  token?.throwIfCancelled('等待 VPN 登录');
  log.warn('无法连接校内门户，判断为未接入校园网 / VPN 未连接。');
  log.warn(`正在打开 VPN 门户，请在弹出的浏览器中完成登录: ${netCfg.vpnPortalUrl}`);
  openInBrowser(netCfg.vpnPortalUrl);
  notify(
    '需要登录 VPN',
    `无法连接 ${probeUrlTarget}。\n\n已为你打开 ${netCfg.vpnPortalUrl}\n` +
      `请登录并建立 VPN 连接，程序会自动继续（最多等待 ${Math.round(netCfg.waitTimeoutMs / 60000)} 分钟）。`,
  );

  const result = await waitForReachable(probeUrlTarget, {
    timeoutMs: netCfg.waitTimeoutMs,
    pollIntervalMs: netCfg.pollIntervalMs,
    token,
    onTick: (attempt, p) => {
      if (attempt % 6 === 1) log.info(`等待网络恢复… 第 ${attempt} 次探测: ${describeProbe(p)}`);
    },
  });

  if (result.cancelled) {
    log.warn('等待网络恢复已被用户停止。');
    return { ok: false, cancelled: true, probe: result.probe, openedVpn: true, userNotified: true };
  }

  if (result.ok) {
    log.info(`网络已恢复 (第 ${result.attempts} 次探测)。`);
    return { ok: true, probe: result.probe, openedVpn: true, userNotified: true };
  }
  log.error(`等待超时，仍未连接校园网。最后状态: ${describeProbe(result.probe)}`);
  return { ok: false, probe: result.probe, openedVpn: true, userNotified: true };
}
