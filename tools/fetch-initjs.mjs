// Fetch and analyse /authserver/cas/js/init.js — specifically doLogin(), which
// is the real submit path the login iframe calls into.
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const outDir = path.resolve('tools/out');
fs.mkdirSync(outDir, { recursive: true });

function get(p) {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname: 'auth.bupt.edu.cn', port: 443, path: p, method: 'GET', timeout: 20000, rejectUnauthorized: false,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36' } },
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

const r = await get('/authserver/cas/js/init.js');
fs.writeFileSync(path.join(outDir, 'init.js'), r.body);
console.log(`init.js: status=${r.status} len=${r.body.length} → tools/out/init.js\n`);

const js = r.body;
console.log('=== doLogin ===');
const i = js.indexOf('doLogin');
if (i >= 0) console.log(js.slice(Math.max(0, i - 200), i + 2200));
else console.log('  not found');

console.log('\n=== captcha config ===');
for (const m of js.matchAll(/captcha[^,;\n]{0,90}/gi)) console.log('  ', m[0].trim());

console.log('\n=== endpoints referenced ===');
for (const m of js.matchAll(/["'][^"']*(?:login|auth|cas)[^"']*["']/gi)) {
  const s = m[0];
  if (s.length < 90) console.log('  ', s);
}

console.log('\n=== function names defined ===');
for (const m of js.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) console.log('  ', m[1]);
process.exit(0);
