// Detect (and optionally strip) UTF-8 BOMs.
//
// A BOM is harmless in most text files, but it breaks `JSON.parse` on
// package.json, confuses some PowerShell/cmd parsing, and shows up as a stray
// character in diffs. Nothing here needs one.
//
// Usage: node tools/fix-bom.mjs [--fix]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FIX = process.argv.includes('--fix');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);

const TEXT = /\.(js|mjs|cjs|json|md|ps1|cmd|bat|vbs|html|css|txt|ya?ml|gitignore|gitattributes)$/i;

let found = 0;
let fixed = 0;
for (const rel of tracked) {
  if (!TEXT.test(rel) && !/^\.(gitignore|gitattributes)$/.test(path.basename(rel))) continue;
  let buf;
  try {
    buf = fs.readFileSync(rel);
  } catch {
    continue;
  }
  if (buf.length < 3 || !buf.subarray(0, 3).equals(BOM)) continue;
  found += 1;
  if (FIX) {
    fs.writeFileSync(rel, buf.subarray(3));
    fixed += 1;
    console.log(`  stripped BOM: ${rel}`);
  } else {
    console.log(`  BOM: ${rel}`);
  }
}

console.log(
  found === 0
    ? 'no BOMs in tracked text files'
    : FIX
      ? `stripped ${fixed}/${found}`
      : `${found} file(s) have a BOM (run with --fix)`,
);
process.exit(found === 0 || FIX ? 0 : 1);
