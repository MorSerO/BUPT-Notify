// Verify the new "scheduled scraping" panel flow end-to-end.
const base = `http://127.0.0.1:${process.argv[2] || 17915}/`;
const html = await (await fetch(base)).text();
const t = (html.match(/const TOKEN = "([a-f0-9]+)"/) || [])[1];
if (!t) { console.log('no token'); process.exit(1); }
const H = { 'X-BUPT-Token': t, 'Content-Type': 'application/json' };
const j = async (p, o = {}) => {
  const r = await fetch(base + p, { ...o, headers: { ...H, ...(o.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

console.log('=== panel markup ===');
for (const k of ['定时自动抓取', 'taskEnabled', 'taskInterval', 'btnSaveTask', 'btnRunTaskNow']) {
  console.log(`  ${html.includes(k) ? 'v' : 'x'} ${k}`);
}
console.log(`  ${!html.includes("$('interval')") ? 'v' : 'x'} interval slider removed (single place to set the schedule)`);

console.log('\n=== GET /api/autostart ===');
const st = await j('api/autostart');
const { ok, supported, installed, intervalHours, triggers, mode, defaultIntervalHours, pollMode, nextRunTime } = st.body;
console.log(`  installed=${installed} intervalHours=${intervalHours} mode=${mode} triggers=${JSON.stringify(triggers)}`);
console.log(`  defaultIntervalHours=${defaultIntervalHours} pollMode=${pollMode}`);
console.log(`  nextRunTime=${nextRunTime}`);

console.log('\n=== status reports task mode ===');
const s = (await j('api/status')).body.status;
console.log(`  pollMode=${s.pollMode} quiet=${s.quiet} schedulerActive=${s.schedulerActive} nextRunAt=${s.nextRunAt}`);
console.log(`  ${s.schedulerActive === false ? 'v' : 'x'} panel does NOT poll internally in task mode`);

console.log('\n=== change interval to 6h and enable ===');
const on = await j('api/autostart', { method: 'POST', body: JSON.stringify({ enabled: true, intervalHours: 6 }) });
console.log(`  HTTP ${on.status} ok=${on.body.ok} installed=${on.body.installed}`);
const st2 = await j('api/autostart');
console.log(`  now: intervalHours=${st2.body.intervalHours} triggers=${JSON.stringify(st2.body.triggers)} next=${st2.body.nextRunTime}`);

console.log('\n=== disable (the "取消勾选" path) ===');
const off = await j('api/autostart', { method: 'POST', body: JSON.stringify({ enabled: false }) });
console.log(`  HTTP ${off.status} ok=${off.body.ok} installed=${off.body.installed}`);
const st3 = await j('api/autostart');
console.log(`  now: installed=${st3.body.installed}`);

console.log('\n=== events ===');
for (const e of (await j('api/status')).body.status.events.slice(-6)) console.log(`  [${e.level}] ${e.message}`);
process.exit(0);
