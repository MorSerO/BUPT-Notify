/**
 * app.js — the application core shared by every entry point.
 *
 * Owns the whole pipeline (network gate → session/auto-login → collect →
 * deliver → persist) plus the polling schedule, so the CLI and the desktop GUI
 * drive exactly the same code and cannot run two scrapes at once.
 *
 * Also keeps a small in-memory event log that the GUI polls for live status.
 */

import { EventEmitter } from 'node:events';
import { log } from './logger.js';
import { Store } from './store.js';
import { PortalSession } from './fetcher.js';
import { HttpSession } from './httpSession.js';
import { collectAll, collectExtras, derivePageBudget } from './collector.js';
import { deliver, describeOutput } from './output.js';
import { sendEmptyNotification } from './mailer.js';
import { DEFAULT_MAIL_BASE } from './mailbox.js';
import { ensureNetwork } from './net.js';
import { loadCredentials, hasStoredCredentials, storedUsername } from './secrets.js';
import { saveConfig, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES } from './config.js';
import { todayLocal, truncate, sleep } from './util.js';
import { CancellationToken, isCancellation } from './cancel.js';

/** Consecutive auto-login failures before we stop trying (avoid locking the account). */
const MAX_AUTO_LOGIN_FAILURES = 3;
/** How long to wait, after repeated credential rejections, before retrying. */
const AUTO_LOGIN_COOLDOWN_MS = 30 * 60 * 1000;

/** UI status-poll interval: normal, and while the window is minimised. */
const VISIBLE_STATUS_POLL_MS = 2000;
const HIDDEN_STATUS_POLL_MS = 30000;


export class App extends EventEmitter {
  /**
   * @param {object} cfg loaded configuration
   * @param {{store?:Store, configPath?:string, session?:object, quiet?:boolean,
   *          lock?:{acquire:Function, release:Function}|null}} [opts]
   */
  constructor(cfg, { store, configPath, session, quiet = false, lock = null } = {}) {
    super();
    this.cfg = cfg;
    this.store = store || new Store();
    this.configPath = configPath || null;
    /**
     * Cross-process run lock (see src/lock.js).
     *
     * Only the control panel passes one: in `poll.mode = "task"` the panel must
     * not hold the instance lock while idle (that made every scheduled run skip),
     * so it protects just the moment of a run instead. `--once` and the resident
     * poller hold the lock for their whole process and pass `null` here.
     */
    this.runLock = lock;
    /**
     * Quiet mode = a background/scheduled run. It must never take over the
     * screen: no message boxes and no browser window. Explicit `--quiet` wins;
     * otherwise it follows `notify.desktop` (false by default).
     */
    this.quiet = quiet || cfg.notify?.desktop !== true;
    // The portal reads fine over plain HTTP while an automated Chrome is actively
    // obstructed by the site (see src/httpSession.js), so HTTP is the default.
    // A browser is still created on demand purely for manual logins.
    this.session = session || new HttpSession(cfg);
    this.busy = false;
    this.currentRun = null;
    this.startedAt = new Date();
    this.nextRunAt = null;
    this.timer = null;
    this.stopping = false;
    this.schedulerActive = false;
    this.schedulerNotify = null;
    /** Minimised-window state, drives the UI poll rate. */
    this.windowHidden = false;
    this.statusPollMs = VISIBLE_STATUS_POLL_MS;

    /** User pressed 停止抓取: no automatic runs, no manual runs, until resumed. */
    this.stopped = false;
    this.stopReason = '';
    /** @type {import('./cancel.js').CancellationToken|null} */
    this.currentToken = null;
    /** Human-readable current step, shown live in the GUI. */
    this.stage = '空闲';

    /** @type {Array<{at:string,level:string,message:string}>} */
    this.events = [];
  }

  /* ------------------------------- events -------------------------------- */

  pushEvent(level, message) {
    const ev = { at: new Date().toISOString(), level, message: String(message) };
    this.events.push(ev);
    if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
    this.emit('event', ev);
    return ev;
  }

  /* -------------------------------- auth --------------------------------- */

  /**
   * The cooldown state, derived purely from the failure counter.
   *
   * Deliberately independent of whether credentials are stored: the pause is a
   * property of the failure history, not of the credential file. Conflating the
   * two previously made `autoLoginPaused` silently false whenever credentials
   * were absent (e.g. after the user deleted them).
   */
  autoLoginCooldown() {
    const failures = Number(this.store.getMeta('autoLoginFailures', 0));
    const lastAt = this.store.getMeta('autoLoginLastFailureAt', null);
    if (failures < MAX_AUTO_LOGIN_FAILURES || !lastAt) {
      return { paused: false, failures, remainingMs: 0, remainingMinutes: 0 };
    }
    const elapsed = Date.now() - new Date(lastAt).getTime();
    const remainingMs = AUTO_LOGIN_COOLDOWN_MS - elapsed;
    if (remainingMs <= 0) {
      // Cooldown served: clear the counter so the next run tries again.
      this.store.setMeta('autoLoginFailures', 0);
      this.store.save();
      return { paused: false, failures: 0, remainingMs: 0, remainingMinutes: 0 };
    }
    return { paused: true, failures, remainingMs, remainingMinutes: Math.ceil(remainingMs / 60000) };
  }

  /**
   * Should we try automatic login right now?
   *
   * Backs off after repeated *credential rejections* so a wrong password cannot
   * lock the account. Technical failures never reach this counter (see
   * recordAutoLoginResult).
   */
  autoLoginAllowed() {
    const cd = this.autoLoginCooldown();
    if (cd.paused) {
      return { allowed: false, reason: 'cooldown', cooldownMinutes: cd.remainingMinutes, failures: cd.failures };
    }
    if (!hasStoredCredentials()) return { allowed: false, reason: 'no-credentials' };
    return { allowed: true };
  }

  /**
   * Record an auto-login outcome.
   *
   * Only a REAL credential rejection may count towards the lockout backoff.
   * A closed browser, a blocked page, a missing form or a captcha says nothing
   * about whether the password is right — counting those would pause auto-login
   * for a reason that has nothing to do with the account, and would tell the user
   * "连续失败过多，避免账号被锁定" when nothing of the sort happened.
   *
   * @param {boolean} ok
   * @param {{credentialRejected?:boolean, reason?:string}} [info]
   */
  recordAutoLoginResult(ok, { credentialRejected = false, reason = '' } = {}) {
    if (ok) {
      this.store.setMeta('autoLoginFailures', 0);
      this.store.setMeta('autoLoginLastSuccessAt', new Date().toISOString());
      this.store.setMeta('autoLoginLastFailureReason', null);
      this.store.save();
      return { counted: false, failures: 0 };
    }

    if (!credentialRejected) {
      // Remember why, but do NOT increment the failure counter.
      this.store.setMeta('autoLoginLastFailureReason', reason || '未知原因');
      this.store.setMeta('autoLoginLastFailureAt', new Date().toISOString());
      this.store.save();
      return { counted: false, failures: Number(this.store.getMeta('autoLoginFailures', 0)) };
    }

    const n = Number(this.store.getMeta('autoLoginFailures', 0)) + 1;
    this.store.setMeta('autoLoginFailures', n);
    this.store.setMeta('autoLoginLastFailureAt', new Date().toISOString());
    this.store.setMeta('autoLoginLastFailureReason', reason || '账号或密码被拒绝');
    this.store.save();
    return { counted: true, failures: n };
  }

  /** Clear the lockout backoff (after the user fixes the password, or on request). */
  resetAutoLoginBackoff() {
    this.store.setMeta('autoLoginFailures', 0);
    this.store.setMeta('autoLoginLastFailureReason', null);
    this.store.save();
    return { ok: true, failures: 0 };
  }

  /** Make sure we have a live session, using saved credentials when possible. */
  async ensureSession({ notify = () => {}, token } = {}) {
    token?.throwIfCancelled('登录检查');
    if (!this.session.context) await this.session.launch({ headless: this.cfg.session.headless });

    const gate = this.autoLoginAllowed();
    let credentials = null;
    if (gate.allowed) {
      const creds = await loadCredentials();
      if (creds?.password) credentials = creds;
      this.pushEvent('info', `将尝试使用已保存的账号自动登录 (${creds?.username || ''})`);
    } else if (gate.reason === 'no-credentials') {
      this.pushEvent('info', '未保存账号密码，会话失效时需要手动登录一次（可在面板中设置以启用自动登录）');
    } else if (gate.reason === 'cooldown') {
      this.pushEvent(
        'warn',
        `自动登录已暂停 ${gate.cooldownMinutes} 分钟（连续失败 ${gate.failures} 次，避免账号被锁定）`,
      );
    }

    const result = await this.session.ensureLoggedIn({
      notify,
      credentials,
      allowAutoLogin: gate.allowed,
      autoLoginBlockReason: gate.reason || '',
      token,
      /**
       * A background/scheduled run must not throw a browser window in the user's
       * face. When there are no stored credentials it simply gives up and logs;
       * the panel is where a human logs in.
       */
      allowManualLogin: !this.quiet || this.cfg.notify?.manualLoginWindow === true,
    });

    if (result.ok && result.method?.startsWith('auto')) {
      this.recordAutoLoginResult(true);
      this.pushEvent('info', '自动登录成功');
    } else if (result.ok) {
      this.recordAutoLoginResult(true);
      this.pushEvent('info', '复用已保存的登录会话');
    } else if (gate.allowed && credentials) {
      const rec = this.recordAutoLoginResult(false, {
        credentialRejected: Boolean(result.credentialRejected),
        reason: result.reason,
      });
      if (result.credentialRejected) {
        this.pushEvent(
          'error',
          `自动登录被拒绝（第 ${rec.failures}/${MAX_AUTO_LOGIN_FAILURES} 次）：${result.serverError || result.reason}`,
        );
      } else if (!result.cancelled) {
        this.pushEvent(
          'warn',
          `自动登录未能完成（属于技术原因，不计入失败次数，也不会暂停自动登录）：${result.reason}`,
        );
      }
    }
    return result;
  }

  /* -------------------------------- runs --------------------------------- */

  get status() {
    // Pick up runs performed by OTHER processes. Under the default 'task'
    // schedule each run is a separate short-lived process, so an open panel must
    // not keep showing whatever its own instance last saw.
    try {
      if (this.store.reloadIfChanged()) this.emit('state-reloaded');
    } catch {
      /* a refresh must never fail */
    }
    const cd = this.autoLoginCooldown();
    return {
      busy: this.busy,
      stopped: this.stopped,
      stopReason: this.stopReason,
      stage: this.stage,
      schedulerActive: Boolean(this.schedulerActive),
      startedAt: this.startedAt.toISOString(),
      nextRunAt: this.nextRunAt ? this.nextRunAt.toISOString() : null,
      intervalMinutes: this.cfg.poll.intervalMinutes,
      windowDays: this.cfg.windowDays,
      maxPages: this.cfg.maxPages,
      // How many pages a column will actually be walked for the current window —
      // surfaced so 「只看最近多少天」 is not a black box.
      pageBudget: derivePageBudget(this.cfg.maxPages, this.cfg.windowDays),
      outputMode: this.cfg.output?.mode,
      outputDescription: describeOutput(this.cfg),
      hasCredentials: hasStoredCredentials(),
      credentialUsername: storedUsername(),
      autoLoginPaused: cd.paused,
      autoLoginCooldownMinutes: cd.remainingMinutes,
      autoLoginFailures: cd.failures,
      autoLoginMaxFailures: MAX_AUTO_LOGIN_FAILURES,
      autoLoginLastFailureReason: this.store.getMeta('autoLoginLastFailureReason', null),
      storeSize: this.store.size,
      lastRun: this.store.lastRun,
      recentItems: this.recentItems(),
      events: this.events.slice(-60),
      emailConfigured: Boolean(this.cfg.email?.user && this.cfg.email?.pass && this.cfg.email?.to?.length),
      emailUser: this.cfg.email?.user || '',
      emailTo: (this.cfg.email?.to || []).join(', '),
      emailHasPass: Boolean(this.cfg.email?.pass),
      localDir: this.cfg.output?.localDir || '',
      notifyWhenEmpty: this.cfg.output?.notifyWhenEmpty !== false,
      includeLink: this.cfg.output?.includeLink !== false,
      emptyNotifyIntervalHours: Number(this.cfg.output?.emptyNotifyIntervalHours) || 0,
      windowHidden: this.windowHidden,
      statusPollMs: this.statusPollMs,
      pollMode: this.cfg.poll?.mode || 'task',
      quiet: this.quiet,
      portalStatus: this.store.getMeta('lastStatus', null),
      portalStatusEnabled: this.cfg.portal?.status !== false,
      mailboxEnabled: this.cfg.portal?.mailbox !== false,
      mailboxUrl: this.cfg.portal?.mailBase || DEFAULT_MAIL_BASE,
    };
  }

  /** The most recently forwarded items, newest first (for the GUI list). */
  recentItems(limit = 50) {
    const seen = this.store.state.seen || {};
    return Object.values(seen)
      .filter((r) => r.forwardedAt)
      .sort((a, b) => String(b.forwardedAt).localeCompare(String(a.forwardedAt)))
      .slice(0, limit)
      .map((r) => ({
        key: `${r.treeId}:${r.newsId}`,
        title: r.title,
        date: r.date,
        source: r.source,
        url: r.url,
        forwardedAt: r.forwardedAt,
      }));
  }

  /**
   * Run the whole pipeline once.
   * Concurrent calls are rejected rather than queued, so pressing "立即抓取"
   * twice cannot double-send.
   */
  async runOnce({ dryRun = false, reason = 'manual', notify = () => {} } = {}) {
    if (this.stopped) {
      return {
        ok: false,
        stopped: true,
        error: '抓取已停止，请先点「恢复自动抓取」',
      };
    }
    if (this.busy) {
      return { ok: false, busy: true, error: '已有抓取任务正在进行中' };
    }

    // Cross-process guard: another BUPT-Notify (the scheduled task, or a second
    // panel) may be scraping right now. Refusing is correct — two runs would
    // both see the same items as new and send them twice.
    let lockHandle = null;
    if (this.runLock?.acquire) {
      const got = this.runLock.acquire();
      if (!got?.ok) {
        const error = `${got?.reason || '另一个进程正在抓取'}，请稍后再试`;
        this.pushEvent('warn', error);
        return { ok: false, busy: true, error };
      }
      lockHandle = got;
    }

    this.busy = true;
    this.startedAt = new Date();
    const started = Date.now();
    const token = new CancellationToken();
    this.currentToken = token;
    this.setStage('启动');
    this.pushEvent('info', `开始抓取（${reason}${dryRun ? '，试运行' : ''}）`);

    try {
      // 1. Network
      this.setStage('检查校园网');
      const net = await ensureNetwork(this.cfg, { notify, token });
      if (net.cancelled) return this.#cancelled('network', started);
      if (!net.ok) {
        this.pushEvent('error', `校园网不可达：${net.probe?.error || '未知'}`);
        return this.#finish({
          at: new Date().toISOString(),
          ok: false,
          stage: 'network',
          error: `校园网不可达: ${net.probe?.error || 'unknown'}`,
          durationMs: Date.now() - started,
        });
      }
      this.pushEvent('info', '校园网连通正常');

      // 2. Session
      this.setStage('检查登录状态');
      const login = await this.ensureSession({ notify, token });
      if (login.cancelled) return this.#cancelled('login', started);
      if (!login.ok) {
        this.pushEvent('error', `登录失败：${login.reason || '未知'}`);
        return this.#finish({
          at: new Date().toISOString(),
          ok: false,
          stage: 'login',
          error: login.reason || '登录失败',
          durationMs: Date.now() - started,
        });
      }

      // 3. Collect
      this.setStage('抓取列表');
      const { items, stats, loginRequired, errors } = await collectAll(this.session, this.cfg, this.store, {
        now: new Date(),
        token,
      });

      if (loginRequired) {
        this.pushEvent('error', '抓取过程中会话失效，已中止本轮');
        return this.#finish({
          at: new Date().toISOString(),
          ok: false,
          stage: 'collect',
          error: '抓取时被重定向到登录页（会话可能在过程中失效）',
          stats,
          errors,
          durationMs: Date.now() - started,
        });
      }

      for (const e of errors) this.pushEvent('warn', e);

      // 3b. Extras: 校园卡余额 / 未读邮件数 and unread mail subjects.
      //
      // Read-only and best-effort: a failure here is a warning, never a failed
      // run, because losing the balance line must not cost the notices.
      this.setStage('读取待办中心');
      const extras = await collectExtras(this.session, this.cfg, this.store, {
        now: new Date(),
        token,
      });
      for (const e of extras.errors) this.pushEvent('warn', e);
      Object.assign(stats, extras.stats);
      // Cache the widget read so the panel can show it. `--dry-run` promises
      // "不投递、不记录", so a preview must not touch the state file.
      if (!dryRun) this.store.setMeta('lastStatus', extras.status);
      if (extras.status?.ok && extras.status.error) this.pushEvent('warn', extras.status.error);

      const mails = extras.mails;
      if (mails.length) {
        this.pushEvent('info', `发现 ${mails.length} 封新的未读邮件`);
        for (const m of mails) {
          this.pushEvent('item', `[未读邮件] ${m.sender ? `${m.sender}: ` : ''}${truncate(m.title, 80)}`);
        }
      }

      // 4. Nothing new at all?
      if (!items.length && !mails.length) {
        this.pushEvent('info', '没有需要转发的新内容');
        // `--dry-run` promises 不投递、不记录: do not prune, do not send.
        if (!dryRun) this.store.prune({ windowDays: this.cfg.windowDays });
        const empty = await this.maybeNotifyEmpty({ stats, status: extras.status, dryRun });
        return this.#finish({
          at: new Date().toISOString(),
          ok: true,
          stage: dryRun ? 'dry-run' : 'done',
          dryRun: Boolean(dryRun),
          newItems: 0,
          newMails: 0,
          emptyNotified: Boolean(empty?.sent),
          emptyNotifySkipped: empty?.reason || null,
          stats,
          errors,
          durationMs: Date.now() - started,
        });
      }

      if (items.length) {
        this.pushEvent('info', `发现 ${items.length} 条新内容`);
        for (const it of items) {
          this.pushEvent('item', `[${it.source}] ${it.date || '未知日期'} ${truncate(it.title, 80)}`);
        }
      }

      // 5. Deliver
      if (dryRun) {
        this.pushEvent('info', '[试运行] 不投递、不记录');
        return this.#finish({
          at: new Date().toISOString(),
          ok: true,
          stage: 'dry-run',
          dryRun: true,
          newItems: items.length,
          newMails: mails.length,
          stats,
          errors,
          durationMs: Date.now() - started,
        });
      }

      // Last checkpoint before the irreversible step: if the user stopped while
      // we were collecting, do not send anything.
      token.throwIfCancelled('投递');

      this.setStage('投递');
      const sent = await deliver(items, this.cfg, {
        now: new Date(),
        status: extras.status,
        mails,
      });
      if (sent.ok) {
        const now = new Date();
        for (const it of items) this.store.markForwarded(it, now);
        for (const m of mails) this.store.markForwarded(m, now);
        const bits = [];
        if (items.length) bits.push(`${items.length} 条通知/文件`);
        if (mails.length) bits.push(`${mails.length} 封未读邮件`);
        this.pushEvent('info', `已转发 ${bits.join(' + ')}（${describeOutput(this.cfg)}）`);
      } else {
        this.pushEvent('error', `投递失败：${sent.error}，下次运行会重试`);
      }

      this.store.prune({ windowDays: this.cfg.windowDays });
      return this.#finish({
        at: new Date().toISOString(),
        ok: Boolean(sent.ok),
        stage: 'done',
        newItems: items.length,
        newMails: mails.length,
        emailed: Boolean(sent.email?.ok && !sent.email?.skipped),
        wroteLocal: Boolean(sent.local?.ok),
        localFile: sent.local?.file || null,
        error: sent.error || null,
        stats,
        errors,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      if (isCancellation(err, token)) {
        this.pushEvent('warn', '本轮抓取已被用户停止（未投递任何内容）');
        return this.#cancelled('cancelled', started);
      }
      log.error(`本轮运行出错: ${err.message}`);
      log.debug(err.stack);
      this.pushEvent('error', `本轮运行出错：${err.message}`);
      return this.#finish({
        at: new Date().toISOString(),
        ok: false,
        stage: 'exception',
        error: err.message,
        durationMs: Date.now() - started,
      });
    } finally {
      this.busy = false;
      this.currentToken = null;
      this.setStage(this.stopped ? '已停止' : '空闲');
      if (lockHandle) this.runLock.release?.(lockHandle);
    }
  }

  /**
   * Send the "nothing new" notice, honouring the enable flag and the throttle.
   * Never throws — a failed courtesy mail must not fail the run.
   *
   * `dryRun` suppresses it entirely: 「试运行（不发送）」 must not send anything,
   * and a quiet check with nothing new is exactly when this notice would fire.
   */
  async maybeNotifyEmpty({ stats = null, status = null, dryRun = false } = {}) {
    try {
      if (dryRun) {
        this.pushEvent('info', '[试运行] 不发「无新内容」提醒');
        return { sent: false, reason: 'dry-run' };
      }
      if (this.cfg.output?.mode === 'local') return { sent: false, reason: 'not-configured' };
      if (this.cfg.output?.notifyWhenEmpty === false) return { sent: false, reason: 'disabled' };
      if (!this.cfg.email?.enabled || !this.cfg.email?.user || !this.cfg.email?.pass) {
        return { sent: false, reason: 'email-not-configured' };
      }

      const everyHours = Number(this.cfg.output?.emptyNotifyIntervalHours) || 0;
      if (everyHours > 0) {
        const last = this.store.getMeta('lastEmptyNotifyAt', null);
        if (last) {
          const elapsedH = (Date.now() - new Date(last).getTime()) / 3600000;
          if (elapsedH < everyHours) {
            const wait = Math.ceil(everyHours - elapsedH);
            this.pushEvent('info', `「无新内容」提醒已节流（每 ${everyHours} 小时最多一次，还需约 ${wait} 小时）`);
            return { sent: false, reason: 'throttled' };
          }
        }
      }

      const r = await sendEmptyNotification(this.cfg, {
        now: new Date(),
        nextRunAt: this.nextRunAt,
        stats,
        status,
      });
      if (r.ok && !r.skipped) {
        this.store.setMeta('lastEmptyNotifyAt', new Date().toISOString());
        this.store.save();
        this.pushEvent('info', '已发送「本次没有新内容」提醒邮件');
        return { sent: true };
      }
      if (r.skipped) return { sent: false, reason: 'email-disabled' };
      this.pushEvent('warn', `「无新内容」提醒发送失败：${r.error}`);
      return { sent: false, reason: 'send-failed' };
    } catch (err) {
      log.warn(`发送「无新内容」提醒时出错: ${err.message}`);
      return { sent: false, reason: 'error' };
    }
  }

  setStage(stage) {
    this.stage = stage;
    this.emit('stage', stage);
  }

  /**
   * The panel window was minimised/restored.
   *
   * Scraping keeps running either way — this only throttles the UI's status
   * polling, so a minimised window stops waking the CPU every couple of seconds.
   * GPU memory is not touched here: the panel is launched with the GPU disabled
   * so it never claims VRAM in the first place (see openAppWindow in net.js).
   */
  setWindowHidden(hidden) {
    if (this.windowHidden === hidden) return this.statusPollMs;
    this.windowHidden = hidden;
    this.statusPollMs = hidden ? HIDDEN_STATUS_POLL_MS : VISIBLE_STATUS_POLL_MS;
    log.debug(`控制面板${hidden ? '已最小化' : '已恢复'}，状态轮询间隔 ${this.statusPollMs}ms`);
    return this.statusPollMs;
  }

  /** Build the summary for a run that the user stopped. */
  #cancelled(stage, started) {
    const reason = this.currentToken?.reason || '用户停止';
    return this.#finish({
      at: new Date().toISOString(),
      ok: false,
      cancelled: true,
      stage,
      error: `已停止：${reason}`,
      durationMs: Date.now() - started,
    });
  }

  #finish(summary) {
    this.store.recordRun(summary);
    this.store.save();
    const bits = [`ok=${summary.ok}`, `新增=${summary.newItems ?? 0}`, `${summary.durationMs}ms`];
    this.pushEvent(summary.ok ? 'info' : 'error', `本轮结束：${bits.join(' ')}`);
    this.emit('run-complete', summary);
    return summary;
  }

  /* ------------------------- stop / resume (UI) -------------------------- */

  /**
   * 彻底停止抓取.
   *
   * Three things happen, in order:
   *   1. the scheduler is halted, so no further automatic runs are armed;
   *   2. the in-flight run's token is cancelled, so every checkpoint in the
   *      pipeline aborts (network wait, login wait, pagination, …);
   *   3. the browser context is closed, which makes any Playwright call that is
   *      already blocked (e.g. a page.goto) fail immediately — the hard stop
   *      behind the cooperative one.
   *
   * The process itself stays alive so the panel remains usable and the user can
   * resume. Nothing is ever marked as forwarded by a stopped run.
   */
  async stop({ reason = '用户按下停止' } = {}) {
    const wasBusy = this.busy;
    this.stopped = true;
    this.stopReason = reason;

    this.stopScheduler();

    const token = this.currentToken;
    if (token) token.cancel(reason);

    // Hard stop: drop the browser so blocked calls fail now rather than later.
    await this.session.close().catch((err) => log.debug(`停止时关闭浏览器失败: ${err.message}`));

    this.setStage('已停止');
    this.pushEvent(
      'warn',
      `已停止抓取${wasBusy ? '（当前任务已中断）' : ''}：自动轮询与手动抓取均已停用，点「恢复自动抓取」可继续。`,
    );
    return {
      ok: true,
      stopped: true,
      wasBusy,
      cancelledRun: Boolean(wasBusy && token),
      message: wasBusy ? '已停止，正在中断中的任务也已取消' : '已停止自动抓取',
    };
  }

  /** Re-enable the scheduler after a stop. */
  resume({ runImmediately = false } = {}) {
    if (!this.stopped) return { ok: true, stopped: false, message: '本来就在运行中' };
    this.stopped = false;
    this.stopReason = '';
    this.setStage('空闲');
    this.pushEvent('info', '已恢复自动抓取');
    this.startScheduler({ runImmediately });
    return { ok: true, stopped: false, message: '已恢复自动抓取' };
  }

  /* ------------------------------ scheduling ------------------------------ */

  /** Start the boot run + interval polling loop (non-blocking). */
  startScheduler({ notify = () => {}, runImmediately = true } = {}) {
    if (this.stopped) {
      log.info('调度未启动：抓取处于「已停止」状态。');
      return this;
    }
    const run = async (reason) => {
      if (this.stopped) return;
      try {
        await this.runOnce({ reason, notify });
      } catch (err) {
        log.error(`调度运行失败: ${err.message}`);
      }
    };

    this.stopScheduler();
    this.schedulerActive = true;
    this.schedulerNotify = notify;
    this.pushEvent('info', `调度已启动：每 ${this.cfg.poll.intervalMinutes} 分钟检查一次`);

    // Immediate boot run, then the repeating interval.
    if (runImmediately) run('开机/启动');

    const tick = () => {
      if (this.stopping || !this.schedulerActive || this.stopped) return;
      const intervalMs = Math.max(MIN_INTERVAL_MINUTES, this.cfg.poll.intervalMinutes) * 60 * 1000;
      const jitterMs = Math.max(0, this.cfg.poll.jitterSeconds || 0) * 1000;
      const delay = intervalMs + Math.floor(Math.random() * jitterMs);
      this.nextRunAt = new Date(Date.now() + delay);
      this.timer = setTimeout(async () => {
        await run('定时检查');
        tick();
      }, delay);
      if (this.timer.unref) this.timer.unref();
    };
    tick();
    return this;
  }

  stopScheduler() {
    this.schedulerActive = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextRunAt = null;
  }

  /** Wait for the current run (if any) to finish — used on shutdown. */
  async drain() {
    while (this.busy) await sleep(200);
  }

  /** Apply a settings patch from the GUI, persist it, and re-arm the schedule. */
  applySettings(patch = {}) {
    const applied = [];
    const errors = [];

    if (patch.intervalMinutes !== undefined) {
      const n = Number(patch.intervalMinutes);
      if (!Number.isFinite(n) || n < MIN_INTERVAL_MINUTES || n > MAX_INTERVAL_MINUTES) {
        errors.push(`抓取间隔必须在 ${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES} 分钟之间`);
      } else {
        this.cfg.poll.intervalMinutes = n;
        applied.push(`抓取间隔 = ${n} 分钟`);
      }
    }
    if (patch.windowDays !== undefined) {
      const n = Number(patch.windowDays);
      if (!Number.isFinite(n) || n < 1 || n > 365) errors.push('时间窗口必须在 1–365 天之间');
      else {
        this.cfg.windowDays = n;
        applied.push(`时间窗口 = ${n} 天`);
      }
    }
    if (patch.outputMode !== undefined) {
      if (!['local', 'email', 'both'].includes(patch.outputMode)) errors.push('outputMode 非法');
      else {
        this.cfg.output.mode = patch.outputMode;
        this.cfg.email.enabled = patch.outputMode !== 'local';
        applied.push(`获取方式 = ${patch.outputMode}`);
      }
    }
    if (patch.emailTo !== undefined) {
      const list = String(patch.emailTo)
        .split(/[,，;；\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (list.length && !list.every((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) {
        errors.push('收件邮箱格式不正确');
      } else {
        this.cfg.email.to = list;
        applied.push(`收件邮箱 = ${list.join(', ') || '(空)'}`);
      }
    }
    if (patch.includeLink !== undefined) {
      this.cfg.output.includeLink = Boolean(patch.includeLink);
      applied.push(`附带链接 = ${this.cfg.output.includeLink}`);
    }
    if (patch.notifyWhenEmpty !== undefined) {
      this.cfg.output.notifyWhenEmpty = Boolean(patch.notifyWhenEmpty);
      applied.push(`无新内容也发邮件 = ${this.cfg.output.notifyWhenEmpty ? '开' : '关'}`);
    }
    if (patch.emptyNotifyIntervalHours !== undefined) {
      const n = Number(patch.emptyNotifyIntervalHours);
      if (!Number.isFinite(n) || n < 0 || n > 168) errors.push('「无新内容」提醒间隔必须在 0–168 小时之间');
      else {
        this.cfg.output.emptyNotifyIntervalHours = n;
        applied.push(`提醒间隔 = ${n === 0 ? '每次检查' : `每 ${n} 小时最多一次`}`);
      }
    }
    if (patch.portalStatus !== undefined) {
      this.cfg.portal.status = Boolean(patch.portalStatus);
      applied.push(`附带校园卡余额/未读邮件数 = ${this.cfg.portal.status ? '开' : '关'}`);
    }
    if (patch.mailbox !== undefined) {
      this.cfg.portal.mailbox = Boolean(patch.mailbox);
      applied.push(`转发未读邮件标题 = ${this.cfg.portal.mailbox ? '开' : '关'}`);
    }
    if (patch.emailUser !== undefined) {
      const u = String(patch.emailUser).trim();
      if (u && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u)) errors.push('发件邮箱格式不正确');
      else {
        this.cfg.email.user = u;
        this.cfg.email.from = u;
        applied.push(`发件邮箱 = ${u || '(空)'}`);
      }
    }
    if (patch.emailPass !== undefined) {
      // QQ authorisation codes are 16 chars; accept only whitespace stripping.
      const p = String(patch.emailPass).replace(/\s+/g, '');
      this.cfg.email.pass = p;
      applied.push(`授权码 = ${p ? `${p.length} 位（已保存）` : '(已清空)'}`);
    }

    if (applied.length) {
      saveConfig(this.cfg, this.configPath ? { path: this.configPath } : {});
      if (patch.intervalMinutes !== undefined && this.schedulerActive && !this.stopped) {
        // Re-arm with the new interval, but do NOT fire an immediate run just
        // because a setting changed.
        this.stopScheduler();
        this.startScheduler({ notify: this.schedulerNotify || (() => {}), runImmediately: false });
      }
      this.pushEvent('info', `设置已更新：${applied.join('；')}`);
    }

    return { ok: errors.length === 0, applied, errors };
  }
}

export { MAX_AUTO_LOGIN_FAILURES, AUTO_LOGIN_COOLDOWN_MS };
