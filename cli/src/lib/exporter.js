'use strict';
/**
 * 导出层 —— 与插件输出 schema 保持一致，保证 CLI 与插件跑出的文件可直接对照。
 *
 * ⚠️ SOURCE OF TRUTH:
 *   CSV      background/background.js:574-594（buildResultsCsv / csvEscape）
 *   JSON     popup/popup.js:636-642（exportResults 的 json 分支）
 *   文件名    background/background.js:552-553
 *
 * 采用 background 版而非 popup 版的 CSV：popup.js:649-654 漏转义了 asin/status/timestamp，
 * 那是 bug；background 版对全部字段转义，更安全。
 */

/** 结果行的 9 个正式字段，顺序即 CSV 列顺序 */
const RESULT_FIELDS = [
  'asin', 'productTitle', 'price', 'category',
  'question', 'answer', 'answerEn', 'status', 'timestamp',
];

const CSV_HEADERS = [
  'ASIN', 'Product Title', 'Price', 'Category',
  'Question', 'Answer', 'Answer (EN)', 'Status', 'Timestamp',
];

/** CLI 内部附加字段，只进 jsonl，不进正式导出 */
const INTERNAL_FIELDS = [
  'runId', 'questionIndex', 'categoryId', 'captureSource', 'elapsedMs', 'account', 'superseded',
];

function csvEscape(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/**
 * 剔除被换号作废的行。
 * 中途换账号时，前一账号已答的行会被标 superseded —— 因为 Alexa 回答按账号个性化，
 * 同一 ASIN 混用账号会导致结果不可比，所以整个 ASIN 由新账号重跑。
 */
function activeResults(results) {
  return results.filter((r) => !r.superseded);
}

/** 只保留 9 个正式字段，附加字段不外泄到导出文件 */
function toCanonicalRow(r) {
  const out = {};
  for (const f of RESULT_FIELDS) out[f] = r[f] || '';
  return out;
}

function buildResultsCsv(results, { withAccount = false } = {}) {
  const BOM = '﻿';
  const headers = withAccount ? [...CSV_HEADERS, 'Account'] : CSV_HEADERS;
  const rows = activeResults(results).map((r) => {
    const cells = RESULT_FIELDS.map((f) => r[f] || '');
    if (withAccount) cells.push(r.account || '');
    return cells.map(csvEscape).join(',');
  });
  return BOM + headers.join(',') + '\n' + rows.join('\n');
}

function buildResultsJson(results, { marketplace = 'US', totalAsins = 0, withAccount = true } = {}) {
  const rows = activeResults(results);
  return JSON.stringify({
    exportDate: new Date().toISOString(),
    marketplace,
    totalAsins,
    // ⚠️ 照搬插件的 quirk：这里是结果行数，不是每个 ASIN 的题数（popup.js:640）
    totalQuestions: rows.length,
    results: rows.map((r) => (withAccount
      ? { ...toCanonicalRow(r), account: r.account || '' }
      : toCanonicalRow(r))),
  }, null, 2);
}

/** 文件名规则照抄 background.js:552-553 */
function exportFilename(marketplace, ext, now = new Date()) {
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `alexa-insight-${marketplace}-${timestamp}.${ext}`;
}

/** 组装一条成功结果行（字段与 background.js:475-485 一致） */
function successRow({ asin, productTitle, price, category, question, answer, timestamp }) {
  return {
    asin,
    productTitle: productTitle || '',
    price: price || '',
    category,
    question,
    // CLI 不做翻译（mode 'none'）→ answer 与 answerEn 同为原文，与 background.js:462-474 一致
    answer: answer || '',
    answerEn: answer || '',
    status: 'success',
    timestamp: timestamp || new Date().toISOString(),
  };
}

/** 组装一条错误结果行（字段与 background.js:503-513 一致：title/price 留空、answerEn 留空） */
function errorRow({ asin, category, question, error, timestamp }) {
  return {
    asin,
    productTitle: '',
    price: '',
    category: category || '',
    question: question || '',
    answer: `ERROR: ${error}`,
    answerEn: '',
    status: 'error',
    timestamp: timestamp || new Date().toISOString(),
  };
}

module.exports = {
  RESULT_FIELDS,
  CSV_HEADERS,
  INTERNAL_FIELDS,
  csvEscape,
  activeResults,
  toCanonicalRow,
  buildResultsCsv,
  buildResultsJson,
  exportFilename,
  successRow,
  errorRow,
};
