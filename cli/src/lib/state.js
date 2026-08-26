'use strict';
/**
 * 采集任务状态与结果落盘。
 *
 * 设计要点：
 *  - results.jsonl 是 append-only，每问完一题立即落盘，进程被杀也不丢已采数据
 *  - state.json 原子写（tmp+rename），记录游标与计数
 *  - 问题列表在 run 创建时冻结进 state.json（含 shuffle 顺序与 seed），
 *    resume 不受题库文件后续改动影响，questionIndex 语义才稳定
 */

const fs = require('fs');
const path = require('path');

const STATUS = {
  RUNNING: 'running',
  PAUSED_ALL_BLOCKED: 'paused_all_blocked',
  PAUSED_SIGNIN: 'paused_signin',
  QUOTA_EXHAUSTED: 'quota_exhausted',
  COMPLETED: 'completed',
  COMPLETED_WITH_ERRORS: 'completed_with_errors',
  ABORTED: 'aborted',
};

function atomicWriteJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

const doneKey = (asin, questionIndex) => `${asin}::${questionIndex}`;

class RunState {
  constructor(dir, data) {
    this.dir = dir;
    this.data = data;
    this.statePath = path.join(dir, 'state.json');
    this.resultsPath = path.join(dir, 'results.jsonl');
  }

  static create(dir, { runId, marketplace, asins, questions, settings, accounts }) {
    fs.mkdirSync(dir, { recursive: true });
    const data = {
      runId,
      marketplace,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      asins,
      questions,          // 冻结
      settings,
      accounts,
      cursor: { asinIndex: 0, questionIndex: 0 },
      status: STATUS.RUNNING,
      counters: { success: 0, error: 0, asinFailed: 0, superseded: 0 },
      accountUsage: {},
      lastError: null,
    };
    const st = new RunState(dir, data);
    st.save();
    fs.writeFileSync(st.resultsPath, '', { flag: 'a' });
    return st;
  }

  static load(dir) {
    const statePath = path.join(dir, 'state.json');
    if (!fs.existsSync(statePath)) throw new Error(`run 目录里没有 state.json：${dir}`);
    return new RunState(dir, JSON.parse(fs.readFileSync(statePath, 'utf8')));
  }

  save() {
    this.data.updatedAt = new Date().toISOString();
    atomicWriteJson(this.statePath, this.data);
  }

  appendResult(row) {
    fs.appendFileSync(this.resultsPath, `${JSON.stringify(row)}\n`);
    if (row.superseded) this.data.counters.superseded++;
    else if (row.status === 'error') this.data.counters.error++;
    else this.data.counters.success++;
    if (row.account) {
      this.data.accountUsage[row.account] = (this.data.accountUsage[row.account] || 0) + 1;
    }
    this.save();
  }

  /** 读回全部结果行，容忍进程被杀留下的半行 */
  readResults() {
    if (!fs.existsSync(this.resultsPath)) return [];
    const lines = fs.readFileSync(this.resultsPath, 'utf8').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch (e) {
        // 只容忍最后一行损坏（进程被杀写了半行）；中间损坏说明文件有更大问题
        if (i < lines.length - 2) throw new Error(`results.jsonl 第 ${i + 1} 行损坏`);
      }
    }
    return out;
  }

  /**
   * 已完成集合。superseded 行不算完成（换号后要重跑整个 ASIN）。
   * error 行默认算完成（与插件"错误不重试"一致）；retryErrors 时视为未完成。
   */
  doneSet({ retryErrors = false } = {}) {
    const done = new Set();
    // 必须走 last-write-wins：supersedeAsin 追加的是墓碑行，原行仍在文件里。
    // 直接遍历原始行会把被作废的行又算成已完成，导致换号后不重跑。
    for (const r of this.materializedResults()) {
      if (retryErrors && r.status === 'error') continue;
      if (typeof r.questionIndex === 'number') done.add(doneKey(r.asin, r.questionIndex));
    }
    return done;
  }

  /**
   * 把某个 ASIN 已写入的行标记作废（换号时用）。
   * 做法是追加同 key 的墓碑行 —— jsonl 是 append-only，不回头改历史，可审计。
   */
  supersedeAsin(asin) {
    const rows = this.readResults().filter((r) => r.asin === asin && !r.superseded);
    for (const r of rows) {
      fs.appendFileSync(this.resultsPath, `${JSON.stringify({ ...r, superseded: true })}\n`);
      this.data.counters.superseded++;
    }
    this.save();
    return rows.length;
  }

  /** 导出用：同 key 取最后一条（last-write-wins），并剔除被墓碑覆盖的行 */
  materializedResults() {
    const byKey = new Map();
    const order = [];
    for (const r of this.readResults()) {
      const key = typeof r.questionIndex === 'number'
        ? doneKey(r.asin, r.questionIndex)
        : `${r.asin}::${r.question}`;
      if (!byKey.has(key)) order.push(key);
      byKey.set(key, r);
    }
    return order.map((k) => byKey.get(k)).filter((r) => !r.superseded);
  }

  setStatus(status, lastError = null) {
    this.data.status = status;
    if (lastError) this.data.lastError = lastError;
    this.save();
  }
}

module.exports = { RunState, STATUS, doneKey, atomicWriteJson };
