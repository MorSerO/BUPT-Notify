/**
 * smoke.mjs — offline end-to-end verification.
 *
 * Runs the real pipeline (network probe aside) with a fake browser session
 * serving the fixture, then confirms:
 *   - the concise local digest is written
 *   - the store records forwarded items
 *   - a second run forwards nothing
 *   - simulated email failure still retries
 *
 * This exercises main.js's logic path without needing Chrome/VPN/CAS.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAll } from '../src/collector.js';
import { deliver } from '../src/output.js';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { initLogger } from '../src/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(here, '..', 'test', 'fixtures', 'notice-list.html'), 'utf8');
const NOW = new Date(2026, 8, 25, 21, 30, 0);

initLogger({ level: 'info', file: false, console: true });

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bupt-smoke-'));
const cfg = loadConfig({ quiet: true });
cfg.output.mode = 'local';
cfg.output.localDir = path.join(workDir, 'output');
cfg.email.enabled = false;
cfg.windowDays = 10;
cfg.maxPages = 1;

let failures = 0;
const check = (label, cond, extra = '') => {
  const ok = Boolean(cond);
  if (!ok) failures += 1;
  console.log(`${ok ? '  [OK]' : '  [FAIL]'} ${label}${extra ? ` — ${extra}` : ''}`);
};

const session = {
  async fetchHtml(url) {
    return { html: fixture, status: 200, finalUrl: url };
  },
};

console.log('\n=== 1. 首次运行：抓取 + 写入本地 ===');
const store = new Store({ file: path.join(workDir, 'state.json') });
const first = await collectAll(session, cfg, store, { now: NOW });
console.log(`  解析到 ${first.items.length} 条新内容`);
check('抓到 5 条窗口内新内容', first.items.length === 5, `实际 ${first.items.length}`);
check('未触发登录要求', first.loginRequired === false);

const d1 = await deliver(first.items, cfg, { now: NOW });
check('本地投递成功', d1.ok, d1.error || '');
for (const it of first.items) store.markForwarded(it, NOW);
store.prune({ windowDays: cfg.windowDays, today: '2026-09-25' });

const digestFile = d1.local?.file;
check('生成了本地 Markdown 文件', digestFile && fs.existsSync(digestFile), digestFile || '');
const text = digestFile ? fs.readFileSync(digestFile, 'utf8') : '';
check('文件含标题', text.includes('关于2026年国庆节放假安排的通知'));
check('文件含抓取时间', /抓取 \d{4}\/\d{2}\/\d{2}/.test(text), (text.match(/抓取 [\d/ :]+/) || [])[0] || '');
check('文件不含正文（简洁要求）', !text.includes('根据国务院办公厅通知精神'));
check('文件含原文链接', text.includes('wbnewsid=142501'));

console.log('\n=== 2. 第二次运行：不应重复转发 ===');
const second = await collectAll(session, cfg, store, { now: NOW });
check('第二次无新内容', second.items.length === 0, `实际 ${second.items.length}`);
check('统计显示已转发跳过', second.stats.alreadyForwarded === 5, `实际 ${second.stats.alreadyForwarded}`);

console.log('\n=== 3. 模拟投递失败：应可重试 ===');
const store2 = new Store({ file: path.join(workDir, 'state2.json') });
const f1 = await collectAll(session, cfg, store2, { now: NOW });
for (const it of f1.items) store2.markSeen(it, NOW); // seen but NOT forwarded
const f2 = await collectAll(session, cfg, store2, { now: NOW });
check('失败后仍可重试全部 5 条', f2.items.length === 5, `实际 ${f2.items.length}`);

console.log('\n=== 4. 跨重启去重 ===');
store.save();
const reloaded = new Store({ file: store.file });
const third = await collectAll(session, cfg, reloaded, { now: NOW });
check('重启后仍不重复转发', third.items.length === 0, `实际 ${third.items.length}`);

console.log('\n=== 5. 配置校验 ===');
const problems = (await import('../src/config.js')).validateConfig(cfg);
check('local 模式下不需要邮箱配置', problems.length === 0, problems.join('; '));

console.log(`\n输出目录: ${cfg.output.localDir}`);
console.log(failures === 0 ? '\n全部检查通过 ✓\n' : `\n${failures} 项检查失败 ✗\n`);
process.exit(failures === 0 ? 0 : 1);
