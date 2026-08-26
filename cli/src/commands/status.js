'use strict';
const fs = require('fs');
const { RunState } = require('../lib/state.js');
const { AccountPool, ACCOUNTS_PATH } = require('../lib/account-pool.js');
const { resolveDir } = require('./export.js');
const accounts = require('./accounts.js');

function status(opts = {}) {
  let dir = null;
  try { dir = resolveDir(opts.outDir, opts.run); } catch (e) { console.log(`(无 run：${e.message})`); }

  if (dir) {
    const st = RunState.load(dir);
    const d = st.data;
    const totalQ = d.asins.length * d.questions.length;
    const done = st.doneSet().size;
    const pct = totalQ ? Math.round((done / totalQ) * 100) : 0;
    console.log(`run ${d.runId}  [${d.status}]`);
    console.log(`  进度 ${done}/${totalQ} (${pct}%)  成功 ${d.counters.success} 错误 ${d.counters.error} ASIN失败 ${d.counters.asinFailed} 作废 ${d.counters.superseded}`);
    console.log(`  ${d.asins.length} ASIN × ${d.questions.length} 题，站点 ${d.marketplace}`);
    if (Object.keys(d.accountUsage).length) {
      console.log(`  账号用量：${Object.entries(d.accountUsage).map(([k, v]) => `${k}=${v}`).join('  ')}`);
    }
    if (d.lastError) console.log(`  最后错误：${d.lastError}`);
    console.log(`  ${dir}`);
    console.log('');
  }

  if (fs.existsSync(ACCOUNTS_PATH)) {
    console.log('账号池：');
    accounts.list();
  }
}

module.exports = { status };
