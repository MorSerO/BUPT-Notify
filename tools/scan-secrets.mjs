// Scan every tracked file for credentials/identifiers that secret scanners flag.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

const PATTERNS = [
  ['WeChat Work appid (wx…)', /\bwx[0-9a-f]{16}\b/gi],
  ['WeChat/agentid', /"agentid"\s*:\s*"?\d+/gi],
  ['appid field', /appid['"]?\s*[:=]\s*['"]?[A-Za-z0-9]{8,}/gi],
  ['secret field', /secret['"]?\s*[:=]\s*['"]?[A-Za-z0-9_-]{8,}/gi],
  ['JWT-ish blob', /eyJ[A-Za-z0-9_-]{20,}/g],
  ['long base64 (>=120)', /[A-Za-z0-9+/]{120,}={0,2}/g],
  ['SMTP auth code-ish', /\b[a-z]{16}\b/g],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['access token', /access[_-]?token['"]?\s*[:=]\s*['"]?[A-Za-z0-9._-]{12,}/gi],
  ['corp id', /corpid|corp_id|ww[0-9a-f]{16}/gi],
];

let total = 0;
for (const f of tracked) {
  // The scanner necessarily contains the patterns themselves.
  if (f === 'tools/scan-secrets.mjs') continue;
  let src;
  try {
    src = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  const hits = [];
  for (const [label, re] of PATTERNS) {
    const found = new Set();
    for (const m of src.matchAll(re)) {
      const v = m[0];
      // Deliberate placeholders are not secrets.
      if (/REDACTED|0{7,}|example\.(edu|com)|placeholder|dummy/i.test(v)) continue;
      // Filter out obvious non-secrets so the report stays readable.
      if (label === 'SMTP auth code-ish' && !/^(?:[a-z])\1*$/.test(v) && !/(.)\1{5,}/.test(v)) continue;
      found.add(v.length > 60 ? `${v.slice(0, 60)}…(${v.length})` : v);
    }
    if (found.size) hits.push([label, [...found]]);
  }
  if (hits.length) {
    total += hits.length;
    console.log(`\n${f}`);
    for (const [label, vals] of hits) {
      console.log(`  [${label}]`);
      for (const v of vals.slice(0, 6)) console.log(`      ${v}`);
      if (vals.length > 6) console.log(`      … +${vals.length - 6} more`);
    }
  }
}
console.log(`\n${total} pattern group(s) with hits across ${tracked.length} tracked files`);
if (total === 0) console.log('OK: no credentials or third-party identifiers found');
process.exit(total === 0 ? 0 : 1);
