// Verify every in-page anchor in README.md resolves to a heading, using
// GitHub's slug algorithm (lowercase, drop punctuation, spaces -> hyphens).
import fs from 'node:fs';

const md = fs.readFileSync('README.md', 'utf8');

function slug(text) {
  return text
    .trim()
    .toLowerCase()
    // GitHub keeps CJK, letters, digits, hyphens and underscores.
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

const headings = [...md.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1].trim());
const slugs = new Set(headings.map(slug));

const anchors = [...md.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
const unique = [...new Set(anchors)];

let bad = 0;
for (const a of unique) {
  if (!slugs.has(a)) {
    bad += 1;
    console.log(`✗ broken anchor: #${a}`);
    // Suggest the closest heading.
    const near = headings.filter((h) => slug(h).includes(a.slice(0, 4))).slice(0, 3);
    if (near.length) console.log(`    did you mean: ${near.map((h) => `#${slug(h)}`).join('  ')}`);
  }
}
console.log(`\n${headings.length} headings, ${unique.length} unique anchors, ${bad} broken`);
process.exit(bad === 0 ? 0 : 1);
