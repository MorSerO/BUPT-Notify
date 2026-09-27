// Compare the local commit's tree with the published one.
import { execFileSync } from 'node:child_process';

const REPO = 'MorSerO/BUPT-Notify';
const gh = (a) => execFileSync('gh', a, { encoding: 'utf8', windowsHide: true, timeout: 120000 });
const git = (a) => execFileSync('git', a, { encoding: 'utf8', windowsHide: true }).trim();

const localCommit = git(['rev-parse', 'HEAD']);
const localTree = git(['rev-parse', 'HEAD^{tree}']);
const remoteCommit = JSON.parse(gh(['api', `repos/${REPO}/commits/main`])).sha;
const remoteTree = JSON.parse(gh(['api', `repos/${REPO}/git/commits/${remoteCommit}`])).tree.sha;

console.log(`local  commit ${localCommit.slice(0, 10)}  tree ${localTree.slice(0, 10)}`);
console.log(`remote commit ${remoteCommit.slice(0, 10)}  tree ${remoteTree.slice(0, 10)}`);
console.log(localTree === remoteTree ? '\n=> trees are IDENTICAL (same content)' : '\n=> TREES DIFFER');

// Also compare per-file blob shas, which is the real proof.
const localLs = execFileSync('git', ['ls-tree', '-r', 'HEAD'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [meta, p] = l.split('\t');
    return [p, meta.split(/\s+/)[2]];
  });
const remoteTreeFull = JSON.parse(gh(['api', `repos/${REPO}/git/trees/main?recursive=1`])).tree
  .filter((t) => t.type === 'blob')
  .map((t) => [t.path, t.sha]);

const localMap = new Map(localLs);
const remoteMap = new Map(remoteTreeFull);
const onlyLocal = [...localMap.keys()].filter((k) => !remoteMap.has(k));
const onlyRemote = [...remoteMap.keys()].filter((k) => !localMap.has(k));
const differing = [...localMap.keys()].filter((k) => remoteMap.has(k) && remoteMap.get(k) !== localMap.get(k));

console.log(`\nlocal files: ${localMap.size}   remote files: ${remoteMap.size}`);
console.log(`  only local : ${onlyLocal.length ? onlyLocal.join(', ') : '(none)'}`);
console.log(`  only remote: ${onlyRemote.length ? onlyRemote.join(', ') : '(none)'}`);
console.log(`  differing  : ${differing.length ? differing.join(', ') : '(none)'}`);
console.log(
  onlyLocal.length === 0 && onlyRemote.length === 0 && differing.length === 0
    ? '\n=> every published file matches the working tree byte-for-byte'
    : '\n=> MISMATCH — re-push needed',
);
