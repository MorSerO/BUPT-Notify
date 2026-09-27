// Recon #2: follow the aTrust portal redirect chain and dump the login page.
import https from 'node:https';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function get(url, depth = 0, seen = new Set()) {
  return new Promise((resolve) => {
    if (depth > 6 || seen.has(url)) return resolve({ url, note: 'stop' });
    seen.add(url);
    const u = new URL(url);
    const req = https.get(
      { host: u.hostname, port: u.port || 443, path: u.pathname + u.search, timeout: 20000,
        rejectUnauthorized: false, headers: { 'User-Agent': UA, Accept: '*/*' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', async () => {
          const body = Buffer.concat(chunks).toString('utf8');
          console.log(`[${depth}] ${res.statusCode} ${url} -> len=${body.length}`);
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            const next = new URL(res.headers.location, url).href;
            console.log(`      redirect: ${next}`);
            return resolve(await get(next, depth + 1, seen));
          }
          resolve({ url, status: res.statusCode, headers: res.headers, body });
        });
      },
    );
    req.on('timeout', () => { console.log('TIMEOUT', url); req.destroy(); resolve({ url, note: 'timeout' }); });
    req.on('error', (e) => { console.log('ERR', url, e.code || e.message); resolve({ url, note: e.code }); });
  });
}

const r = await get('https://vpn.bupt.edu.cn/portal/');
if (r?.body) {
  console.log('\n--- TITLE ---');
  console.log((r.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, '(none)'])[1].trim());
  console.log('\n--- SCRIPTS / LINKS ---');
  for (const m of r.body.matchAll(/<(script|link)\b[^>]*?(?:src|href)=["']([^"']+)["']/gi)) {
    console.log(` ${m[1]}: ${m[2]}`);
  }
  console.log('\n--- BODY (first 3000 chars, collapsed) ---');
  console.log(r.body.slice(0, 3000).replace(/\s+/g, ' '));
  console.log('\n--- SAVED FULL BODY ---');
  const fs = await import('node:fs');
  fs.mkdirSync('tools/out', { recursive: true });
  fs.writeFileSync('tools/out/atrust-portal.html', r.body);
  console.log('tools/out/atrust-portal.html');
}
