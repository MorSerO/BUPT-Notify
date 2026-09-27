// Save and analyse the REAL login form fragment (login-normal.html), which is
// only reachable over plain HTTP (the browser's iframe request 400s).
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const CAS = 'https://auth.bupt.edu.cn';
const outDir = path.resolve('tools/out');
fs.mkdirSync(outDir, { recursive: true });

function get(p) {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: 'auth.bupt.edu.cn', port: 443, path: p, method: 'GET', timeout: 20000, rejectUnauthorized: false,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36', Accept: '*/*' } },
      (res) => {
        const c = [];
        res.on('data', (x) => c.push(x));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}

const r = await get('/authserver/cas/login-normal.html');
fs.writeFileSync(path.join(outDir, 'login-normal.html'), r.body);
console.log(`login-normal.html: status=${r.status} len=${r.body.length} → tools/out/login-normal.html`);

const html = r.body;

console.log('\n=== forms ===');
for (const m of html.matchAll(/<form\b[^>]*>/gi)) console.log(`  ${m[0]}`);
for (const m of html.matchAll(/<input\b[^>]*>/gi)) console.log(`  in : ${m[0].replace(/\s+/g, ' ')}`);
for (const m of html.matchAll(/<button\b[^>]*>/gi)) console.log(`  btn: ${m[0]}`);

console.log('\n=== captcha-related ===');
for (const k of ['cptValue', 'captcha', '验证码', 'getCaptcha', 'captchaImg', 'verifyCode']) {
  const n = (html.match(new RegExp(k, 'gi')) || []).length;
  console.log(`  ${k.padEnd(14)} x${n}`);
}

console.log('\n=== the loginPassword() implementation ===');
const i = html.indexOf('function loginPassword');
if (i >= 0) {
  // Print a generous window; brace matching is fragile in minified code.
  console.log(html.slice(i, i + 2600).replace(/\n\s*/g, '\n  '));
} else {
  console.log('  loginPassword() not defined inline; look for it in init.js or an external bundle');
  for (const m of html.matchAll(/loginPassword[^;]{0,80}/g)) console.log('   ', m[0]);
}

console.log('\n=== hidden inputs / tokens ===');
for (const m of html.matchAll(/<input[^>]*type=["']hidden["'][^>]*>/gi)) console.log(`  ${m[0]}`);

console.log('\n=== scripts referenced ===');
for (const m of html.matchAll(/<script\b[^>]*src=["']([^"']+)["']/gi)) console.log(`  ${m[1]}`);
process.exit(0);
