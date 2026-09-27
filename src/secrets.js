/**
 * secrets.js — local storage for the 统一身份认证 (CAS) credentials.
 *
 * The user asked to save a fixed username/password locally so the tool can log
 * in by itself. A campus password deserves better than plaintext, so on Windows
 * we encrypt with DPAPI (CryptProtectData, CurrentUser scope): the ciphertext is
 * tied to the Windows account and is useless if the file is copied elsewhere.
 *
 * Everything degrades gracefully: if DPAPI is unavailable (non-Windows, locked
 * down PowerShell, …) we fall back to plaintext and say so loudly.
 *
 * PowerShell is invoked with stdio:"ignore" and communicates through files,
 * because the sandbox forbids capturing child stdout through pipes.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { DATA_DIR, ensureDir, readJson, writeJsonAtomic, sleep } from './util.js';
import { log } from './logger.js';

/**
 * Where credentials live. Overridable with BUPT_NOTIFY_CRED_PATH so tests (and
 * unusual deployments) never touch the real file.
 *
 * Resolved on every call rather than at module load, so the env var works no
 * matter which module pulled this in first.
 */
export function credPath() {
  return process.env.BUPT_NOTIFY_CRED_PATH
    ? path.resolve(process.env.BUPT_NOTIFY_CRED_PATH)
    : path.join(DATA_DIR, 'credentials.json');
}


const PS_TIMEOUT_MS = 20000;

/** Run a PowerShell script that reads env INFILE and writes env OUTFILE. */
function runPowerShellFile(script, { inFile, outFile }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    let child;
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, INFILE: inFile || '', OUTFILE: outFile || '' },
      });
    } catch (err) {
      return done({ ok: false, error: err.message });
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      done({ ok: false, error: 'PowerShell 超时' });
    }, PS_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, error: err.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, error: code === 0 ? null : `PowerShell 退出码 ${code}` });
    });
  });
}

/** Working area for the transient plaintext/cipher files. */
function tmpFile(tag) {
  ensureDir(DATA_DIR);
  return path.join(DATA_DIR, `.dpapi-${tag}-${process.pid}-${Date.now()}.tmp`);
}

const PROTECT_PS = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $plain = [System.IO.File]::ReadAllText($env:INFILE, [System.Text.Encoding]::UTF8)
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
  $enc   = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
  [System.IO.File]::WriteAllText($env:OUTFILE, [Convert]::ToBase64String($enc), [System.Text.Encoding]::ASCII)
  exit 0
} catch { exit 1 }
`;

const UNPROTECT_PS = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $b64   = [System.IO.File]::ReadAllText($env:INFILE, [System.Text.Encoding]::ASCII).Trim()
  $bytes = [Convert]::FromBase64String($b64)
  $dec   = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
  # NOTE: [System.Text.Encoding]::UTF8 emits a BOM when used with WriteAllText,
  # which would prepend U+FEFF to the password. Use a BOM-less encoder.
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($env:OUTFILE, $utf8NoBom.GetString($dec), $utf8NoBom)
  exit 0
} catch { exit 1 }
`;

/** Node's readFileSync does not strip a UTF-8 BOM, so do it here defensively. */
function stripBom(s) {
  return String(s).replace(/^\uFEFF/, '');
}

/** Encrypt with DPAPI. Returns base64 ciphertext or null. */
export async function dpapiProtect(plain) {
  if (process.platform !== 'win32') return null;
  const inFile = tmpFile('in');
  const outFile = tmpFile('out');
  try {
    fs.writeFileSync(inFile, String(plain), 'utf8');
    const r = await runPowerShellFile(PROTECT_PS, { inFile, outFile });
    if (!r.ok || !fs.existsSync(outFile)) return null;
    const b64 = stripBom(fs.readFileSync(outFile, 'utf8')).trim();
    return b64 || null;
  } catch {
    return null;
  } finally {
    for (const f of [inFile, outFile]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* best effort */
      }
    }
  }
}

/** Decrypt DPAPI base64 ciphertext. Returns plaintext or null. */
export async function dpapiUnprotect(b64) {
  if (process.platform !== 'win32') return null;
  const inFile = tmpFile('cin');
  const outFile = tmpFile('cout');
  try {
    fs.writeFileSync(inFile, String(b64), 'ascii');
    const r = await runPowerShellFile(UNPROTECT_PS, { inFile, outFile });
    if (!r.ok || !fs.existsSync(outFile)) return null;
    return stripBom(fs.readFileSync(outFile, 'utf8'));
  } catch {
    return null;
  } finally {
    for (const f of [inFile, outFile]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* best effort */
      }
    }
  }
}

/** Probe whether DPAPI works in this environment (cached). */
let dpapiSupport = null;
export async function isDpapiAvailable() {
  if (dpapiSupport !== null) return dpapiSupport;
  if (process.platform !== 'win32') {
    dpapiSupport = false;
    return false;
  }
  const probe = `notify-probe-${Date.now()}`;
  const enc = await dpapiProtect(probe);
  if (!enc) {
    dpapiSupport = false;
    return false;
  }
  const dec = await dpapiUnprotect(enc);
  dpapiSupport = dec === probe;
  return dpapiSupport;
}

/**
 * Persist credentials.
 * @returns {Promise<{ok:boolean, enc:'dpapi'|'plain', error?:string}>}
 */
export async function saveCredentials({ username, password }) {
  let secret = String(password ?? '');
  let enc = 'plain';

  if (await isDpapiAvailable()) {
    const cipher = await dpapiProtect(secret);
    if (cipher) {
      secret = cipher;
      enc = 'dpapi';
    }
  }
  if (enc === 'plain') {
    log.warn(
      '未能使用 Windows DPAPI 加密，密码将以明文保存在 data/credentials.json（该目录已被 .gitignore 忽略）。',
    );
  }

  writeJsonAtomic(credPath(), {
    version: 1,
    enc,
    username: String(username ?? ''),
    secret,
    updatedAt: new Date().toISOString(),
  });
  return { ok: true, enc };
}

/**
 * Load credentials, decrypting if needed.
 * @returns {Promise<{username:string, password:string, enc:string}|null>}
 */
export async function loadCredentials() {
  const raw = readJson(credPath(), null);
  if (!raw || !raw.username) return null;

  if (raw.enc === 'dpapi') {
    const plain = await dpapiUnprotect(raw.secret);
    if (plain === null) {
      log.error(
        '无法解密已保存的密码（DPAPI 失败：可能换了 Windows 账户或配置文件来自另一台机器）。请重新设置。',
      );
      return { username: raw.username, password: '', enc: 'dpapi-failed' };
    }
    return { username: raw.username, password: plain, enc: 'dpapi' };
  }
  return { username: raw.username, password: String(raw.secret ?? ''), enc: 'plain' };
}

/** True when credentials are stored (without decrypting). */
export function hasStoredCredentials() {
  const raw = readJson(credPath(), null);
  return Boolean(raw && raw.username && raw.secret);
}

/** Username only, for display in the UI (never returns the password). */
export function storedUsername() {
  const raw = readJson(credPath(), null);
  return raw?.username || '';
}

export function clearCredentials() {
  try {
    if (fs.existsSync(credPath())) fs.unlinkSync(credPath());
    return true;
  } catch (err) {
    log.error(`删除凭据失败: ${err.message}`);
    return false;
  }
}
