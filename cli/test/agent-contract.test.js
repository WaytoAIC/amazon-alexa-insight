'use strict';
/**
 * Agent 契约测试。
 *
 * 本工具主要由 AI agent 安装维护，agent 的判定依据是 doctor --json 的 code
 * 与退出码，而不是日志文本。这些是对外 API —— 改动会悄无声息地破坏调用方，
 * 所以在这里钉死。契约文档见仓库根 CLAUDE.md（= AGENTS.md）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { CODES } = require('../src/commands/doctor.js');
const { EXIT_CODE } = require('../src/lib/account-pool.js');

test('★ 原因码集合稳定（新增可以，删改即破坏契约）', () => {
  const REQUIRED = [
    'NODE_TOO_OLD', 'PLAYWRIGHT_MISSING', 'CHROME_MISSING', 'ACCOUNTS_NOT_CONFIGURED',
    'BROWSER_LAUNCH_FAILED', 'NOT_LOGGED_IN', 'ALEXA_AUTH_REQUIRED', 'ROBOT_CHECK',
    'ALEXA_STATE_UNKNOWN', 'QUOTA_EXHAUSTED', 'ACCOUNT_COOLING', 'ACCOUNT_DISABLED',
  ];
  for (const c of REQUIRED) {
    assert.ok(CODES[c], `原因码 ${c} 不能删除`);
    assert.strictEqual(typeof CODES[c].needsHuman, 'boolean', `${c} 必须声明 needsHuman`);
    assert.ok(CODES[c].action, `${c} 必须给出可执行动作`);
  }
});

test('★ 需要人工介入的码恰好是这三个', () => {
  // 这三个之外的任何 needsHuman:true 都意味着自动化被意外收窄了
  const human = Object.entries(CODES).filter(([, v]) => v.needsHuman).map(([k]) => k).sort();
  assert.deepStrictEqual(human, ['ALEXA_AUTH_REQUIRED', 'NOT_LOGGED_IN', 'ROBOT_CHECK']);
});

test('★ 池耗尽退出码稳定', () => {
  assert.strictEqual(EXIT_CODE.CAPTCHA, 3);
  assert.strictEqual(EXIT_CODE.SIGNIN, 4);
  assert.strictEqual(EXIT_CODE.QUOTA, 5);
});

test('doctor 支持 --json 且不往 stdout 混日志', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'doctor.js'), 'utf8');
  assert.match(src, /opts\.json/, '应支持 --json');
  assert.match(src, /process\.stdout\.write/, 'JSON 应写 stdout');
  // json 模式下 logger 必须是静默实现，否则 JSON.parse 会被日志污染
  assert.match(src, /json\s*\n?\s*\?\s*\{\s*info\(\)\{\}/, 'json 模式必须换成静默 logger');
});

test('doctor 结果含 agent 需要的顶层字段', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'doctor.js'), 'utf8');
  for (const f of ['needsHuman', 'usableAccounts', 'blockers', 'accounts', 'checks']) {
    assert.ok(src.includes(f), `结果应含 ${f}`);
  }
});

test('CLI 暴露 --json 开关', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'apinsight.js'), 'utf8');
  assert.match(src, /--json/, 'doctor 应有 --json 选项');
});

test('AGENTS.md 契约文档存在且列出全部原因码', () => {
  const p = path.join(__dirname, '..', '..', 'CLAUDE.md');   // AGENTS.md 是它的软链
  assert.ok(fs.existsSync(p), '契约文档必须存在');
  const doc = fs.readFileSync(p, 'utf8');
  for (const c of Object.keys(CODES)) {
    assert.ok(doc.includes(c), `契约文档漏了原因码 ${c}`);
  }
  assert.match(doc, /无法自动化/, '必须写明唯一需要人的一步');
});

test('★ --skip-browser 时 usableAccounts 必须是 null（未知）而非 0（没有）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'doctor.js'), 'utf8');
  assert.match(src, /browserChecked/, '结果必须标明是否验过浏览器');
  assert.match(src, /opts\.skipBrowser\s*\n?\s*\?\s*null/,
    'skipBrowser 时 usableAccounts 应为 null —— 把"没查"当成"没有"会让 agent 误判');
});
