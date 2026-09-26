/**
 * lock.test.mjs — the single-instance / single-run lock.
 *
 * The regression this guards: an idle control panel used to hold the lock for
 * its whole lifetime, so every scheduled run logged 「已有实例在运行」and skipped
 * while the task still reported success. The panel now locks per run instead, and
 * a lock left behind by a force-killed process must not block anything forever.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireLock, releaseLock, readLock, pidAlive, withLock } from '../src/lock.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-lock-')), 'test.lock');

test('acquire writes our pid and release removes the file', () => {
  const file = tmp();
  const r = acquireLock({ file });
  assert.equal(r.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
  releaseLock({ file });
  assert.equal(fs.existsSync(file), false);
});

test('a lock held by a LIVE process is refused', async () => {
  const file = tmp();
  // A real second process, so pidAlive() has something alive to find.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(file, String(child.pid), 'utf8');
    const r = acquireLock({ file });
    assert.equal(r.ok, false, 'must not steal a live lock');
    assert.match(r.reason, new RegExp(`pid ${child.pid}`));
  } finally {
    child.kill();
    releaseLock({ file });
  }
});

test('a lock left by a DEAD process is taken over', () => {
  const file = tmp();
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const deadPid = child.pid;
  return new Promise((resolve) => {
    child.on('exit', () => {
      // Give the OS a moment to reap it.
      setTimeout(() => {
        fs.writeFileSync(file, String(deadPid), 'utf8');
        assert.equal(pidAlive(deadPid), false, 'the helper really is gone');
        const r = acquireLock({ file });
        assert.equal(r.ok, true, 'a stale lock must not block the app forever');
        assert.equal(r.stale, true);
        assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
        releaseLock({ file });
        resolve();
      }, 200);
    });
  });
});

test('a garbage or empty lock file is taken over, not obeyed', () => {
  const file = tmp();
  for (const junk of ['', '   ', 'not-a-pid', '-1', '0']) {
    fs.writeFileSync(file, junk, 'utf8');
    const r = acquireLock({ file });
    assert.equal(r.ok, true, `junk ${JSON.stringify(junk)} must not block`);
    releaseLock({ file });
  }
});

test('readLock reports nothing when there is no file', () => {
  assert.equal(readLock(path.join(os.tmpdir(), 'bupt-lock-absent-xyz.lock')), null);
});

test('release only unlinks our own lock', () => {
  const file = tmp();
  fs.writeFileSync(file, '999999', 'utf8');
  releaseLock({ file });
  assert.equal(fs.existsSync(file), true, 'someone else’s lock is left alone');
  fs.unlinkSync(file);
});

test('re-acquiring our own lock is idempotent', () => {
  const file = tmp();
  assert.equal(acquireLock({ file }).ok, true);
  assert.equal(acquireLock({ file }).ok, true, 'we already hold it');
  releaseLock({ file });
});

test('withLock runs the body and always releases', async () => {
  const file = tmp();
  const ok = await withLock(async () => 'done', { file });
  assert.equal(ok, 'done');
  assert.equal(fs.existsSync(file), false, 'released after success');

  await assert.rejects(
    withLock(async () => {
      throw new Error('boom');
    }, { file }),
    /boom/,
  );
  assert.equal(fs.existsSync(file), false, 'released after a throw');
});

test('withLock reports busy instead of running when the lock is taken', async () => {
  const file = tmp();
  fs.writeFileSync(file, String(process.pid), 'utf8');
  // Our own pid counts as "held by us", so simulate a foreign live holder.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(file, String(child.pid), 'utf8');
    let ran = false;
    const r = await withLock(async () => {
      ran = true;
    }, { file });
    assert.equal(ran, false, 'the body must not run');
    assert.equal(r.ok, false);
    assert.equal(r.busy, true);
  } finally {
    child.kill();
    fs.rmSync(file, { force: true });
  }
});
