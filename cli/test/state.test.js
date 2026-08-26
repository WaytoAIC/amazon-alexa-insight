'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { RunState, STATUS, doneKey } = require('../src/lib/state.js');

function mkRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apinsight-run-'));
  return RunState.create(dir, {
    runId: 'r1', marketplace: 'US',
    asins: ['B0A', 'B0B'],
    questions: [
      { category: '核心必问', categoryId: 'summary_all', question: 'q0' },
      { category: '核心必问', categoryId: 'summary_all', question: 'q1' },
    ],
    settings: { maxWaitTime: 60 },
    accounts: ['us-a'],
  });
}

const row = (o) => ({
  asin: 'B0A', productTitle: '', price: '', category: '核心必问',
  question: 'q0', answer: 'a', answerEn: 'a', status: 'success',
  timestamp: new Date().toISOString(), runId: 'r1', questionIndex: 0, account: 'us-a', ...o,
});

test('问题列表在创建时冻结进 state.json', () => {
  const st = mkRun();
  const onDisk = JSON.parse(fs.readFileSync(st.statePath, 'utf8'));
  assert.strictEqual(onDisk.questions.length, 2);
  assert.strictEqual(onDisk.questions[0].question, 'q0');
});

test('结果逐行落盘并更新计数', () => {
  const st = mkRun();
  st.appendResult(row({}));
  st.appendResult(row({ questionIndex: 1, question: 'q1', status: 'error', answer: 'ERROR: x' }));
  assert.strictEqual(st.data.counters.success, 1);
  assert.strictEqual(st.data.counters.error, 1);
  assert.strictEqual(st.data.accountUsage['us-a'], 2);
  assert.strictEqual(st.readResults().length, 2);
});

test('doneSet 重建：默认 error 算完成', () => {
  const st = mkRun();
  st.appendResult(row({}));
  st.appendResult(row({ questionIndex: 1, status: 'error' }));
  const done = st.doneSet();
  assert.ok(done.has(doneKey('B0A', 0)));
  assert.ok(done.has(doneKey('B0A', 1)), '与插件一致：错误行不重试');
});

test('--retry-errors 时 error 行视为未完成', () => {
  const st = mkRun();
  st.appendResult(row({}));
  st.appendResult(row({ questionIndex: 1, status: 'error' }));
  const done = st.doneSet({ retryErrors: true });
  assert.ok(done.has(doneKey('B0A', 0)));
  assert.ok(!done.has(doneKey('B0A', 1)));
});

test('★ 容忍进程被杀留下的半行 JSON', () => {
  const st = mkRun();
  st.appendResult(row({}));
  fs.appendFileSync(st.resultsPath, '{"asin":"B0A","questionIn');   // 半行
  assert.strictEqual(st.readResults().length, 1, '坏尾行应被忽略而不是抛错');
});

test('中间行损坏则报错（不是被杀导致的，说明文件有更大问题）', () => {
  const st = mkRun();
  st.appendResult(row({}));
  fs.appendFileSync(st.resultsPath, 'GARBAGE\n');
  st.appendResult(row({ questionIndex: 1 }));
  assert.throws(() => st.readResults(), /损坏/);
});

test('★ supersedeAsin：追加墓碑行，原行不再算完成', () => {
  const st = mkRun();
  st.appendResult(row({ questionIndex: 0 }));
  st.appendResult(row({ questionIndex: 1, question: 'q1' }));
  const n = st.supersedeAsin('B0A');
  assert.strictEqual(n, 2, '两行都应被作废');

  const done = st.doneSet();
  assert.strictEqual(done.size, 0, '作废后该 ASIN 应重跑');
  assert.strictEqual(st.readResults().length, 4, 'jsonl 是 append-only，历史保留可审计');
});

test('materializedResults：同 key 取最后一条并剔除墓碑', () => {
  const st = mkRun();
  st.appendResult(row({ questionIndex: 0, answer: 'first' }));
  st.supersedeAsin('B0A');
  st.appendResult(row({ questionIndex: 0, answer: 'redone', account: 'us-b' }));

  const out = st.materializedResults();
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].answer, 'redone');
  assert.strictEqual(out[0].account, 'us-b');
});

test('supersede 只影响指定 ASIN', () => {
  const st = mkRun();
  st.appendResult(row({ asin: 'B0A', questionIndex: 0 }));
  st.appendResult(row({ asin: 'B0B', questionIndex: 0 }));
  st.supersedeAsin('B0A');
  const done = st.doneSet();
  assert.ok(!done.has(doneKey('B0A', 0)));
  assert.ok(done.has(doneKey('B0B', 0)), 'B0B 不该受影响');
});

test('load 能读回已存在的 run', () => {
  const st = mkRun();
  st.appendResult(row({}));
  st.setStatus(STATUS.QUOTA_EXHAUSTED);
  const again = RunState.load(st.dir);
  assert.strictEqual(again.data.status, STATUS.QUOTA_EXHAUSTED);
  assert.strictEqual(again.readResults().length, 1);
});
