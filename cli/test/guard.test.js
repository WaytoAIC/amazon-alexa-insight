'use strict';
/**
 * 守卫判定测试。用假 page 驱动 check()，不需要真浏览器。
 * 重点回归实测踩到的坑：已登录页面被误判成 signin。
 */
const test = require('node:test');
const assert = require('node:assert');
const guard = require('../src/lib/guard.js');

/** 造一个假 page：evaluate 直接返回预设的 probe 结果 */
function fakePage(url, probe) {
  return {
    url: () => url,
    evaluate: async (fn) => {
      // isLoggedIn / settleForAuth 传的是取账号栏的小函数，check 传的是 domProbe
      if (fn === guard.domProbe) return probe;
      return probe.accountLine;
    },
  };
}

const OK_PROBE = {
  url: 'https://www.amazon.com/', title: 'Amazon.com',
  hasCaptchaForm: false, hasCaptchaImg: false, hasSigninForm: false,
  saysRobot: false, saysDog: false, saysNotFound: false,
  accountLine: 'Hello, Henry',
};

test('正常已登录页面 → 无异常', async () => {
  assert.strictEqual(await guard.check(fakePage('https://www.amazon.com/dp/B0X', OK_PROBE)), null);
});

test('★ 回归：已登录页面上出现登录表单，不得判成 signin', async () => {
  // 实测踩过：Amazon 在 domcontentloaded 时初始 HTML 带隐藏登录表单，
  // 而账号栏明明是 "Hello, Henry" —— 误判会把好账号标成失效、拖垮整个池
  const probe = { ...OK_PROBE, hasSigninForm: true, accountLine: 'Hello, Henry' };
  const r = await guard.check(fakePage('https://www.amazon.com/', probe));
  assert.strictEqual(r, null, '账号栏显示已登录时，登录表单不构成 signin 判定');
});

test('未登录 + 可见登录表单 → signin', async () => {
  const probe = { ...OK_PROBE, hasSigninForm: true, accountLine: 'Hello, sign in' };
  const r = await guard.check(fakePage('https://www.amazon.com/', probe));
  assert.strictEqual(r.type, 'signin');
});

test('URL 命中 /ap/signin → signin（权威信号，不看 DOM）', async () => {
  const r = await guard.check(fakePage('https://www.amazon.com/ap/signin?x=1', OK_PROBE));
  assert.strictEqual(r.type, 'signin');
  assert.match(r.detail, /URL 命中/);
});

test('URL 命中 validateCaptcha → robot_check', async () => {
  const r = await guard.check(fakePage('https://www.amazon.com/errors/validateCaptcha', OK_PROBE));
  assert.strictEqual(r.type, 'robot_check');
});

test('可见验证码表单 → robot_check（即使账号栏显示已登录）', async () => {
  const probe = { ...OK_PROBE, hasCaptchaForm: true };
  const r = await guard.check(fakePage('https://www.amazon.com/', probe));
  assert.strictEqual(r.type, 'robot_check');
});

test('验证码文案 → robot_check', async () => {
  const probe = { ...OK_PROBE, saysRobot: true };
  assert.strictEqual((await guard.check(fakePage('https://www.amazon.com/', probe))).type, 'robot_check');
});

test('狗页 → dog；404 页 → not_found', async () => {
  assert.strictEqual((await guard.check(fakePage('https://x/', { ...OK_PROBE, saysDog: true }))).type, 'dog');
  assert.strictEqual((await guard.check(fakePage('https://x/', { ...OK_PROBE, saysNotFound: true }))).type, 'not_found');
});

test('evaluate 抛错（导航中）→ 返回 null 交上层重试，不误报', async () => {
  const page = { url: () => 'https://www.amazon.com/', evaluate: async () => { throw new Error('navigating'); } };
  assert.strictEqual(await guard.check(page), null);
});

test('accountLineSaysLoggedIn 的判定', () => {
  const f = guard.accountLineSaysLoggedIn;
  assert.strictEqual(f('Hello, Henry'), true);
  assert.strictEqual(f('Hello, sign in'), false);
  assert.strictEqual(f('Sign in'), false);
  assert.strictEqual(f(''), false, '空账号栏不能当作已登录');
  assert.strictEqual(f(null), false);
  assert.strictEqual(f('你好，登录'), false);
});

test('isLoggedIn 需要账号栏与鉴权 cookie 双满足', async () => {
  const ctx = (names) => ({ cookies: async () => names.map((n) => ({ name: n, domain: '.amazon.com' })) });
  const page = fakePage('https://www.amazon.com/', OK_PROBE);

  let r = await guard.isLoggedIn(ctx(['x-main', 'at-main']), page);
  assert.strictEqual(r.loggedIn, true);

  r = await guard.isLoggedIn(ctx(['x-main']), page);
  assert.strictEqual(r.loggedIn, false, '缺 at-main 不算登录');

  r = await guard.isLoggedIn(ctx(['x-main', 'at-main']), fakePage('u', { ...OK_PROBE, accountLine: 'Hello, sign in' }));
  assert.strictEqual(r.loggedIn, false, 'cookie 在但账号栏说未登录，不算登录');
});
