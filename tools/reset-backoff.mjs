// Clear the stale auto-login failure counter and show the resulting state.
import { loadConfig } from '../src/config.js';
import { App } from '../src/app.js';
import { Store } from '../src/store.js';
import { initLogger } from '../src/logger.js';
import { storedUsername, hasStoredCredentials } from '../src/secrets.js';

initLogger({ level: 'error', file: false, console: false });

const cfg = loadConfig({ quiet: true });
const app = new App(cfg);

const before = {
  failures: app.store.getMeta('autoLoginFailures', 0),
  lastFailureAt: app.store.getMeta('autoLoginLastFailureAt', null),
  lastReason: app.store.getMeta('autoLoginLastFailureReason', null),
};
console.log('=== before ===');
console.log(' ', JSON.stringify(before, null, 1).replace(/\n/g, '\n  '));
console.log('  cooldown:', JSON.stringify(app.autoLoginCooldown()));
console.log('  hasStoredCredentials:', hasStoredCredentials(), '| username:', storedUsername() || '(none)');

app.resetAutoLoginBackoff();

console.log('\n=== after reset ===');
console.log('  failures:', app.store.getMeta('autoLoginFailures', 0));
console.log('  cooldown:', JSON.stringify(app.autoLoginCooldown()));
console.log('  autoLoginAllowed():', JSON.stringify(app.autoLoginAllowed()));
console.log('  status.autoLoginPaused:', app.status.autoLoginPaused);
process.exit(0);
