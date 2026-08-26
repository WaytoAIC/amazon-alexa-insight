'use strict';
/**
 * 流截断回归。
 *
 * 2026-08-26 实测定位：Alexa 单题原始 SSE 流已达 288KB，而 hook 沿用插件的
 * 300KB 上限，超限时 slice(-MAX) 保留尾部丢弃头部。JSON Patch 流创建根节点的
 * `op:add path:"/"` 就在最开头 —— 根一丢，后续 patch 全被跳过，答案静默变空，
 * 主路白等 60 秒后回落 DOM（还可能抓到面板样板）。
 *
 * 本组测试锁住：① 丢头必然导致重建失败 ② hook 上限足够大 ③ 截断被显式标记
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const sse = require('../src/lib/sse-parser.js');

const RAW = fs.readFileSync(path.join(__dirname, 'fixtures', 'alexa-sse-jsonpatch.txt'), 'utf8');
const Q = 'What are the most common complaints in the negative reviews for this product?';
const HOOK_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'inject', 'collector-hook.js'), 'utf8');

test('完整流能正常重建', () => {
  assert.ok(sse.extractAnswerFromJsonPatches(RAW, Q).length > 500);
});

test('★ 丢掉头部后重建必然失败（这就是偶发失败的根因）', () => {
  // 只切掉 4KB 头部就足以让整条流失效
  for (const cap of [RAW.length - 4000, 100000, 80000]) {
    const tail = RAW.slice(-cap);
    assert.strictEqual(
      sse.extractAnswerFromJsonPatches(tail, Q).length, 0,
      `保留尾部 ${cap} 字符仍应失效（根节点 patch 在头部）`
    );
  }
});

test('保留头部则仍可部分重建（证明是丢头而非长度本身的问题）', () => {
  const head = RAW.slice(0, 60000);
  assert.ok(sse.extractAnswerFromJsonPatches(head, Q).length > 0,
    '保留头部时应能重建出内容，说明问题出在截断方向而非截断本身');
});

test('★ hook 的上限必须远大于实测流长度', () => {
  const m = HOOK_SRC.match(/MAX_NETWORK_RAW_CHARS\s*=\s*(\d+)/);
  assert.ok(m, '应能读到 MAX_NETWORK_RAW_CHARS');
  const cap = Number(m[1]);
  const OBSERVED_MAX = 288031;   // 2026-08-26 实测单题最大原始流
  assert.ok(cap >= OBSERVED_MAX * 5,
    `上限 ${cap} 相对实测最大值 ${OBSERVED_MAX} 余量不足（要求 ≥5 倍）`);
});

test('★ hook 截断时必须打标记，不能静默', () => {
  assert.match(HOOK_SRC, /stream\.truncated\s*=\s*true/, '截断处应设置 truncated 标记');
  assert.match(HOOK_SRC, /truncated:\s*!!s\.truncated/, 'pull 时应把 truncated 回传给 Node 侧');
});

test('hook 有内存上限，避免长会话累积', () => {
  assert.match(HOOK_SRC, /MAX_KEPT_STREAMS/, '应有保留条数上限');
});

test('collector 收到 truncated 流会显式报错而非静默等超时', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'collector.js'), 'utf8');
  assert.match(src, /stream\.truncated/, '应检查 truncated');
  assert.match(src, /根节点丢失/, '错误信息应说清原因');
});
