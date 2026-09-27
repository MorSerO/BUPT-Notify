// Migrate config.json to the new scheduled-run model:
//   poll.mode = 'task', a sensible interval, and the notify section.
import { loadConfig, saveConfig, CONFIG_PATH } from '../src/config.js';

const cfg = loadConfig({ quiet: true });

const before = {
  poll: { ...cfg.poll },
  notify: { ...cfg.notify },
};

cfg.poll.mode = 'task';
// 3 hours: frequent enough to be useful, rare enough not to spam the inbox.
// (The stored value was a leftover from earlier testing, so normalise it.)
cfg.poll.intervalMinutes = 180;
cfg.poll.jitterSeconds = 0;
cfg.notify.desktop = false;
cfg.notify.manualLoginWindow = false;

saveConfig(cfg);

const after = loadConfig({ quiet: true });
console.log(`config: ${CONFIG_PATH}\n`);
console.log('before:', JSON.stringify(before));
console.log('after :', JSON.stringify({ poll: after.poll, notify: after.notify }));
console.log(`\noutput mode : ${after.output.mode}`);
console.log(`window days : ${after.windowDays}`);
console.log(`empty notify: ${after.output.notifyWhenEmpty} (every ${after.output.emptyNotifyIntervalHours}h)`);
