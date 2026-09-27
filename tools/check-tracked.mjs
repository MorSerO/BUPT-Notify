// Which files that the app NEEDS are missing from git?
// Compares the working tree against `git ls-files`, so anything excluded by an
// over-broad .gitignore rule shows up instead of silently missing from a clone.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true, ...opts });

const tracked = new Set(git(['ls-files']).split('\n').filter(Boolean));

// Every file the app ships, excluding local/generated state.
const SKIP = /^(node_modules|\.npm-cache|\.git|data|logs|output)\//;
const SKIP_FILE = /^(config\.json|config\.json\.bak|\.node-path|commit-message\.txt|\.commit-message\.txt)$/;
// Generated at install time by scripts/install-autostart.ps1 — correctly ignored.
const SKIP_PATH = /^(reference-|tools\/out\/|scripts\/run-hidden\.vbs$)/;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = path.relative('.', p).split(path.sep).join('/');
    if (/^(node_modules|\.git|\.npm-cache|data|logs|output)/.test(rel)) continue;
    if (e.isDirectory()) walk(p, out);
    else out.push(rel);
  }
  return out;
}

const all = walk('.');
const missing = [];
const ignoredByRule = new Map();

for (const rel of all) {
  if (SKIP.test(rel) || SKIP_FILE.test(rel) || SKIP_PATH.test(rel)) continue;
  if (tracked.has(rel)) continue;
  missing.push(rel);
  // Which rule is responsible?
  try {
    const why = git(['check-ignore', '-v', '--', rel]).trim();
    const rule = why.split('\t')[0] || '(unknown)';
    if (!ignoredByRule.has(rule)) ignoredByRule.set(rule, []);
    ignoredByRule.get(rule).push(rel);
  } catch {
    ignoredByRule.set('(not ignored — never added)', [
      ...(ignoredByRule.get('(not ignored — never added)') || []),
      rel,
    ]);
  }
}

console.log(`tracked files: ${tracked.size}`);
console.log(`working-tree files (excluding local state): ${all.length}`);
console.log(`MISSING FROM GIT: ${missing.length}\n`);

for (const [rule, files] of ignoredByRule) {
  console.log(`  rule ${rule}`);
  for (const f of files) console.log(`      ${f}`);
}

// The one that actually breaks a clone.
const critical = missing.filter((f) => /^(src\/|assets\/|scripts\/|test\/|package\.json|README|LICENSE)/.test(f));
console.log(`\nCRITICAL missing (app would not run from a clone): ${critical.length}`);
for (const f of critical) console.log(`  ! ${f}`);

process.exit(critical.length === 0 ? 0 : 1);
