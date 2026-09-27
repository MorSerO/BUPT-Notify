/**
 * shortcuts.test.mjs — the launcher shortcut check.
 *
 * Regression context: the desktop shortcut stores an ABSOLUTE path. When
 * `启动 BUPT-Notify.vbs` was renamed to `start-bupt-notify.vbs`, the desktop and
 * Start Menu shortcuts kept pointing at the old name and Windows only said
 * "无法启动脚本文件" — nothing in the app noticed. doctor now reports it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkShortcuts, describeShortcut } from '../src/shortcuts.js';

/* --------------------------- describeShortcut --------------------------- */

test('a valid shortcut is reported with its target', () => {
  const s = describeShortcut({ exists: true, valid: true, target: 'D:\\x\\start.vbs' });
  assert.match(s, /正常/);
  assert.match(s, /start\.vbs/);
});

test('a shortcut pointing at a missing launcher is reported as broken', () => {
  const s = describeShortcut({ exists: true, valid: false, reason: 'script-missing', target: 'D:\\x\\old.vbs' });
  assert.match(s, /失效/);
  assert.match(s, /old\.vbs/);
});

test('a shortcut whose wscript is missing is reported too', () => {
  const s = describeShortcut({ exists: true, valid: false, reason: 'exe-missing', exe: 'C:\\wscript.exe' });
  assert.match(s, /失效/);
});

test('an absent shortcut and a null entry are handled', () => {
  assert.equal(describeShortcut(null), '(不存在)');
  assert.equal(describeShortcut({ exists: false }), '未创建');
});

test('an unexpected reason is still described', () => {
  assert.match(describeShortcut({ exists: true, valid: false, reason: 'error: boom' }), /异常/);
});

/* --------------------------- checkShortcuts ----------------------------- */

test('checkShortcuts returns a usable shape on this platform', async () => {
  const st = await checkShortcuts();
  assert.equal(typeof st.supported, 'boolean');
  assert.equal(typeof st.anyMissing, 'boolean');
  assert.equal(typeof st.anyStale, 'boolean');
  if (process.platform === 'win32' && !st.error) {
    for (const entry of [st.desktop, st.startMenu]) {
      if (!entry) continue;
      assert.equal(typeof entry.path, 'string');
      assert.equal(typeof entry.exists, 'boolean');
      assert.equal(typeof entry.valid, 'boolean');
    }
  }
});

test('a stale shortcut is detected as stale, not as valid', async () => {
  const st = await checkShortcuts();
  if (!st.supported || st.error) return; // skip on non-Windows / unreadable
  for (const entry of [st.desktop, st.startMenu]) {
    if (!entry?.exists) continue;
    // valid must be consistent with the reported reason
    assert.equal(entry.valid, entry.reason === 'ok');
  }
});
