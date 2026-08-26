'use strict';
const fs = require('fs');
const path = require('path');
const { RunState } = require('../lib/state.js');
const exporter = require('../lib/exporter.js');
const { latestRunDir } = require('./collect.js');

function resolveDir(outDir, runId) {
  const base = path.resolve(outDir || path.join(__dirname, '..', '..', 'runs'));
  if (!runId) {
    const d = latestRunDir(base);
    if (!d) throw new Error(`${base} 下没有 run`);
    return d;
  }
  const d = path.join(base, runId);
  if (!fs.existsSync(d)) throw new Error(`run 不存在：${d}`);
  return d;
}

function exportRun(opts = {}) {
  const dir = resolveDir(opts.outDir, opts.run);
  const state = RunState.load(dir);
  const results = state.materializedResults();
  const format = opts.format || 'both';
  const written = [];

  if (format === 'csv' || format === 'both') {
    const p = path.join(dir, exporter.exportFilename(state.data.marketplace, 'csv'));
    fs.writeFileSync(p, exporter.buildResultsCsv(results, { withAccount: Boolean(opts.withAccount) }));
    written.push(p);
  }
  if (format === 'json' || format === 'both') {
    const p = path.join(dir, exporter.exportFilename(state.data.marketplace, 'json'));
    fs.writeFileSync(p, exporter.buildResultsJson(results, {
      marketplace: state.data.marketplace, totalAsins: state.data.asins.length,
    }));
    written.push(p);
  }
  console.log(`已导出 ${results.length} 行：`);
  for (const p of written) console.log(`  ${p}`);
  return written;
}

module.exports = { exportRun, resolveDir };
