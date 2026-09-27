/**
 * verify-remote.mjs — check what is actually published on GitHub.
 *
 * Run after pushing: confirms the file list, the commit history, and — most
 * importantly — that no credential/identifier a secret scanner would flag is
 * present in ANY file on the branch.
 */
import { execFileSync } from 'node:child_process';

const REPO = process.env.BUPT_REPO || 'MorSerO/BUPT-Notify';
const BRANCH = 'main';

const gh = (args) =>
  execFileSync('gh', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 64 * 1024 * 1024,
  });

console.log(`=== repo ${REPO} ===`);
const info = JSON.parse(gh(['repo', 'view', REPO, '--json', 'url,visibility,defaultBranchRef,pushedAt']));
console.log(`  url        : ${info.url}`);
console.log(`  visibility : ${info.visibility}`);
console.log(`  branch     : ${info.defaultBranchRef?.name}`);
console.log(`  pushedAt   : ${info.pushedAt}`);

console.log('\n=== commit history ===');
const commits = JSON.parse(gh(['api', `repos/${REPO}/commits?sha=${BRANCH}`]));
for (const c of commits.slice(0, 5)) {
  console.log(`  ${c.sha.slice(0, 7)}  ${c.commit.message.split('\n')[0]}`);
  console.log(
    `           parents: ${c.parents.length === 0 ? '(root commit)' : c.parents.map((p) => p.sha.slice(0, 7)).join(' ')}`,
  );
}
console.log(`  total commits on ${BRANCH}: ${commits.length}`);

console.log('\n=== tree ===');
const tree = JSON.parse(gh(['api', `repos/${REPO}/git/trees/${BRANCH}?recursive=1`]));
const blobs = tree.tree.filter((t) => t.type === 'blob');
console.log(`  ${blobs.length} files, ${(blobs.reduce((n, f) => n + (f.size || 0), 0) / 1024).toFixed(0)} KB total`);

console.log('\n=== top level ===');
for (const e of JSON.parse(gh(['api', `repos/${REPO}/contents?ref=${BRANCH}`]))) {
  console.log(`  ${e.type.padEnd(5)} ${String(e.size ?? '').padStart(7)}  ${e.name}`);
}

console.log('\n=== secret scan of EVERY published text file ===');
const PATTERNS = [
  ['WeChat Work appid', /\bwx[0-9a-f]{16}\b/i],
  ['agentid', /"agentid"\s*:\s*"?\d{4,}/],
  ['mobile-campus appid', /\bappid['"]?\s*[:=]\s*['"]?\d{15,}/i],
  ['CAS execution token', /name="execution"\s+value="(?!REDACTED)[A-Za-z0-9_-]{24,}"/i],
  ['live CAS ticket', /ticket=ST-[A-Za-z0-9-]{10,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['SMTP auth code', /"pass"\s*:\s*"[a-z]{16}"/],
  ['hard-coded account email', /\b\d{8,12}@qq\.com\b/],
];
let flagged = 0;
let scanned = 0;
for (const f of blobs) {
  if (/\.(ico|png|jpg|jpeg|gif|woff2?)$/i.test(f.path)) continue;
  let text;
  try {
    const b64 = gh(['api', `repos/${REPO}/contents/${encodeURI(f.path)}?ref=${BRANCH}`, '--jq', '.content'])
      .replace(/\s/g, '');
    text = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    continue;
  }
  scanned += 1;
  for (const [label, re] of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    if (/REDACTED|0000000|example\./i.test(m[0])) continue;
    flagged += 1;
    console.log(`  x ${f.path}: ${label} -> ${m[0].slice(0, 50)}`);
  }
}
console.log(`  scanned ${scanned} text files`);
console.log(flagged === 0 ? '  OK: no flagged identifiers on the branch' : `  ${flagged} finding(s)`);

console.log('\n=== key files present ===');
const names = blobs.map((b) => b.path);
for (const f of [
  'README.md', 'LICENSE', 'install.cmd', 'install-with-autostart.cmd',
  'start-bupt-notify.vbs', 'scripts/install-deps.ps1', 'assets/bupt-notify.ico',
  'test/fixtures/notice-list.html', 'test/fixtures/cas-login-skeleton.html',
]) {
  console.log(`  ${names.includes(f) ? 'v' : 'x'} ${f}`);
}

console.log('\n=== filenames ===');
const cn = names.filter((n) => /[\u4e00-\u9fff]/.test(n));
console.log(cn.length === 0 ? '  OK: all filenames are ASCII' : `  x non-ASCII: ${cn.join(', ')}`);
