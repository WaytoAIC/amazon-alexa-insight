'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AccountPool, PoolExhaustedError, STATUS, EXIT_CODE } = require('../src/lib/account-pool.js');

let clock = new Date('2026-08-26T10:00:00').getTime();
const now = () => clock;

function mkPool(accounts = [
  { id: 'us-a', marketplace: 'US', maxPerDay: 5, enabled: true, proxy: null },
  { id: 'us-b', marketplace: 'US', maxPerDay: 5, enabled: true, proxy: null },
]) {
  const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apinsight-')), 'account-state.json');
  return new AccountPool({ accounts: JSON.parse(JSON.stringify(accounts)), state: {}, statePath, now });
}

test('sticky：当前账号可用就一直用，不做无谓切换', () => {
  const p = mkPool();
  const first = p.acquire();
  p.recordQuestion(first, 'success');
  assert.strictEqual(p.acquire().id, first.id, '第二次仍应返回同一账号');
});

test('撞日配额后在下一次 acquire 时换号', () => {
  const p = mkPool();
  const a = p.acquire();
  for (let i = 0; i < 5; i++) p.recordQuestion(a, 'success');   // maxPerDay = 5
  assert.strictEqual(p.remainingQuota(a), 0);
  assert.ok(p.shouldYield(a), '配额耗尽应让位');
  assert.notStrictEqual(p.acquire().id, a.id, '应切到另一个账号');
});

test('配额跨自然日自动重置', () => {
  const p = mkPool();
  const a = p.acquire();
  for (let i = 0; i < 5; i++) p.recordQuestion(a, 'success');
  assert.strictEqual(p.remainingQuota(a), 0);
  clock += 24 * 3600 * 1000;                                    // 次日
  assert.strictEqual(p.remainingQuota(a), 5, '跨日应重置');
  clock -= 24 * 3600 * 1000;
});

test('连续 3 次 error 转入 cooling，成功一次即清零计数', () => {
  const p = mkPool();
  const a = p.acquire();
  p.recordQuestion(a, 'error');
  p.recordQuestion(a, 'error');
  assert.strictEqual(p.stateOf(a.id).status, STATUS.ACTIVE, '两次还不该冷却');
  p.recordQuestion(a, 'success');
  assert.strictEqual(p.stateOf(a.id).consecutiveErrors, 0, '成功应清零');
  p.recordQuestion(a, 'error');
  p.recordQuestion(a, 'error');
  p.recordQuestion(a, 'error');
  assert.strictEqual(p.stateOf(a.id).status, STATUS.COOLING);
});

test('冷却到期自动回 active', () => {
  const p = mkPool();
  const a = p.acquire();
  for (let i = 0; i < 3; i++) p.recordQuestion(a, 'error');
  assert.strictEqual(p.stateOf(a.id).status, STATUS.COOLING);
  clock += 31 * 60 * 1000;                                      // 默认冷却 30min
  assert.strictEqual(p.stateOf(a.id).status, STATUS.ACTIVE);
  assert.strictEqual(p.stateOf(a.id).consecutiveErrors, 0);
});

test('robot check 标记为 captcha_blocked，且不会自动恢复', () => {
  const p = mkPool();
  const a = p.acquire();
  p.mark(a, 'robot_check');
  assert.strictEqual(p.stateOf(a.id).status, STATUS.CAPTCHA_BLOCKED);
  clock += 24 * 3600 * 1000;
  assert.strictEqual(p.stateOf(a.id).status, STATUS.CAPTCHA_BLOCKED, '只能人工恢复');
  clock -= 24 * 3600 * 1000;
});

test('signin 标记为 signin_expired', () => {
  const p = mkPool();
  const a = p.acquire();
  p.mark(a, 'signin');
  assert.strictEqual(p.stateOf(a.id).status, STATUS.SIGNIN_EXPIRED);
});

test('★ 池耗尽原因分支：全部配额满 → 退出码 5', () => {
  const p = mkPool();
  for (const acct of p.accounts) {
    for (let i = 0; i < 5; i++) p.recordQuestion(acct, 'success');
  }
  try {
    p.acquire();
    assert.fail('应抛 PoolExhaustedError');
  } catch (e) {
    assert.ok(e instanceof PoolExhaustedError);
    assert.strictEqual(e.reason, 'quota');
    assert.strictEqual(e.exitCode, EXIT_CODE.QUOTA);
  }
});

test('★ 池耗尽原因分支：有 captcha 账号 → 退出码 3（优先于配额）', () => {
  const p = mkPool();
  const [a, b] = p.accounts;
  p.mark(a, 'robot_check');
  for (let i = 0; i < 5; i++) p.recordQuestion(b, 'success');
  try {
    p.acquire();
    assert.fail('应抛');
  } catch (e) {
    assert.strictEqual(e.reason, 'captcha');
    assert.strictEqual(e.exitCode, EXIT_CODE.CAPTCHA);
    assert.match(e.message, /us-a/);
  }
});

test('★ 池耗尽原因分支：有 signin 失效账号 → 退出码 4', () => {
  const p = mkPool();
  const [a, b] = p.accounts;
  p.mark(a, 'signin');
  for (let i = 0; i < 5; i++) p.recordQuestion(b, 'success');
  try {
    p.acquire();
    assert.fail('应抛');
  } catch (e) {
    assert.strictEqual(e.reason, 'signin');
    assert.strictEqual(e.exitCode, EXIT_CODE.SIGNIN);
  }
});

test('选号在剩余配额相同时取最久未用的（LRU）', () => {
  const p = mkPool();
  const a = p.acquire();               // us-a 先被用
  clock += 1000;
  p.mark(a, 'signin');                 // us-a 出局
  const b = p.acquire();
  assert.strictEqual(b.id, 'us-b');
});

test('剩余配额多的优先', () => {
  const p = mkPool([
    { id: 'low', maxPerDay: 5, enabled: true },
    { id: 'high', maxPerDay: 50, enabled: true },
  ]);
  assert.strictEqual(p.acquire().id, 'high');
});

test('disabled 账号不参与选号，enable 后恢复 active', () => {
  const p = mkPool();
  p.setEnabled('us-a', false);
  assert.strictEqual(p.acquire().id, 'us-b');
  const a = p.accounts.find((x) => x.id === 'us-a');
  p.mark(a, 'robot_check');
  p.setEnabled('us-a', true);
  assert.strictEqual(p.stateOf('us-a').status, STATUS.ACTIVE, 'enable 应清掉异常状态');
});

test('状态写盘是原子的且可重新加载', () => {
  const p = mkPool();
  const a = p.acquire();
  p.recordQuestion(a, 'success');
  const onDisk = JSON.parse(fs.readFileSync(p.statePath, 'utf8'));
  assert.strictEqual(onDisk[a.id].questionsAsked, 1);
  assert.ok(!fs.existsSync(`${p.statePath}.tmp`), '临时文件应已被 rename 掉');
});

test('summary 输出运维需要的字段', () => {
  const p = mkPool();
  const s = p.summary();
  assert.deepStrictEqual(Object.keys(s[0]).sort(),
    ['cooldownUntil', 'enabled', 'hasProxy', 'id', 'lastIncident', 'marketplace', 'maxPerDay', 'remaining', 'status', 'used'].sort());
});

// ---- need 感知选号（避免把配额浪费在会被作废的半截 ASIN 上）----

test('★ 剩余配额够跑完整个 ASIN 时正常选号', () => {
  const p = mkPool([{ id: 'a', maxPerDay: 30, enabled: true }]);
  assert.strictEqual(p.acquire({ need: 24 }).id, 'a');
});

test('★ 当前账号配额不足以跑完整个 ASIN 时，换到够用的账号', () => {
  const p = mkPool([
    { id: 'low', maxPerDay: 30, enabled: true },
    { id: 'high', maxPerDay: 100, enabled: true },
  ]);
  const first = p.acquire({ need: 24 });          // high 剩余更多，先选它
  assert.strictEqual(first.id, 'high');
  for (let i = 0; i < 80; i++) p.recordQuestion(first, 'success');  // high 剩 20
  assert.strictEqual(p.remainingQuota(first), 20);
  assert.strictEqual(p.acquire({ need: 24 }).id, 'low', '不够跑完整个 ASIN 应换号');
});

test('★ 所有账号都不够跑完一个 ASIN → 不开工，抛配额耗尽（避免白烧请求）', () => {
  const p = mkPool([
    { id: 'a', maxPerDay: 30, enabled: true },
    { id: 'b', maxPerDay: 30, enabled: true },
  ]);
  for (const acct of p.accounts) for (let i = 0; i < 20; i++) p.recordQuestion(acct, 'success');
  // 两个都只剩 10 题
  assert.strictEqual(p.remainingQuota(p.accounts[0]), 10);
  try {
    p.acquire({ need: 24 });
    assert.fail('应抛 PoolExhaustedError');
  } catch (e) {
    assert.ok(e instanceof PoolExhaustedError);
    assert.strictEqual(e.reason, 'quota');
    assert.strictEqual(e.exitCode, EXIT_CODE.QUOTA);
    assert.match(e.message, /只剩 10 题/);
    assert.match(e.message, /allow-mixed-account/, '应提示可用的出路');
  }
});

test('need=1（混账号模式）时不受整段配额约束', () => {
  const p = mkPool([{ id: 'a', maxPerDay: 30, enabled: true }]);
  for (let i = 0; i < 25; i++) p.recordQuestion(p.accounts[0], 'success');  // 剩 5
  assert.strictEqual(p.acquire({ need: 1 }).id, 'a', '混账号模式下剩多少用多少');
});

test('无参 acquire 保持原行为（need 默认 1）', () => {
  const p = mkPool();
  assert.ok(p.acquire().id);
});
