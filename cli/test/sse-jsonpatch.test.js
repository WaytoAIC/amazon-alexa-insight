'use strict';
/**
 * JSON Patch 主路测试 —— 用 2026-08-26 从真实 Alexa 抓取并脱敏的 SSE 流。
 *
 * 背景：Alexa 的答案是 RFC 6902 JSON Patch 流，同一路径会被 replace 上百次。
 * 插件把见过的每个 value.children 全收集再靠"更长版本包含它"去重，会留下大量中间态碎片。
 * 本组测试锁住"按 patch 语义重建"这条主路的正确性。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const sse = require('../src/lib/sse-parser.js');

const RAW = fs.readFileSync(path.join(__dirname, 'fixtures', 'alexa-sse-jsonpatch.txt'), 'utf8');
const QUESTION = 'What are the most common complaints in the negative reviews for this product?';

test('真实流能被识别为 JSONPatches 格式', () => {
  const payloads = sse.extractSseDataPayloads(RAW).map(sse.tryParseJson).filter(Boolean);
  const jp = payloads.filter((o) => o.type === 'JSONPatches');
  assert.ok(jp.length > 50, `应有大量 JSONPatches 消息，实得 ${jp.length}`);
  const ops = jp.flatMap((o) => o.patches).map((p) => p.op);
  assert.ok(ops.includes('replace'), '应含 replace 操作');
  assert.ok(ops.includes('add'), '应含 add 操作');
});

test('★ 主路重建出干净答案', () => {
  const a = sse.extractAnswerFromJsonPatches(RAW, QUESTION);
  assert.ok(a.length > 500, `答案应有实质长度，实得 ${a.length}`);
  assert.match(a, /Based on customer reviews/);
  assert.match(a, /Reliability Issues/);
});

test('★ 回归：不得出现同一句的重复中间态', () => {
  const a = sse.extractAnswerFromJsonPatches(RAW, QUESTION);
  // 插件旧算法会产出「Based on customer reviews for the [**Blink Plus subscription」
  // 紧跟「Based on customer reviews for the」这种长短两版并存的碎片
  const opening = (a.match(/Based on customer reviews for the/g) || []).length;
  assert.strictEqual(opening, 1, `开场白应只出现一次，实得 ${opening} 次`);

  const reliability = (a.match(/Reliability Issues/g) || []).length;
  assert.strictEqual(reliability, 1, `小标题应只出现一次，实得 ${reliability} 次`);
});

test('★ 回归：不得残留 markdown 粗体标记碎片', () => {
  const a = sse.extractAnswerFromJsonPatches(RAW, QUESTION);
  assert.ok(!a.includes('[**'), '不应出现 [** 这类链接/粗体残渣');
  assert.ok(!/\*\*[A-Z]/.test(a), '不应出现 **Xxx 未闭合的粗体标记');
});

test('新旧算法对比：旧算法确实会产出重复碎片（证明修复有意义）', () => {
  const oldA = sse.extractAnswerFromAssistantSseLegacy(RAW, QUESTION);
  const opening = (oldA.match(/Based on customer reviews for the/g) || []).length;
  assert.ok(opening > 1, `旧算法应重复开场白（这正是被修的缺陷），实得 ${opening} 次`);
});

test('extractAnswerFromAssistantSse 会优先走主路', () => {
  const viaEntry = sse.extractAnswerFromAssistantSse(RAW, QUESTION);
  const viaPatch = sse.extractAnswerFromJsonPatches(RAW, QUESTION);
  assert.strictEqual(viaEntry, viaPatch, '入口函数应返回主路结果');
});

test('非 JSONPatches 流回落到插件旧算法（保证与插件一致的兜底仍在）', () => {
  const legacyStream = 'event:message\nid:1\ndata:'
    + JSON.stringify({ groupId: 'markdown_processor_1', value: { type: 'text', children: 'x'.repeat(40) } })
    + '\n\n';
  const viaEntry = sse.extractAnswerFromAssistantSse(legacyStream, QUESTION);
  const viaLegacy = sse.extractAnswerFromAssistantSseLegacy(legacyStream, QUESTION);
  assert.strictEqual(viaEntry, viaLegacy);
  assert.ok(viaEntry.length > 0);
});

test('JSON Pointer 解析', () => {
  assert.deepStrictEqual(sse.parsePointer('/'), []);
  assert.deepStrictEqual(sse.parsePointer('/children/0/children/1'), ['children', '0', 'children', '1']);
  assert.deepStrictEqual(sse.parsePointer('/a~1b'), ['a/b'], '~1 应解码为 /');
  assert.deepStrictEqual(sse.parsePointer('/a~0b'), ['a~b'], '~0 应解码为 ~');
  assert.strictEqual(sse.parsePointer('no-leading-slash'), null);
});

test('applyJsonPatchStream：replace 覆盖而非追加', () => {
  const msgs = [
    { type: 'JSONPatches', patches: [{ op: 'add', path: '/', groupId: 'markdown_processor_x', value: { type: 'container', children: [] } }] },
    { type: 'JSONPatches', patches: [{ op: 'add', path: '/children/0', groupId: 'markdown_processor_x', value: { type: 'text', children: 'first' } }] },
    { type: 'JSONPatches', patches: [{ op: 'replace', path: '/children/0', groupId: 'markdown_processor_x', value: { type: 'text', children: 'first version final' } }] },
  ];
  const trees = sse.applyJsonPatchStream(msgs);
  const out = [];
  sse.textFromNode(trees.get('markdown_processor_x'), out);
  const text = out.join('').trim();
  assert.ok(text.includes('first version final'));
  assert.ok(!/first(?! version)/.test(text.replace('first version final', '')), 'replace 掉的中间态不应残留');
});

test('只取 markdown_processor 分组，忽略相关问题等其他分组', () => {
  const msgs = [
    { type: 'JSONPatches', patches: [{ op: 'add', path: '/', groupId: 'markdown_processor_x', value: { type: 'text', children: 'the real answer text here' } }] },
    { type: 'JSONPatches', patches: [{ op: 'add', path: '/', groupId: 'related_questions_y', value: { type: 'text', children: 'Is it waterproof?' } }] },
  ];
  const raw = msgs.map((m) => `data:${JSON.stringify(m)}\n`).join('\n');
  const a = sse.extractAnswerFromJsonPatches(raw, QUESTION);
  assert.match(a, /the real answer text here/);
  assert.ok(!a.includes('waterproof'), '相关问题分组不应进入答案');
});
