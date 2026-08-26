'use strict';
/**
 * DOM 兜底路的质量闸门。
 *
 * 2026-08-26 实测踩到：网络主路超时后，DOM 兜底把面板的欢迎语 + 推荐问题列表 +
 * 反馈表单整段抓走（617 字），还被记成 status=success 入库。
 * 这类静默数据污染比报错更糟 —— 下游分析会把 UI 文案当成用户洞察。
 */
const test = require('node:test');
const assert = require('node:assert');
const { isPanelBoilerplate } = require('../src/lib/collector.js');

// 实测抓到的真实污染样本（AirTag 那题）
const REAL_JUNK = '{}   How can I help?          Is it compatible with Android?           '
  + 'Can I share my AirTag location?           How long does the battery last?           '
  + "What's the effective tracking range?           How does Precision Finding work?           "
  + 'Why you might like this           What do customers say?           Compare with similar           '
  + 'Show price history         {}                Your feedback has been submitted!   '
  + 'Your feedback has been submitted!     Select All That Apply (optional):    '
  + 'This is irrelevant     This is harmful / unsafe     This is inaccurate     Something else';

const REAL_ANSWER = 'Based on customer reviews for the AirTag, the most common complaints are: '
  + 'Reliability issues where the tracker stops reporting its location after a few months. '
  + 'Battery life is shorter than advertised for some users. '
  + 'Many note it requires buying a separate holder since there is no built-in keyring hole.';

test('★ 回归：实测污染样本必须被判为样板', () => {
  assert.strictEqual(isPanelBoilerplate(REAL_JUNK), true);
});

test('真实答案必须被放行', () => {
  assert.strictEqual(isPanelBoilerplate(REAL_ANSWER), false);
});

test('欢迎语被判为样板', () => {
  assert.strictEqual(isPanelBoilerplate(
    "Welcome! I'm the new Alexa—now here to help you shop! My answers are powered by AI, so I may not always get things right."
  ), true);
});

test('纯推荐问题列表被判为样板', () => {
  assert.strictEqual(isPanelBoilerplate(
    'Is it compatible with Android? How long does the battery last? What is the effective range? Can I share the location?'
  ), true);
});

test('空文本被判为样板', () => {
  assert.strictEqual(isPanelBoilerplate(''), true);
  assert.strictEqual(isPanelBoilerplate(null), true);
  assert.strictEqual(isPanelBoilerplate('   '), true);
});

test('以 {} 开头的片段被判为样板', () => {
  assert.strictEqual(isPanelBoilerplate('{} some text that follows here and is fairly long'), true);
});

test('含少量问句的正常答案不被误杀', () => {
  const a = 'Customers report the battery drains quickly. Is it worth buying? '
    + 'Most reviewers say yes, citing the low price and easy setup. '
    + 'The main drawback is the subscription requirement for full functionality.';
  assert.strictEqual(isPanelBoilerplate(a), false, '答案里带一个问句不应被误判');
});

test('单个样板特征不足以判定（避免误杀提到相关字眼的真答案）', () => {
  const a = 'Several customers say they had to show price history to justify the purchase, '
    + 'and most conclude the tracker is worth it despite the accessory cost.';
  assert.strictEqual(isPanelBoilerplate(a), false);
});
