// Validate the VSB parser against the user's real saved portal homepage.
import fs from 'node:fs';
import path from 'node:path';
import { parseListPage, extractArticle, looksLikeLoginPage } from '../src/vsb.js';

const fixture = process.argv[2] || 'test/fixtures/notice-list.html';
const html = fs.readFileSync(fixture, 'utf8');
console.log(`fixture: ${fixture} (${html.length} bytes)`);
console.log('looksLikeLoginPage:', looksLikeLoginPage(html));

const all = parseListPage(html, { source: 'homepage' });
console.log(`\nparsed items: ${all.length}`);

const byTree = new Map();
for (const it of all) {
  if (!byTree.has(it.treeId)) byTree.set(it.treeId, []);
  byTree.get(it.treeId).push(it);
}
console.log('trees:', [...byTree.entries()].map(([t, v]) => `${t}(${v.length})`).join(' '));

for (const tree of ['2001', '1154', '1221']) {
  const items = byTree.get(tree) || [];
  console.log(`\n${'='.repeat(72)}\n=== tree ${tree}: ${items.length} items\n${'='.repeat(72)}`);
  for (const it of items.slice(0, 12)) {
    console.log(`  ${it.date ?? '(无日期)'}  [${it.newsId}]  ${it.title}`);
    console.log(`      ${it.url}`);
  }
}

// Sanity checks
console.log('\n--- SANITY ---');
const missingDate = all.filter((i) => !i.date);
console.log('items without a date:', missingDate.length);
if (missingDate.length) console.log(' e.g.', missingDate.slice(0, 5).map((i) => `${i.treeId}:${i.newsId} "${i.title}"`));
const emptyTitle = all.filter((i) => !i.title);
console.log('items without a title:', emptyTitle.length);
const keys = all.map((i) => i.key);
console.log('duplicate keys:', keys.length - new Set(keys).size);
