/**
 * lint.mjs — real, honest checks (no heuristics that produce false positives).
 *
 *  1. every .js / .mjs file parses (node --check equivalent, done in-process)
 *  2. no merge-conflict markers
 *  3. no absolute machine-specific paths committed
 *  4. every module actually imports (catches broken imports/exports)
 *  5. required project files exist
 *
 * Run: npm run lint
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => {
  failures += 1;
  console.log(`  ✗ ${m}`);
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = [
  ...walk(path.join(ROOT, 'src')),
  ...walk(path.join(ROOT, 'scripts')),
  ...walk(path.join(ROOT, 'test')),
  ...walk(path.join(ROOT, 'tools')),
];
console.log(`\n[1] syntax of ${files.length} files`);
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) bad(`${path.relative(ROOT, f)}: ${(r.stderr || '').split('\n')[0]}`);
}
if (failures === 0) ok('all files parse');

console.log('\n[2] conflict markers / stray logs');
let markerHits = 0;
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  if (/^(<{7}|={7}|>{7})/m.test(s)) {
    bad(`${path.relative(ROOT, f)} has merge conflict markers`);
    markerHits += 1;
  }
}
if (markerHits === 0) ok('no conflict markers');

console.log('\n[3] no machine-specific absolute paths in tracked source');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ignore = new Set(['package-lock.json']);
let pathHits = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f);
  if (ignore.has(rel)) continue;
  const s = fs.readFileSync(f, 'utf8');
  // Look for a hard-coded drive path pointing at a user profile.
  if (/[A-Za-z]:\\\\?Users\\\\?[A-Za-z]/i.test(s) || /D:\\BUPT-Notify/i.test(s)) {
    bad(`${rel} contains an absolute local path`);
    pathHits += 1;
  }
}
if (pathHits === 0) ok('no absolute local paths');

console.log('\n[4] modules import cleanly');
const modules = [
  'util', 'logger', 'config', 'vsb', 'store', 'cancel', 'net', 'fetcher',
  'collector', 'mailer', 'output', 'secrets', 'app', 'server', 'httpLogin',
  'httpSession', 'autostart',
];
for (const m of modules) {
  try {
    await import(pathToFileURL(path.join(ROOT, 'src', `${m}.js`)).href);
  } catch (err) {
    bad(`src/${m}.js failed to import: ${err.message.split('\n')[0]}`);
  }
}
if (failures === 0) ok(`all ${modules.length} modules import`);

console.log('\n[5] required files');
const required = [
  'package.json', 'README.md', 'LICENSE', '.gitignore',
  'config.example.json', 'start-bupt-notify.vbs',
  'scripts/install-deps.ps1', 'scripts/create-shortcut.ps1',
  'src/ui/index.html',
  'test/fixtures/notice-list.html',
];
for (const f of required) {
  if (!fs.existsSync(path.join(ROOT, f))) bad(`missing ${f}`);
}
if (failures === 0) ok('all required files present');

console.log('\n[6] package.json scripts referenced by the README exist');
const scripts = new Set(Object.keys(pkg.scripts || {}));
for (const name of ['ui', 'start', 'test', 'shortcut', 'autostart', 'unautostart', 'doctor', 'setup', 'lint']) {
  if (!scripts.has(name)) bad(`package.json is missing the "${name}" script`);
}
if (failures === 0) ok('all documented npm scripts exist');

console.log(failures === 0 ? '\n全部检查通过 ✓\n' : `\n${failures} 项失败 ✗\n`);
process.exit(failures === 0 ? 0 : 1);
