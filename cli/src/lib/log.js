'use strict';
const fs = require('fs');

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (useColor ? `${c}${s}${C.reset}` : s);

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function createLogger({ file = null, verbose = false } = {}) {
  let stream = null;
  if (file) {
    fs.mkdirSync(require('path').dirname(file), { recursive: true });
    stream = fs.createWriteStream(file, { flags: 'a' });
  }
  const emit = (level, color, msg) => {
    const line = `[${ts()}] ${msg}`;
    if (stream) stream.write(`[${new Date().toISOString()}] [${level}] ${msg}\n`);
    console.log(paint(color, line));
  };
  return {
    info: (m) => emit('info', C.reset, m),
    ok: (m) => emit('ok', C.green, `✓ ${m}`),
    warn: (m) => emit('warn', C.yellow, `! ${m}`),
    error: (m) => emit('error', C.red, `✗ ${m}`),
    step: (m) => emit('step', C.cyan, `→ ${m}`),
    debug: (m) => { if (verbose) emit('debug', C.dim, `  ${m}`); },
    close: () => stream?.end(),
  };
}

module.exports = { createLogger };
