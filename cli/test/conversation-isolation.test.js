'use strict';
/**
 * 会话隔离：每个 ASIN 必须在全新的 Alexa 对话里提问，串台的行必须被标出来。
 *
 * 2026-10-27 实测踩到（runs/voc-comp-20261027）：COSY HOMEER B09M7WWTFP 的第 1 题回答
 * 里出现「the MontVoo jute treads we discussed earlier」—— MontVoo 是上一个 run 问的商品。
 * 采集器从不开新对话，竞品对照的结论被上一个商品的上下文污染，且 status 仍是 success。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const conversation = require('../src/lib/conversation.js');
const collector = require('../src/lib/collector.js');

const RAW = fs.readFileSync(path.join(__dirname, 'fixtures', 'alexa-sse-jsonpatch.txt'), 'utf8');
const QUESTION = 'What are the most common complaints in the negative reviews for this product?';

// 实测串台原句（B09M7WWTFP 第 1 题）
const REAL_LEAK = 'Important Context: The COSY HOMEER Edging Stair Treads has an exceptionally high 82% '
  + 'five-star rating with 8,728 reviews—significantly stronger than the MontVoo jute treads we '
  + 'discussed earlier. Negative reviews are a small minority (7% are 1-3 stars).';

const CLEAN = 'Based on 8,728 total ratings for the COSY HOMEER Edging Stair Treads, only 7% of reviewers '
  + 'rated it 1-3 stars. The most common complaints are adhesive backing losing grip after washing.';

// ---- 纯函数 ----

test('threadId 从真实 SSE 样本中取出', () => {
  assert.strictEqual(conversation.extractThreadId(RAW), 'THREAD-REDACTED');
  assert.strictEqual(conversation.extractThreadId(''), '');
  assert.strictEqual(conversation.extractThreadId(null), '');
});

test('★ 回归：实测串台原句在新对话第一题必须被标出', () => {
  const reasons = conversation.detectContextLeak({
    asin: 'B09M7WWTFP', answer: REAL_LEAK, threadId: 'T2', threadOwners: new Map(),
    isFirstInConversation: true, conversationFresh: true,
  });
  assert.strictEqual(reasons.length, 1);
  assert.match(reasons[0], /^back_reference:.*discussed earlier/);
});

test('干净回答不被标记', () => {
  const reasons = conversation.detectContextLeak({
    asin: 'B09M7WWTFP', answer: CLEAN, threadId: 'T2', threadOwners: new Map([['T1', 'B0FMJCMKY1']]),
    isFirstInConversation: true, conversationFresh: true,
  });
  assert.deepStrictEqual(reasons, []);
});

test('新对话里后续题回指本 ASIN 前几题是正常的，不算串台', () => {
  // 实测 B07ZNXYCB6 第 16 题："Based on customer reviews and the alternatives compared earlier"
  // 指的是本 ASIN 第 15 题的对比 —— 同一对话内的正常回指
  const answer = 'Based on customer reviews and the alternatives compared earlier, here is where competitors do better.';
  const args = { asin: 'B07ZNXYCB6', answer, threadId: 'T3', threadOwners: new Map([['T3', 'B07ZNXYCB6']]) };
  assert.deepStrictEqual(
    conversation.detectContextLeak({ ...args, isFirstInConversation: false, conversationFresh: true }), []);
  // 但若没能确认开了新对话，就分不清它回指的是谁，必须标出
  assert.strictEqual(
    conversation.detectContextLeak({ ...args, isFirstInConversation: false, conversationFresh: false }).length, 1);
});

test('★ 另一个 ASIN 的回答落进同一 threadId = 串台实锤（无论措辞）', () => {
  const owners = new Map([['T1', 'B0FMJCMKY1']]);
  const base = { answer: CLEAN, threadId: 'T1', threadOwners: owners, isFirstInConversation: false, conversationFresh: true };
  assert.deepStrictEqual(
    conversation.detectContextLeak({ ...base, asin: 'B09M7WWTFP' }), ['shared_thread:B0FMJCMKY1']);
  assert.deepStrictEqual(conversation.detectContextLeak({ ...base, asin: 'B0FMJCMKY1' }), []);
});

test('网络主路把回答所在的 threadId 带出来', async () => {
  const page = {
    evaluate: async () => ({ streams: [{ url: 'https://www.amazon.com/rufus/cl/streaming', raw: RAW, complete: true }] }),
  };
  const r = await collector.waitForNetworkAnswer(page, 0, QUESTION, { checkInterval: 0.01, maxWaitTime: 2 });
  assert.ok(r.answer.length > 0);
  assert.strictEqual(r.threadId, 'THREAD-REDACTED');
});

test('找不到 New chat 控件时如实返回 none，不谎报已重置', async () => {
  const page = { evaluate: async () => null };   // countResponses 与控件查找都拿不到东西
  const r = await collector.startNewConversation(page);
  assert.strictEqual(r.method, 'none');
  assert.strictEqual(r.verified, false);
});

// ---- 编排层：collect 在每个 ASIN 开问前都必须重置对话 ----

/**
 * 用假浏览器跑一遍真实的 collect 编排。fakeAlexa 决定每次提问返回哪个 threadId，
 * 以此模拟"重置生效"和"重置失效（仍在旧对话里）"两种情况。
 */
async function runCollect({ resetWorks }) {
  const browser = require('../src/lib/browser.js');
  const guard = require('../src/lib/guard.js');
  const { AccountPool } = require('../src/lib/account-pool.js');
  const { Pacer } = require('../src/lib/pacing.js');

  const events = [];
  let thread = 1;
  let currentAsin = '';

  const page = {
    isClosed: () => false,
    url: () => 'https://www.amazon.com/dp/x',
    goto: async (url) => { currentAsin = url.split('/dp/')[1]; events.push(`goto:${currentAsin}`); },
    reload: async () => { events.push('reload'); },
    evaluate: async () => null,
  };
  const ctx = { close: async () => {}, browser: () => ({ isConnected: () => true }) };

  const saved = {
    launch: browser.launchForAccount, firstPage: browser.firstPage, check: guard.check, load: AccountPool.load,
    pacer: { ...Pacer.prototype },
    c: { ...collector },
  };
  browser.launchForAccount = async () => ({ context: ctx });
  browser.firstPage = async () => page;
  guard.check = async () => null;
  const account = { id: 'fake' };
  AccountPool.load = () => ({
    accounts: [account],
    acquire: () => account,
    mark: () => {},
    recordQuestion: () => {},
    shouldYield: () => false,
  });
  for (const m of ['settle', 'afterQuestion', 'afterAsin', 'afterAccountSwitch']) Pacer.prototype[m] = async () => {};
  collector.collectMetadata = async () => ({ productTitle: `title ${currentAsin}`, price: '$1' });
  collector.openAssistantChat = async () => { events.push(`open:${currentAsin}`); return true; };
  collector.startNewConversation = async () => {
    events.push(`reset:${currentAsin}`);
    if (!resetWorks) return { method: 'none', verified: false, historyBefore: 2, historyAfter: 2 };
    thread++;
    return { method: 'new-chat-button', control: 'fake', verified: true, historyBefore: 2, historyAfter: 0 };
  };
  collector.clearConversationStorage = async () => [];
  collector.askAndCapture = async (_p, q) => {
    events.push(`ask:${currentAsin}`);
    return { answer: `answer about ${currentAsin} for ${q}`, source: 'network', elapsedMs: 1, threadId: `T${thread}` };
  };

  const qFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apinsight-q-')), 'q.txt');
  fs.writeFileSync(qFile, 'Q one?\nQ two?\n');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apinsight-run-'));

  try {
    // 必须在打桩之后才加载 collect.js：它在加载时解构 browser.js 的导出
    delete require.cache[require.resolve('../src/commands/collect.js')];
    const { collect } = require('../src/commands/collect.js');
    const res = await collect({
      asins: 'B0AAAAAAA1,B0BBBBBBB2', questions: qFile, outDir, runId: 'iso-test',
      delayQ: '0,0', delayAsin: '0,0', breakEvery: 0,
    });
    const rows = fs.readFileSync(path.join(res.dir, 'results.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    return { events, rows, counters: res.counters };
  } finally {
    browser.launchForAccount = saved.launch;
    browser.firstPage = saved.firstPage;
    guard.check = saved.check;
    AccountPool.load = saved.load;
    Object.assign(Pacer.prototype, saved.pacer);
    Object.assign(collector, saved.c);
  }
}

test('★ 回归：每个 ASIN 开问前都先重置对话（含第一个 ASIN）', async () => {
  const { events } = await runCollect({ resetWorks: true });
  for (const asin of ['B0AAAAAAA1', 'B0BBBBBBB2']) {
    const open = events.indexOf(`open:${asin}`);
    const reset = events.indexOf(`reset:${asin}`);
    const ask = events.indexOf(`ask:${asin}`);
    assert.ok(open >= 0 && reset > open && ask > reset, `${asin} 的顺序应为 open → reset → ask，实际 ${events.join(' ')}`);
  }
});

test('重置生效：每个 ASIN 各自一个 thread，没有行被标串台', async () => {
  const { rows, counters } = await runCollect({ resetWorks: true });
  assert.strictEqual(rows.length, 4);
  assert.ok(rows.every((r) => r.status === 'success' && !r.contextLeak && r.conversationReset === 'new-chat-button'));
  assert.notStrictEqual(rows[0].threadId, rows[2].threadId);
  assert.strictEqual(counters.contextLeak, 0);
});

test('★ 重置失效：第二个 ASIN 落进第一个 ASIN 的 thread，整行标 contextLeak', async () => {
  const { rows, counters } = await runCollect({ resetWorks: false });
  const second = rows.filter((r) => r.asin === 'B0BBBBBBB2');
  assert.strictEqual(second.length, 2);
  for (const r of second) assert.deepStrictEqual(r.contextLeak, ['shared_thread:B0AAAAAAA1']);
  assert.ok(rows.filter((r) => r.asin === 'B0AAAAAAA1').every((r) => !r.contextLeak));
  assert.strictEqual(counters.contextLeak, 2);
});
