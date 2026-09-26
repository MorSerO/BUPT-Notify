/**
 * config.js — load, merge with defaults, and validate configuration.
 *
 * Secrets can be kept out of the file by writing "${ENV_VAR}" as a value;
 * it is substituted from the environment (see resolveEnv). A local `.env`
 * file is also loaded if present.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA_DIR, readJson, writeJsonAtomic, ensureDir } from './util.js';

export const CONFIG_PATH = path.join(ROOT, 'config.json');
export const EXAMPLE_PATH = path.join(ROOT, 'config.example.json');

/** Minimal .env loader (KEY=VALUE per line, # comments). Never overwrites real env. */
export function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return out;
}

/** Replace "${VAR}" with the environment value; missing vars become ''. */
function resolveEnv(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) =>
      process.env[name] === undefined ? '' : process.env[name],
    );
  }
  if (Array.isArray(value)) return value.map(resolveEnv);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveEnv(v)]));
  }
  return value;
}

export const DEFAULT_CONFIG = {
  /** Which portal lists to watch. treeId values come from the portal's own links. */
  targets: [
    {
      key: 'notice',
      name: '校内通知',
      treeId: '1154',
      path: 'list.jsp?urltype=tree.TreeTempUrl&wbtreeid=1154',
    },
    {
      key: 'document',
      name: '校内文件',
      treeId: '2001',
      path: 'list.jsp?urltype=tree.TreeTempUrl&wbtreeid=2001',
    },
  ],

  baseUrl: 'http://my.bupt.edu.cn/',

  /** Only items published within this many days are considered "new". */
  windowDays: 10,

  /** How many list pages to walk per target (newest first). */
  maxPages: 3,

  network: {
    /** Reachability is decided by a real HTTPS request, never by DNS: the aTrust
     *  client poisons DNS for my.bupt.edu.cn even while the tunnel is down. */
    probeTimeoutMs: 15000,
    vpnPortalUrl: 'https://vpn.bupt.edu.cn/',
    /** How long to keep waiting for the user to finish logging in to the VPN. */
    waitTimeoutMs: 15 * 60 * 1000,
    pollIntervalMs: 5000,
  },

  session: {
    /** Dedicated Chrome profile so the CAS login survives reboots and never
     *  touches the user's main Chrome profile. */
    profileDir: path.join(DATA_DIR, 'chrome-profile'),
    channel: 'chrome',
    headless: true,
    /**
     * Leave empty to use Chrome's real User-Agent. There is no need to fake it:
     * a WAF/UA mismatch was investigated as a suspected cause of the CAS HTTP
     * 400 but was DISPROVED (see PortalSession.clearAuthCookies — the real cause
     * is a stale anonymous CAS cookie).
     */
    userAgent: '',
    /** Open a visible window for manual CAS login when the session is invalid. */
    loginTimeoutMs: 10 * 60 * 1000,
    loginPollIntervalMs: 4000,
  },

  /**
   * Where new items go. Set by `npm run setup`:
   *   'local' — only write a local digest file (no email)
   *   'email' — only send email
   *   'both'  — do both
   */
  output: {
    mode: 'local',
    /** Local digest directory. One Markdown file per day. */
    localDir: path.join(ROOT, 'output'),
    /** Keep it concise: title + capture time. */
    includeLink: true,
    includePublishDate: false,
    includeSource: true,
    /**
     * Also email when a check finds nothing new, so the user can tell the tool
     * is alive. Throttled by emptyNotifyIntervalHours.
     */
    notifyWhenEmpty: true,
    /** 0 = send on every check; 24 = at most once a day. */
    emptyNotifyIntervalHours: 0,
  },

  email: {
    enabled: false,
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    user: '',
    pass: '',
    from: '',
    to: [],
    subjectPrefix: '[北邮通知]',
  },

  poll: {
    /**
     * How the periodic check is driven.
     *
     *   'task'     — Windows Task Scheduler runs `--once --quiet` every
     *                intervalMinutes and the process exits. Nothing stays
     *                resident, so it keeps working with the app closed and never
     *                sits in the background consuming resources. (default)
     *   'resident' — a long-running process polls internally (npm start, or an
     *                open panel). Only for "always on" setups.
     */
    mode: 'task',
    intervalMinutes: 180,
    jitterSeconds: 0,
  },

  /** How to tell the user something needs attention. */
  notify: {
    /**
     * Show a Windows message box (e.g. "log in to the VPN"). Off by default: a
     * background run must not interrupt whatever you are doing. Problems still
     * reach the log.
     */
    desktop: false,
    /**
     * Let a background run open a browser window when there are no stored
     * credentials and a manual login is needed. Off by default for the same
     * reason — open the panel to log in interactively instead.
     */
    manualLoginWindow: false,
  },

  /**
   * Extra facts that ride along with every notification, both taken from pages
   * inside the same authenticated session:
   *
   *   status  — the 待办中心 widgets: 校园卡（北邮通）余额、未读邮件数、借阅、欠款
   *             (see src/portal.js)
   *   mailbox — the subjects of unread mail from the Coremail webmail
   *             (see src/mailbox.js)
   *
   * Both are optional and independently switchable from the panel; a failure in
   * either only drops that part of the digest.
   */
  portal: {
    status: true,
    mailbox: true,
    /** Coremail origin. The portal links there with a one-shot SSO key. */
    mailBase: 'https://mail.bupt.edu.cn',
    /** 收件箱 folder id. */
    mailFolderId: 1,
    /** Cap on how many unread subjects are forwarded in one digest. */
    maxMails: 20,
  },

  log: { level: 'info', file: true, console: true },

};

/** Deep-merge plain objects; arrays from `override` replace defaults wholesale. */
function deepMerge(base, override) {
  if (Array.isArray(override)) return override;
  if (override && typeof override === 'object' && base && typeof base === 'object') {
    const out = { ...base };
    for (const [k, v] of Object.entries(override)) {
      out[k] = k in base ? deepMerge(base[k], v) : v;
    }
    return out;
  }
  return override === undefined ? base : override;
}

export function loadConfig({ path: cfgPath = CONFIG_PATH, quiet = false } = {}) {
  loadDotEnv();
  let user = {};
  if (fs.existsSync(cfgPath)) {
    user = readJson(cfgPath, {}) || {};
  } else if (!quiet) {
    process.stderr.write(
      `提示: 未找到 ${path.basename(cfgPath)}，正在使用默认配置。\n` +
        `      运行 "npm run doctor" 或复制 config.example.json 为 config.json 后填写邮箱信息。\n`,
    );
  }
  const cfg = resolveEnv(deepMerge(DEFAULT_CONFIG, user));

  // Derive convenience fields.
  cfg.session.profileDir = path.isAbsolute(cfg.session.profileDir)
    ? cfg.session.profileDir
    : path.join(ROOT, cfg.session.profileDir);
  ensureDir(cfg.session.profileDir);

  if (cfg.output?.localDir) {
    cfg.output.localDir = path.isAbsolute(cfg.output.localDir)
      ? cfg.output.localDir
      : path.join(ROOT, cfg.output.localDir);
  }

  // Keep email.enabled in sync with the chosen output mode.
  if (cfg.output?.mode === 'email' || cfg.output?.mode === 'both') cfg.email.enabled = true;
  else if (cfg.output?.mode === 'local') cfg.email.enabled = false;

  for (const t of cfg.targets) {
    t.url = new URL(t.path, cfg.baseUrl).href;
  }
  return cfg;
}

/**
 * Bounds for the periodic check.
 *
 * The lower bound is 1 hour: Windows Task Scheduler handles hourly fine, and the
 * panel offers it. (It used to be 2 hours, back when a resident process owned the
 * schedule — the panel offering "every 1 hour" while the API rejected it was an
 * inconsistency.)
 */
export const MIN_INTERVAL_MINUTES = 60; // 1 小时
export const MAX_INTERVAL_MINUTES = 1440; // 24 小时

/**
 * Project a live config back onto the persisted shape (dropping derived fields
 * such as targets[].url, which is recomputed on load).
 */
export function toPersistedConfig(cfg) {
  return {
    baseUrl: cfg.baseUrl,
    targets: (cfg.targets || []).map((t) => ({
      key: t.key,
      name: t.name,
      treeId: t.treeId,
      path: t.path,
    })),
    windowDays: cfg.windowDays,
    maxPages: cfg.maxPages,
    output: {
      mode: cfg.output?.mode,
      localDir: cfg.output?.localDir,
      includeLink: cfg.output?.includeLink !== false,
      includePublishDate: cfg.output?.includePublishDate === true,
      includeSource: cfg.output?.includeSource !== false,
      notifyWhenEmpty: cfg.output?.notifyWhenEmpty !== false,
      emptyNotifyIntervalHours: Number(cfg.output?.emptyNotifyIntervalHours) || 0,
    },
    email: {
      enabled: Boolean(cfg.email?.enabled),
      host: cfg.email?.host,
      port: cfg.email?.port,
      secure: cfg.email?.secure !== false,
      user: cfg.email?.user || '',
      pass: cfg.email?.pass || '',
      from: cfg.email?.from || '',
      to: cfg.email?.to || [],
      subjectPrefix: cfg.email?.subjectPrefix || '[北邮通知]',
    },
    network: {
      probeTimeoutMs: cfg.network?.probeTimeoutMs,
      vpnPortalUrl: cfg.network?.vpnPortalUrl,
      waitTimeoutMs: cfg.network?.waitTimeoutMs,
      pollIntervalMs: cfg.network?.pollIntervalMs,
    },
    session: {
      profileDir: cfg.session?.profileDir,
      channel: cfg.session?.channel,
      headless: cfg.session?.headless !== false,
      loginTimeoutMs: cfg.session?.loginTimeoutMs,
      loginPollIntervalMs: cfg.session?.loginPollIntervalMs,
    },
    poll: {
      mode: cfg.poll?.mode === 'resident' ? 'resident' : 'task',
      intervalMinutes: cfg.poll?.intervalMinutes,
      jitterSeconds: cfg.poll?.jitterSeconds,
    },
    notify: {
      desktop: cfg.notify?.desktop === true,
      manualLoginWindow: cfg.notify?.manualLoginWindow === true,
    },
    portal: {
      status: cfg.portal?.status !== false,
      mailbox: cfg.portal?.mailbox !== false,
      mailBase: cfg.portal?.mailBase || DEFAULT_CONFIG.portal.mailBase,
      mailFolderId: Number(cfg.portal?.mailFolderId) || 1,
      maxMails: Number(cfg.portal?.maxMails) || 20,
    },
    log: {
      level: cfg.log?.level,
      file: cfg.log?.file !== false,
      console: cfg.log?.console !== false,
    },
  };
}

/** Persist the current configuration to config.json (backing up the previous one). */
export function saveConfig(cfg, { path: cfgPath = CONFIG_PATH } = {}) {
  try {
    if (fs.existsSync(cfgPath)) fs.copyFileSync(cfgPath, `${cfgPath}.bak`);
  } catch {
    /* backup is best-effort */
  }
  writeJsonAtomic(cfgPath, toPersistedConfig(cfg));
  return cfgPath;
}

/** Human-readable validation problems (empty array = OK). */
export function validateConfig(cfg) {
  const problems = [];
  if (!cfg.targets?.length) problems.push('targets 为空：至少需要一个要抓取的栏目。');
  for (const t of cfg.targets || []) {
    if (!t.key) problems.push(`target 缺少 key: ${JSON.stringify(t)}`);
    if (!t.treeId) problems.push(`target "${t.key}" 缺少 treeId。`);
  }
  if (cfg.windowDays <= 0) problems.push('windowDays 必须为正整数。');

  const mode = cfg.output?.mode;
  if (!['local', 'email', 'both'].includes(mode)) {
    problems.push(`output.mode 必须是 local / email / both 之一（当前: ${mode}）。`);
  }

  const e = cfg.email || {};
  // Email credentials are only required when something will actually be emailed.
  const emailWanted = mode === 'email' || mode === 'both' || e.enabled;
  if (emailWanted) {
    if (!e.host) problems.push('email.host 未配置。');
    if (!e.port) problems.push('email.port 未配置。');
    if (!e.user) problems.push('email.user 未配置（发信邮箱账号）。');
    if (!e.pass) {
      problems.push(
        'email.pass 未配置：QQ 邮箱需开启 SMTP 后生成 16 位授权码（不是登录密码）。运行 "npm run setup" 可交互填写。',
      );
    }
    if (!e.to?.length) problems.push('email.to 未配置（收件邮箱）。');
  }
  return problems;
}

/** True when the resolved config will actually send email. */
export function wantsEmail(cfg) {
  return Boolean(cfg.email?.enabled) || cfg.output?.mode === 'email' || cfg.output?.mode === 'both';
}

/** True when the resolved config will write a local digest. */
export function wantsLocal(cfg) {
  return cfg.output?.mode === 'local' || cfg.output?.mode === 'both';
}

