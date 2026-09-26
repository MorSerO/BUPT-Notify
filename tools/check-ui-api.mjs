// End-to-end check of the running control panel (GUI + API).
const base = `http://127.0.0.1:${process.argv[2] || 17899}/`;

const html = await (await fetch(base)).text();
const m = html.match(/const TOKEN = "([a-f0-9]+)"/);
console.log('GUI served:', html.length, 'bytes | token injected:', Boolean(m));
console.log('  has 立即抓取 button :', html.includes('立即抓取'));
console.log('  has 抓取间隔 slider :', html.includes('抓取间隔'));
console.log('  slider min=2 max=24  :', /id="interval"[^>]*min="2"[^>]*max="24"/.test(html));
console.log('  has 账号 field      :', html.includes('credUser'));
console.log('  has 授权码 field    :', html.includes('emailPass'));
console.log('  has 发送测试邮件     :', html.includes('发送测试邮件'));

if (!m) {
  console.log('no token; aborting API checks');
  process.exit(1);
}
const t = m[1];
const H = { 'X-BUPT-Token': t, 'Content-Type': 'application/json' };
const j = async (p, o = {}) => {
  const r = await fetch(base + p, { ...o, headers: { ...H, ...(o.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

console.log('\n--- auth ---');
console.log('  no token  ->', (await fetch(base + 'api/status')).status);
console.log('  bad token ->', (await fetch(base + 'api/status', { headers: { 'X-BUPT-Token': 'wrong' } })).status);

console.log('\n--- status ---');
const st = await j('api/status');
console.log('  busy:', st.body.status.busy, '| intervalMinutes:', st.body.status.intervalMinutes,
  '| outputMode:', st.body.status.outputMode);
console.log('  hasCredentials:', st.body.status.hasCredentials, '| storeSize:', st.body.status.storeSize);
console.log('  limits:', JSON.stringify(st.body.limits));
console.log('  events:', st.body.status.events.length);
console.log('  last event:', (st.body.status.events.at(-1) || {}).message);

console.log('\n--- interval validation (2h..24h) ---');
for (const v of [30, 119, 120, 1440, 1441, 2880]) {
  const r = await j('api/settings', { method: 'POST', body: JSON.stringify({ intervalMinutes: v }) });
  console.log(`  ${String(v).padStart(4)} -> HTTP ${r.status} ${r.status === 200 ? 'accepted' : (r.body.errors || []).join(';')}`);
}

console.log('\n--- credentials round trip ---');
console.log('  save ->', JSON.stringify(await j('api/credentials', { method: 'POST', body: JSON.stringify({ username: '2021000000', password: 'demo-pw' }) })));
const st2 = await j('api/status');
console.log('  hasCredentials:', st2.body.status.hasCredentials, '| username:', st2.body.status.credentialUsername);
console.log('  password leaked in status:', JSON.stringify(st2.body).includes('demo-pw'));
console.log('  clear ->', (await j('api/credentials', { method: 'DELETE' })).status);

console.log('\n--- manual run trigger ---');
const run = await j('api/run?dryRun=1', { method: 'POST' });
console.log('  POST /api/run (dry) ->', run.status, JSON.stringify(run.body));
const run2 = await j('api/run', { method: 'POST' });
console.log('  POST /api/run again  ->', run2.status, JSON.stringify(run2.body), '(409 = already busy, correct)');

process.exit(0);
