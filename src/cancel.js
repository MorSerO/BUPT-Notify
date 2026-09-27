/**
 * cancel.js — cooperative cancellation for a scraping run.
 *
 * A run can be blocked for a long time in several places:
 *   - `ensureNetwork` waits up to 15 minutes for the VPN to come up
 *   - `ensureLoggedIn` waits up to 10 minutes for a manual CAS login
 *   - the collector loops over pages, fetching each one
 *   - the login flow polls the page once a second
 *
 * So "stop" cannot just set a flag that is checked at the start of the next
 * run — every one of those waits has to be interruptible. This module provides
 * a tiny token that is threaded through all of them:
 *
 *   token.throwIfCancelled()          -> throws CancelledError at a checkpoint
 *   sleep(ms, { token })              -> resolves early when cancelled
 *   token.onCancel(fn)                -> run a cleanup hook immediately
 *
 * `App.stop()` additionally closes the browser context, which makes any
 * in-flight Playwright call fail at once — that is the hard stop behind the
 * cooperative one.
 */

export class CancelledError extends Error {
  constructor(reason = '操作已取消') {
    super(reason);
    this.name = 'CancelledError';
    this.cancelled = true;
  }
}

export class CancellationToken {
  constructor({ onCancel } = {}) {
    this.cancelled = false;
    this.reason = '';
    this.cancelledAt = null;
    /** @type {Set<Function>} */
    this._listeners = new Set();
    if (onCancel) this.onCancel(onCancel);
  }

  /** Cancel the run. Returns true only for the first call. */
  cancel(reason = '已取消') {
    if (this.cancelled) return false;
    this.cancelled = true;
    this.reason = String(reason);
    this.cancelledAt = new Date();
    const listeners = [...this._listeners];
    this._listeners.clear();
    for (const fn of listeners) {
      try {
        fn(this.reason);
      } catch {
        /* a failing cleanup hook must not block the others */
      }
    }
    return true;
  }

  /** Register an immediate cleanup hook. Fires right away if already cancelled. */
  onCancel(fn) {
    if (this.cancelled) {
      try {
        fn(this.reason);
      } catch {
        /* ignore */
      }
      return () => {};
    }
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** Throw CancelledError if this run has been cancelled. */
  throwIfCancelled(what = '操作') {
    if (this.cancelled) throw new CancelledError(`${what}已停止（${this.reason}）`);
    return undefined;
  }

  get isCancelled() {
    return this.cancelled;
  }

  /** AbortSignal view, for APIs that accept one. */
  get abortSignal() {
    if (!this._abort) {
      this._abort = new AbortController();
      if (this.cancelled) this._abort.abort();
      else this.onCancel(() => this._abort.abort());
    }
    return this._abort.signal;
  }
}

/** True for our cancellation error, or for a Playwright error caused by one. */
export function isCancellation(err, token) {
  if (!err) return false;
  if (err instanceof CancelledError || err.name === 'CancelledError') return true;
  if (token?.cancelled) {
    // Closing the browser mid-flight surfaces as these; treat them as cancelled.
    return /Target (page|closed)|browser has been closed|Context closed|has been closed|Execution context was destroyed/i.test(
      String(err.message || ''),
    );
  }
  return false;
}

/**
 * Cancellable sleep. Resolves early (and reports it) when the token fires.
 * @returns {Promise<boolean>} true if it slept fully, false if cancelled
 */
export function cancellableSleep(ms, token, { sliceMs = 200 } = {}) {
  if (token?.cancelled) return Promise.resolve(false);
  return new Promise((resolve) => {
    const started = Date.now();
    let timer = null;
    let off = null;
    let done = false;

    const finish = (slept) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (off) off();
      resolve(slept);
    };

    const tick = () => {
      if (done) return;
      if (token?.cancelled) return finish(false);
      const elapsed = Date.now() - started;
      if (elapsed >= ms) return finish(true);
      // NOTE: deliberately NOT unref'd. A sleep is real pending work: if it were
      // unref'd and nothing else kept the event loop alive, Node would exit with
      // an "unsettled top-level await" while a run was still in progress.
      timer = setTimeout(tick, Math.min(sliceMs, ms - elapsed));
    };

    // Register first, then start ticking: if the token is already cancelled the
    // hook fires synchronously and `done` stops tick() from arming a timer.
    if (token) off = token.onCancel(() => finish(false));
    tick();
  });
}
