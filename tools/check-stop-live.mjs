// Live test of the stop button against the RUNNING app.
const base = `http://127.0.0.1:${process.argv[2] || 17901}/`;
const html = await (await fetch(base)).text();
const t = (html.match(/const TOKEN = "([a-f0-9]+)"/) || [])[1];
if (!t) { console.log('no token'); process.exit(1); }
const H = { 'X-BUPT-Token': t, 'Content-Type': 'application/json' };
const j = async (p, o = {}) => {
  const r = await fetch(base + p, { ...o, headers: { ...H, ...(o.headers || {}) } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const before = (await j('api/status')).body.status;
console.log('BEFORE  busy=%s stopped=%s stage=%s nextRun=%s', before.busy, before.stopped, before.stage, before.nextRunAt);
console.log('        schedulerActive=%s', before.schedulerActive);

console.log('\n>>> pressing 停止抓取 …');
const t0 = Date.now();
const stop = await j('api/stop', { method: 'POST' });
const stopMs = Date.now() - t0;
console.log('    HTTP %d in %dms -> %s', stop.status, stopMs, JSON.stringify(stop.body));

// Poll until the run actually unwinds.
let settled = null;
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 250));
  const s = (await j('api/status')).body.status;
  if (!s.busy) { settled = { s, ms: Date.now() - t0 }; break; }
}
if (settled) {
  console.log('    run unwound after %dms  (busy=%s stage=%s)', settled.ms, settled.s.busy, settled.s.stage);
  console.log('    lastRun: ok=%s cancelled=%s error=%s',
    settled.s.lastRun?.ok, settled.s.lastRun?.cancelled, settled.s.lastRun?.error);
} else {
  console.log('    !! run did NOT unwind within 10s');
}

const stopped = (await j('api/status')).body.status;
console.log('\nAFTER STOP  stopped=%s schedulerActive=%s nextRun=%s stage=%s',
  stopped.stopped, stopped.schedulerActive, stopped.nextRunAt, stopped.stage);

const refused = await j('api/run', { method: 'POST' });
console.log('  POST /api/run while stopped -> HTTP %d %s', refused.status, JSON.stringify(refused.body));

console.log('\n>>> pressing 恢复自动抓取 …');
const resume = await j('api/resume', { method: 'POST' });
console.log('    HTTP %d %s', resume.status, JSON.stringify(resume.body));
const after = (await j('api/status')).body.status;
console.log('AFTER RESUME stopped=%s schedulerActive=%s nextRun=%s',
  after.stopped, after.schedulerActive, after.nextRunAt);

// Stop again so we leave the app quiet for inspection.
await j('api/stop', { method: 'POST' });
console.log('\n(left app stopped; will be shut down by the harness)');
process.exit(0);
