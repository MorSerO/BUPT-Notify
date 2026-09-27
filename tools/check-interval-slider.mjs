// Verify the interval slider: arbitrary hours, including values that do not
// divide 24 evenly (the whole point of switching away from daily triggers).
const base = `http://127.0.0.1:${process.argv[2] || 17917}/`;
const html = await (await fetch(base)).text();
const t = (html.match(/const TOKEN = "([a-f0-9]+)"/) || [])[1];
if (!t) { console.log('no token'); process.exit(1); }
const H = { 'X-BUPT-Token': t, 'Content-Type': 'application/json' };
const j = async (p, o = {}) => {
  const r = await fetch(base + p, { ...o, headers: { ...H, ...(o.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

console.log('=== markup ===');
console.log(`  ${html.includes('type="range"') ? 'v' : 'x'} range slider present`);
console.log(`  ${html.includes('id="taskInterval"') ? 'v' : 'x'} taskInterval control`);
console.log(`  ${/id="taskInterval"[^>]*min="1"[^>]*max="24"[^>]*step="1"/.test(html) ? 'v' : 'x'} min=1 max=24 step=1`);
console.log(`  ${!html.includes("$(`#taskInterval option") ? 'v' : 'x'} old <select> logic removed`);
console.log(`  ${html.includes('hoursLabel') ? 'v' : 'x'} fractional multi-hour label helper`);

/*
 * Remember what the machine looked like so the check can put it back.
 * NOTE: setting the guard here would be useless — it has to be in the *server*
 * process (`BUPT_NOTIFY_NO_SYSTEM_CHANGES=1 node src/main.js --ui`), otherwise
 * these POSTs really do register and unregister scheduled tasks.
 */
const before = await j('api/autostart');
const restore = { enabled: before.body?.installed === true, intervalHours: before.body?.intervalHours };
console.log(`\n(initial state: ${restore.enabled ? `enabled @ ${restore.intervalHours}h` : 'disabled'})`);

console.log('\n=== every hour 1..24 is accepted by the API ===');
let bad = 0;
for (const h of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]) {
  const r = await j('api/autostart', { method: 'POST', body: JSON.stringify({ enabled: true, intervalHours: h }) });
  if (r.status !== 200 || !r.body.ok) { bad += 1; console.log(`  x ${h}h -> HTTP ${r.status} ${JSON.stringify(r.body)}`); }
}
console.log(bad === 0 ? '  v all 24 values accepted' : `  ${bad} rejected`);

console.log('\n=== out-of-range is refused with a clear message ===');
for (const h of [0, 0.1, 25, 100]) {
  const r = await j('api/autostart', { method: 'POST', body: JSON.stringify({ enabled: true, intervalHours: h }) });
  console.log(`  ${String(h).padStart(5)}h -> HTTP ${r.status} ${r.body?.error || ''}`);
}

console.log('\n=== put the machine back the way it was ===');
const back = await j('api/autostart', {
  method: 'POST',
  body: JSON.stringify({
    enabled: restore.enabled,
    intervalHours: restore.intervalHours || undefined,
  }),
});
console.log(
  `  restore ${restore.enabled ? `enabled @ ${restore.intervalHours}h` : 'disabled'} -> ` +
    `HTTP ${back.status} installed=${back.body?.installed}`,
);
process.exit(bad === 0 ? 0 : 1);
