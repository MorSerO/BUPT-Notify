// Structural analysis of the successfully-loaded CAS login page (offline).
// Goal: understand why #default.container (which holds the username/password
// form) is display:none, and what is supposed to reveal it.
import fs from 'node:fs';

const file = process.argv[2] || 'test/fixtures/cas-login-skeleton.html';
const html = fs.readFileSync(file, 'utf8');
console.log(`file: ${file} (${html.length} bytes)\n`);

console.log('=== all <script> tags ===');
for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
  const attrs = m[1].trim();
  console.log(`  <script ${attrs.slice(0, 150)}>`);
}

console.log('\n=== <link> tags ===');
for (const m of html.matchAll(/<link\b[^>]*>/gi)) console.log(`  ${m[0].slice(0, 150)}`);

console.log('\n=== <iframe> tags ===');
for (const m of html.matchAll(/<iframe\b[^>]*>/gi)) console.log(`  ${m[0].slice(0, 200)}`);

console.log('\n=== CSS rules mentioning default/container/login/display ===');
for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
  const css = m[1];
  const rules = css.split('}').filter((r) => /default|container|login|display\s*:\s*none|iframe/i.test(r));
  for (const r of rules.slice(0, 40)) console.log(`  ${r.trim().replace(/\s+/g, ' ').slice(0, 160)}}`);
}

console.log('\n=== #default element and its ancestors ===');
const iDefault = html.indexOf('id="default"');
if (iDefault >= 0) {
  console.log(html.slice(Math.max(0, iDefault - 700), iDefault + 300).replace(/\n\s*/g, '\n  '));
} else {
  console.log('  id="default" NOT FOUND in this file');
}

console.log('\n=== occurrences of key ids/classes ===');
for (const k of ['loginIframe', 'default', 'login-normal', 'container', 'loginForm', 'username', 'password', 'display:none', 'display: none', 'hidden']) {
  const n = (html.match(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
  console.log(`  ${k.padEnd(16)} x${n}`);
}

console.log('\n=== is there any JS that toggles visibility? ===');
for (const m of html.matchAll(/[\w.$#]+\.style\.display\s*=\s*[^;\n]{0,40}/g)) console.log('  ', m[0]);
for (const m of html.matchAll(/\$\(["'][^"']*default[^"']*["']\)[^;\n]{0,80}/g)) console.log('  ', m[0]);
