'use strict';
/**
 * 差分测试：把 content.js 里的原函数抽出来在沙箱中执行，
 * 与 cli/src/lib/sse-parser.js 的移植版逐输入对比输出。
 *
 * 这是"逐行同构"这一承诺的自动化保障 —— 插件侧一旦改动而 CLI 未同步，本测试即红。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const port = require('../src/lib/sse-parser.js');

// ---- 抽取插件原实现 ----
const CONTENT_JS = path.resolve(__dirname, '..', '..', 'content', 'content.js');
const src = fs.readFileSync(CONTENT_JS, 'utf8');
const start = src.indexOf('function isAssistantStreamingUrl');
const tail = src.indexOf('function normalizeComparable');
const end = src.indexOf('\n  }', tail) + '\n  }'.length;
assert.ok(start > 0 && tail > start, '未能在 content.js 中定位解析链；插件结构可能已变动');
const block = src.slice(start, end);

// 浏览器里 textarea.innerHTML 解码实体的等价 shim（仅供沙箱使用）
const sandbox = {
  document: {
    createElement() {
      let _v = '';
      return {
        set innerHTML(html) { _v = port.stripHtmlEntities(html); },
        get value() { return _v; },
      };
    },
  },
};
vm.createContext(sandbox);
const NAMES = [
  'isAssistantStreamingUrl', 'extractAnswerFromAssistantSse', 'extractSseDataPayloads',
  'extractAnswerFromAssistantSseLegacy', 'extractAnswerFromJsonPatches',
  'applyJsonPatchStream', 'textFromNode', 'parsePointer',
  'collectAssistantPatchText', 'buildAnswerFromTextPatches', 'extractAnswerFromNetworkText',
  'splitStreamSegments', 'tryParseJson', 'collectRegexTextCandidates', 'collectTextCandidates',
  'isPreferredTextKey', 'cleanCandidateText', 'isUsefulAnswerText', 'isRelatedQuestionText',
  'normalizeComparable',
];
vm.runInContext(`${block}\n;__orig = {${NAMES.join(',')}};`, sandbox);
const orig = sandbox.__orig;

test('抽取到的原函数数量与移植版一致', () => {
  for (const n of NAMES) {
    assert.strictEqual(typeof orig[n], 'function', `原实现缺少 ${n}`);
    assert.strictEqual(typeof port[n], 'function', `移植版缺少 ${n}`);
  }
});

// ---- 语料 ----
const QUESTION = 'What are the most common complaints about this product?';
const ANSWER = 'Customers most often complain that the battery drains quickly and the strap feels flimsy after a few weeks of daily use.';

function sseFrame(obj) { return `event:message\nid:1\ndata:${JSON.stringify(obj)}\n\n`; }

const patchStream =
  sseFrame({ groupId: 'markdown_processor_1', path: '/content', value: { type: 'text', children: 'Customers most often complain that' } }) +
  sseFrame({ groupId: 'markdown_processor_1', path: '/content', value: { type: 'text', children: 'Customers most often complain that the battery drains quickly' } }) +
  sseFrame({ groupId: 'markdown_processor_1', path: '/content', value: { type: 'text', children: ANSWER } }) +
  sseFrame({ groupId: 'related_questions', value: { type: 'text', children: 'How long does the battery last?' } }) +
  sseFrame({ groupId: 'markdown_processor_1', value: { type: 'text', children: 'Thinking.' } });

const entityStream = sseFrame({
  groupId: 'markdown_processor_x',
  value: { type: 'text', children: 'It&rsquo;s rated 4.5&nbsp;stars &amp; ships free &mdash; buyers say it&#39;s worth it overall.' },
});

const genericJson = JSON.stringify({
  answer: ANSWER,
  related: ['Is it waterproof?'],
  meta: { url: 'https://example.com/x', verb: 'GET /api/thing' },
});

const CORPUS = [
  patchStream,
  entityStream,
  genericJson,
  `data:${genericJson}\n[DONE]\n`,
  'data:{"delta":"short"}\ndata:{"delta":"' + ANSWER + '"}\n',
  '',
  'not json at all\njust text lines\n',
  sseFrame({ groupId: 'markdown_processor', value: { type: 'text', children: ANSWER } }).repeat(3),
];

test('extractAnswerFromAssistantSse（入口）：全语料输出逐字节一致', () => {
  for (const raw of CORPUS) {
    assert.strictEqual(
      port.extractAnswerFromAssistantSse(raw, QUESTION),
      orig.extractAnswerFromAssistantSse(raw, QUESTION),
      `语料差异:\n${raw.slice(0, 120)}`
    );
  }
});

test('extractAnswerFromAssistantSseLegacy：兜底路径逐字节一致', () => {
  for (const raw of CORPUS) {
    assert.strictEqual(
      port.extractAnswerFromAssistantSseLegacy(raw, QUESTION),
      orig.extractAnswerFromAssistantSseLegacy(raw, QUESTION),
      `语料差异:\n${raw.slice(0, 120)}`
    );
  }
});

test('★ extractAnswerFromJsonPatches：主路在真实流上与插件逐字节一致', () => {
  const REAL = fs.readFileSync(path.join(__dirname, 'fixtures', 'alexa-sse-jsonpatch.txt'), 'utf8');
  const Q = 'What are the most common complaints in the negative reviews for this product?';
  const a = port.extractAnswerFromJsonPatches(REAL, Q);
  const b = orig.extractAnswerFromJsonPatches(REAL, Q);
  assert.ok(a.length > 500, '移植版应重建出实质答案');
  assert.strictEqual(a, b, '插件与 CLI 的 JSON Patch 重建结果必须一致');
});

test('★ 插件入口在真实流上也走主路（不再产出重复碎片）', () => {
  const REAL = fs.readFileSync(path.join(__dirname, 'fixtures', 'alexa-sse-jsonpatch.txt'), 'utf8');
  const Q = 'What are the most common complaints in the negative reviews for this product?';
  const viaPlugin = orig.extractAnswerFromAssistantSse(REAL, Q);
  const opening = (viaPlugin.match(/Based on customer reviews for the/g) || []).length;
  assert.strictEqual(opening, 1, `插件修复后开场白应只出现一次，实得 ${opening} 次`);
  assert.ok(!viaPlugin.includes('[**'), '插件修复后不应残留 markdown 碎片');
});

test('extractAnswerFromNetworkText：全语料输出逐字节一致', () => {
  for (const raw of CORPUS) {
    assert.strictEqual(
      port.extractAnswerFromNetworkText(raw, QUESTION),
      orig.extractAnswerFromNetworkText(raw, QUESTION),
      `语料差异:\n${raw.slice(0, 120)}`
    );
  }
});

test('extractSseDataPayloads / splitStreamSegments：结构一致', () => {
  for (const raw of CORPUS) {
    // sandbox 返回的数组来自另一个 realm，原型不同 —— 用 Array.from 归一化后再比值
    assert.deepStrictEqual(port.extractSseDataPayloads(raw), Array.from(orig.extractSseDataPayloads(raw)));
    assert.deepStrictEqual(port.splitStreamSegments(raw), Array.from(orig.splitStreamSegments(raw)));
  }
});

test('collectAssistantPatchText：递归收集结果一致', () => {
  const objs = CORPUS.map((c) => port.tryParseJson(c)).filter((v) => v !== undefined);
  objs.push({ groupId: 'markdown_processor', value: { type: 'text', children: 'x'.repeat(30) } });
  objs.push({ a: { b: [{ path: 'markdown_processor/y', type: 'text', children: 'nested '.repeat(5) }] } });
  for (const o of objs) {
    const A = []; const B = [];
    port.collectAssistantPatchText(o, A);
    orig.collectAssistantPatchText(o, B);
    assert.deepStrictEqual(A, B);
  }
});

test('URL 判定：rufus / alexa / 兜底 / 负例 全一致', () => {
  const urls = [
    'https://www.amazon.com/rufus/cl/streaming?x=1',
    'https://www.amazon.com/alexa/cl/streaming',
    'https://www.amazon.com/ALEXA/CL/STREAMING',
    'https://www.amazon.com/api/cl/streaming/v2',
    'https://www.amazon.com/dp/B0XXXXXXXX',
    '', null, undefined,
  ];
  for (const u of urls) {
    assert.strictEqual(port.isAssistantStreamingUrl(u), orig.isAssistantStreamingUrl(u), `URL: ${u}`);
  }
});

test('各纯谓词/清洗函数：逐输入一致', () => {
  const texts = [
    '', 'short', ANSWER, QUESTION, 'GET /api/x  is here for sure',
    'https://example.com/a/b/c', 'Is it waterproof?', 'How do I clean the strap properly',
    'line1\\nline2   with   spaces', '  padded  ', 'It&amp;s fine &mdash; really',
    'thinking.', 'Source:', 'x'.repeat(200),
  ];
  for (const t of texts) {
    assert.strictEqual(port.cleanCandidateText(t), orig.cleanCandidateText(t), `clean: ${t}`);
    assert.strictEqual(port.normalizeComparable(t), orig.normalizeComparable(t), `norm: ${t}`);
    assert.strictEqual(port.isUsefulAnswerText(t, QUESTION), orig.isUsefulAnswerText(t, QUESTION), `useful: ${t}`);
    assert.strictEqual(port.isRelatedQuestionText(t), orig.isRelatedQuestionText(t), `related: ${t}`);
  }
  for (const k of ['text', 'content', 'children', 'markdown', 'randomKey', '', 'VALUE']) {
    assert.strictEqual(port.isPreferredTextKey(k), orig.isPreferredTextKey(k), `key: ${k}`);
  }
});

test('buildAnswerFromTextPatches：递增重写去重逻辑一致', () => {
  const cases = [
    ['abc', 'abc def', 'abc def ghi'].map((s) => s + ' padded to length twelve plus'),
    ['same text repeated here', 'same text repeated here'],
    [],
    ['Thinking.', 'Source:', ANSWER],
  ];
  for (const c of cases) {
    assert.strictEqual(
      port.buildAnswerFromTextPatches(c, QUESTION),
      orig.buildAnswerFromTextPatches(c, QUESTION)
    );
  }
});

test('移植版能正确拼出完整答案（不只是与原版相等）', () => {
  const out = port.extractAnswerFromAssistantSse(patchStream, QUESTION);
  assert.strictEqual(out, ANSWER, '应只保留最长的那版重写，且滤掉相关问题与 Thinking');
});

test('实体解码：数字实体与命名实体都能解（原版靠浏览器 textarea）', () => {
  assert.strictEqual(port.stripHtmlEntities('a &amp; b'), 'a & b');
  assert.strictEqual(port.stripHtmlEntities('It&rsquo;s'), 'It’s');
  assert.strictEqual(port.stripHtmlEntities('&#39;quoted&#39;'), "'quoted'");
  assert.strictEqual(port.stripHtmlEntities('&#x2014;'), '—');
  assert.strictEqual(port.stripHtmlEntities('4.5&nbsp;stars'), '4.5 stars');
  assert.strictEqual(port.stripHtmlEntities('&unknownentity;'), '&unknownentity;', '不认识的实体原样保留');
  assert.strictEqual(port.stripHtmlEntities('plain'), 'plain');
});
