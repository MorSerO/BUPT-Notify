/**
 * push-via-api.mjs — publish the current commit to GitHub using the Git Data API.
 *
 * WHY: `git push` needs github.com:443, which is unreachable from this network
 * right now (api.github.com works fine). This rebuilds the branch over the API:
 *
 *   for each tracked file -> create a blob
 *   all blobs             -> create a tree (no base_tree, so nothing old survives)
 *   tree                  -> create a root commit (no parents)
 *   commit                -> force-update refs/heads/main
 *
 * Because the new commit has NO parents, the previous history becomes
 * unreachable — which is the point: it purged the third-party app id that the
 * secret scanner flagged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = 'MorSerO/BUPT-Notify';
const BRANCH = 'main';
const MESSAGE_FILE = process.argv[2] || '.commit-message.txt';

const gh = (args, { input = null } = {}) =>
  execFileSync('gh', args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180000,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });

/**
 * POST/PATCH JSON via `gh api`.
 *
 * The body is written to a temp file and passed with --input: piping it through
 * stdin (`--input -`) did not survive execFileSync on Windows.
 */
let tmpCounter = 0;
const api = (method, endpoint, body) => {
  const tmp = path.join(
    process.env.TEMP || '.',
    `bupt-api-${process.pid}-${(tmpCounter += 1)}.json`,
  );
  fs.writeFileSync(tmp, JSON.stringify(body), 'utf8');
  try {
    const out = gh(['api', '--method', method, endpoint, '--input', tmp]);
    return out.trim() ? JSON.parse(out) : null;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
};

// ---- collect files ---------------------------------------------------------
// NOTE: git, not gh — `gh ls-files` does not exist.
const lsFiles = execFileSync('git', ['ls-files', '-s'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const files = lsFiles.map((line) => {
  // "<mode> <sha> <stage>\t<path>"
  const [meta, ...rest] = line.split('\t');
  const [mode, sha] = meta.trim().split(/\s+/);
  return { mode, sha, path: rest.join('\t') };
});
console.log(`preparing ${files.length} files`);

const message = fs.existsSync(MESSAGE_FILE)
  ? fs.readFileSync(MESSAGE_FILE, 'utf8').trim()
  : 'feat: 北邮校内通知/校内文件 自动转发助手';

// ---- create blobs ----------------------------------------------------------
// Content is read back OUT OF GIT (`git cat-file blob <sha>`), not from disk.
// Reading from disk published working-tree bytes — including uncommitted edits
// and platform line endings — which made the published files differ from the
// commit. Publishing what git has keeps local and remote byte-identical.
const tree = [];
let done = 0;
for (const f of files) {
  let buf;
  try {
    buf = execFileSync('git', ['cat-file', 'blob', f.sha], {
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (err) {
    throw new Error(`cannot read blob for ${f.path}: ${err.message}`);
  }
  const blob = api('POST', `repos/${REPO}/git/blobs`, {
    content: buf.toString('base64'),
    encoding: 'base64',
  });
  if (!blob?.sha) throw new Error(`blob upload failed for ${f.path}`);
  tree.push({
    path: f.path,
    mode: f.mode === '100755' ? '100755' : '100644',
    type: 'blob',
    sha: blob.sha,
  });
  done += 1;
  if (done % 10 === 0 || done === files.length) console.log(`  ${done}/${files.length} blobs`);
  await new Promise((r) => setTimeout(r, 60)); // be gentle with the API
}

// ---- tree ------------------------------------------------------------------
console.log('creating tree…');
const newTree = api('POST', `repos/${REPO}/git/trees`, { tree });
console.log(`  tree ${newTree.sha.slice(0, 10)} (${newTree.tree.length} entries)`);

// ---- commit (root: no parents) --------------------------------------------
console.log('creating commit…');
const commit = api('POST', `repos/${REPO}/git/commits`, {
  message,
  tree: newTree.sha,
  parents: [],
});
console.log(`  commit ${commit.sha.slice(0, 10)}`);

// ---- update the branch -----------------------------------------------------
console.log(`updating refs/heads/${BRANCH}…`);
const ref = api('PATCH', `repos/${REPO}/git/refs/heads/${BRANCH}`, {
  sha: commit.sha,
  force: true,
});
console.log(`  ${ref.ref} -> ${ref.object.sha.slice(0, 10)}`);

// ---- report ----------------------------------------------------------------
const info = JSON.parse(gh(['repo', 'view', REPO, '--json', 'url,defaultBranchRef,pushedAt']));
console.log(`\ndone: ${info.url}  branch=${info.defaultBranchRef?.name}  pushedAt=${info.pushedAt}`);
