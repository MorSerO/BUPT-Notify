// One-off recon: probe BUPT hosts over HTTPS using Node's OpenSSL stack.
import https from 'node:https';
import dns from 'node:dns/promises';

const hosts = ['vpn.bupt.edu.cn', 'my.bupt.edu.cn'];

async function probe(host, path = '/') {
  console.log(`\n=== ${host}${path} ===`);
  try {
    const addrs = await dns.lookup(host, { all: true });
    console.log('DNS:', addrs.map(a => `${a.address}(${a.family})`).join(', '));
  } catch (e) {
    console.log('DNS FAIL:', e.code || e.message);
  }
  await new Promise((resolve) => {
    const req = https.get(
      { host, path, port: 443, timeout: 20000, rejectUnauthorized: false,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36' } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          console.log('STATUS:', res.statusCode);
          console.log('HEADERS:', JSON.stringify(res.headers, null, 2).slice(0, 1200));
          console.log('BODY LEN:', body.length);
          console.log('BODY HEAD:', body.slice(0, 1500).replace(/\s+/g, ' '));
          resolve();
        });
      },
    );
    req.on('timeout', () => { console.log('TIMEOUT'); req.destroy(); resolve(); });
    req.on('error', (e) => { console.log('ERR:', e.code || e.message); resolve(); });
  });
}

for (const h of hosts) await probe(h);
