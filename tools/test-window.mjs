// Verify the control-panel WINDOW actually opens: start the server, launch the
// Chrome app-mode window, confirm the process and its --app / --user-data-dir
// flags, then clean up ONLY that process.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { App } from '../src/app.js';
import { createUiServer } from '../src/server.js';
import { openAppWindow, findChrome } from '../src/net.js';
import { Store } from '../src/store.js';
import { initLogger } from '../src/logger.js';

initLogger({ level: 'warn', file: false, console: true });

const work = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'bupt-win-'));
const cfg = loadConfig({ quiet: true });
cfg.output.mode = 'local';
cfg.output.localDir = path.join(work, 'out');
cfg.email.enabled = false;

const app = new App(cfg, { store: new Store({ file: path.join(work, 'state.json') }) });
const { server, url } = await createUiServer({ app, port: 0 });
console.log('server url:', url);

const chrome = findChrome();
console.log('chrome:', chrome);
if (!chrome) {
  console.log('FAIL: Chrome not found');
  process.exit(1);
}

console.log('opening app window…');
const ok = openAppWindow(url);
console.log('openAppWindow returned:', ok);

await new Promise((r) => setTimeout(r, 4000));

// Look for a chrome process carrying our --app= URL.
let procs = [];
try {
  const raw = execFileSync(
    'powershell',
    ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 },
  );
  procs = JSON.parse(raw || '[]');
  if (!Array.isArray(procs)) procs = [procs];
} catch (e) {
  console.log('could not enumerate processes:', e.message.split('\n')[0]);
}

const ours = procs.filter((p) => p.CommandLine && p.CommandLine.includes('BUPT-Notify'));
console.log(`chrome processes total: ${procs.length}, ours: ${ours.length}`);
for (const p of ours.slice(0, 2)) {
  console.log('  pid', p.ProcessId);
  console.log('   has --app=     :', /--app=http:\/\/127\.0\.0\.1:\d+\//.test(p.CommandLine));
  console.log('   has user-data-dir:', /BUPT-Notify[\\/]ui-profile/.test(p.CommandLine));
  console.log('   has window-size: ', /--window-size=1120,860/.test(p.CommandLine));
}

if (ours.length === 0) console.log('FAIL: no Chrome process opened for the control panel');
else console.log('OK: control panel window process is running');

// Clean up only our windows.
for (const p of ours) {
  try {
    execFileSync('taskkill', ['/PID', String(p.ProcessId), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch { /* ignore */ }
}
console.log('cleaned up our Chrome windows');

await new Promise((r) => server.close(r));
process.exit(ours.length ? 0 : 1);
