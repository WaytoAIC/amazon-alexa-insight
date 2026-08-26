'use strict';
/**
 * 导出层测试。CSV 部分同样用差分：抽 background.js 的 buildResultsCsv 与移植版对比，
 * 保证"与插件逐字节一致"这个验收目标成立。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ex = require('../src/lib/exporter.js');

// ---- 抽取插件原实现 ----
const BG = path.resolve(__dirname, '..', '..', 'background', 'background.js');
const src = fs.readFileSync(BG, 'utf8');
const start = src.indexOf('function buildResultsCsv');
const escStart = src.indexOf('function csvEscape');
const escEnd = src.indexOf('\n}', escStart) + 2;
assert.ok(start > 0 && escStart > start, '未能在 background.js 中定位 CSV 构建；插件结构可能已变动');
const block = src.slice(start, escEnd);
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${block}\n;__orig = { buildResultsCsv, csvEscape };`, sandbox);
const orig = sandbox.__orig;

const SAMPLE = [
  {
    asin: 'B0CZ7QK2LM',
    productTitle: 'Acme Widget, "Pro" Edition',
    price: '$29.99',
    category: '核心必问',
    question: 'What are the most common complaints?',
    answer: 'Buyers mention the strap breaks.\nAlso the battery drains fast.',
    answerEn: 'Buyers mention the strap breaks.\nAlso the battery drains fast.',
    status: 'success',
    timestamp: '2026-08-26T10:00:00.000Z',
    account: 'us-a', runId: 'r1', questionIndex: 0, categoryId: 'summary_all',
  },
  {
    asin: 'B0DGHT9QW1',
    productTitle: '',
    price: '',
    category: '负面评价',
    question: 'Any quality issues?',
    answer: 'ERROR: timeout after 75s',
    answerEn: '',
    status: 'error',
    timestamp: '2026-08-26T10:02:00.000Z',
    account: 'us-b',
  },
];

test('★ CSV 与插件 background 版逐字节一致', () => {
  assert.strictEqual(ex.buildResultsCsv(SAMPLE), orig.buildResultsCsv(SAMPLE));
});

test('csvEscape 与插件一致（含引号、换行、逗号）', () => {
  for (const v of ['plain', 'has "quotes"', 'a,b', 'line1\nline2', '', 0, null, undefined, '中文']) {
    assert.strictEqual(ex.csvEscape(v), orig.csvEscape(v), `值: ${v}`);
  }
});

test('CSV 带 BOM 且表头为插件的 9 列', () => {
  const csv = ex.buildResultsCsv(SAMPLE);
  assert.ok(csv.startsWith('﻿'), '必须带 BOM（Excel 兼容）');
  const header = csv.slice(1).split('\n')[0];
  assert.strictEqual(header,
    'ASIN,Product Title,Price,Category,Question,Answer,Answer (EN),Status,Timestamp');
});

test('CSV 全字段转义（不复刻 popup 版漏转义 asin/status/timestamp 的 bug）', () => {
  const csv = ex.buildResultsCsv(SAMPLE).slice(1);
  // 注意：answer 字段内含换行，不能按 '\n' 切行 —— 直接在全文上断言
  assert.ok(csv.includes('\n"B0CZ7QK2LM",'), 'asin 也应带引号');
  assert.ok(csv.includes('""Pro""'), '内嵌引号应翻倍转义');
  assert.ok(csv.includes('"success"'), 'status 也应带引号（popup 版漏了）');
  assert.ok(csv.includes('"2026-08-26T10:00:00.000Z"'), 'timestamp 也应带引号（popup 版漏了）');
});

test('★ superseded 行不进导出（换号后作废的半截 ASIN）', () => {
  const withDead = [...SAMPLE, { ...SAMPLE[0], asin: 'B0DEAD00001', superseded: true }];
  const csv = ex.buildResultsCsv(withDead);
  assert.ok(!csv.includes('B0DEAD00001'), 'superseded 行必须被排除');
  // 字段内含换行，行数不可靠 —— 改用有效行计数与完全相等来断言
  assert.strictEqual(ex.activeResults(withDead).length, 2, '只应保留 2 行有效数据');
  assert.strictEqual(csv, ex.buildResultsCsv(SAMPLE), '排除后应与原样本输出完全相同');
});

test('内部附加字段不外泄到 CSV', () => {
  const csv = ex.buildResultsCsv(SAMPLE);
  for (const f of ['runId', 'questionIndex', 'categoryId', 'captureSource', 'elapsedMs']) {
    assert.ok(!csv.includes(f), `${f} 不应出现在 CSV 里`);
  }
  assert.ok(!csv.includes('us-a'), '默认不含 account 列');
});

test('--with-account 才追加 Account 列', () => {
  const csv = ex.buildResultsCsv(SAMPLE, { withAccount: true }).slice(1);
  assert.ok(csv.split('\n')[0].endsWith(',Account'));
  assert.ok(csv.includes('"us-a"'));
});

test('JSON 外层结构与插件一致，并保留 totalQuestions=行数 的 quirk', () => {
  const obj = JSON.parse(ex.buildResultsJson(SAMPLE, { marketplace: 'US', totalAsins: 2 }));
  assert.deepStrictEqual(Object.keys(obj),
    ['exportDate', 'marketplace', 'totalAsins', 'totalQuestions', 'results']);
  assert.strictEqual(obj.totalAsins, 2);
  assert.strictEqual(obj.totalQuestions, 2, 'quirk：是结果行数而非每 ASIN 题数');
  assert.strictEqual(obj.results.length, 2);
});

test('JSON 的 results 只含 9 正式字段 + account', () => {
  const obj = JSON.parse(ex.buildResultsJson(SAMPLE));
  assert.deepStrictEqual(Object.keys(obj.results[0]).sort(),
    [...ex.RESULT_FIELDS, 'account'].sort());
});

test('文件名规则照抄插件', () => {
  const name = ex.exportFilename('US', 'csv', new Date('2026-08-26T10:30:45.123Z'));
  assert.strictEqual(name, 'alexa-insight-US-2026-08-26T10-30-45.csv');
});

test('successRow：不翻译时 answer 与 answerEn 同为原文', () => {
  const r = ex.successRow({
    asin: 'B0X', category: '核心必问', question: 'q', answer: 'the answer text',
    productTitle: 'T', price: '$1', timestamp: 'TS',
  });
  assert.strictEqual(r.answer, 'the answer text');
  assert.strictEqual(r.answerEn, 'the answer text');
  assert.strictEqual(r.status, 'success');
});

test('errorRow：title/price/answerEn 留空，answer 带 ERROR 前缀', () => {
  const r = ex.errorRow({ asin: 'B0X', category: 'c', question: 'q', error: 'boom', timestamp: 'TS' });
  assert.strictEqual(r.productTitle, '');
  assert.strictEqual(r.price, '');
  assert.strictEqual(r.answerEn, '');
  assert.strictEqual(r.answer, 'ERROR: boom');
  assert.strictEqual(r.status, 'error');
});

test('空结果集也能导出（只有表头）', () => {
  const csv = ex.buildResultsCsv([]);
  assert.strictEqual(csv, orig.buildResultsCsv([]));
});
