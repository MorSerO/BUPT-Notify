/**
 * logger.js — console + rotating file logger.
 */

import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR, ensureDir, todayLocal } from './util.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_COLOR = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };

let minLevel = LEVELS.info;
let logFile = null;
let echoToConsole = true;

export function initLogger({ level = 'info', file = true, console: toConsole = true } = {}) {
  minLevel = LEVELS[level] ?? LEVELS.info;
  echoToConsole = toConsole;
  if (file) {
    ensureDir(LOG_DIR);
    logFile = path.join(LOG_DIR, `bupt-notify-${todayLocal()}.log`);
    rotateLogs();
  }
}

/** Keep only the most recent 30 log files. */
function rotateLogs() {
  try {
    const files = fs
      .readdirSync(LOG_DIR)
      .filter((f) => /^bupt-notify-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - 30))) {
      fs.unlinkSync(path.join(LOG_DIR, f));
    }
  } catch {
    /* rotation is best-effort */
  }
}

function write(level, args) {
  if (LEVELS[level] < minLevel) return;
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const msg = args
    .map((a) => {
      if (a instanceof Error) return `${a.message}${a.stack ? `\n${a.stack}` : ''}`;
      if (typeof a === 'object' && a !== null) {
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      }
      return String(a);
    })
    .join(' ');

  const line = `${ts} [${level.toUpperCase().padEnd(5)}] ${msg}`;
  if (echoToConsole) {
    const color = LEVEL_COLOR[level] || '';
    process.stdout.write(`${color}${line}\x1b[0m\n`);
  }
  if (logFile) {
    try {
      fs.appendFileSync(logFile, `${line}\n`, 'utf8');
    } catch {
      /* never let logging break the run */
    }
  }
}

export const log = {
  debug: (...a) => write('debug', a),
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
};

export function getLogFile() {
  return logFile;
}
