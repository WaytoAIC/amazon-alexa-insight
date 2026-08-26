'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ci = require('../src/lib/cookie-import.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'cookie-export-sanitized.json');
const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

test('域过滤：只保留 amazon 自有域，广告追踪域全丢', () => {
  const { cookies, stats } = ci.mapCookies(raw);
  assert.strictEqual(stats.total, 49);
  assert.strictEqual(stats.kept, 19, '实测 49 条里只有 19 条是 amazon 自有域');
  assert.strictEqual(stats.droppedNonAmazon, 30);
  assert.ok(cookies.every((c) => ci.isAmazonDomain(c.domain)));
});

test('.amazon-adsystem.com 是广告域，必须被丢弃', () => {
  assert.strictEqual(ci.isAmazonDomain('.amazon-adsystem.com'), false);
  assert.strictEqual(ci.isAmazonDomain('.amazon.com'), true);
  assert.strictEqual(ci.isAmazonDomain('www.amazon.com'), true);
  assert.strictEqual(ci.isAmazonDomain('read.amazon.com'), true);
  assert.strictEqual(ci.isAmazonDomain('notamazon.com'), false);
});

test('★ session:true 必须被忽略，以 expires 为准（否则登录态活不过重启）', () => {
  // fixture 里 100% 的 cookie 都标了 session:true，但都带 2027 年的 expires
  assert.ok(raw.every((c) => c.session === true), 'fixture 前提：全部 session:true');

  const { cookies, stats } = ci.mapCookies(raw);
  assert.strictEqual(stats.sessionOnly, 0, '不应有任何 cookie 退化成会话 cookie');
  assert.ok(cookies.every((c) => c.expires > 0), '每条都应带有效的绝对过期时间');

  const xmain = cookies.find((c) => c.name === 'x-main');
  assert.ok(xmain, 'x-main 应存在');
  assert.ok(xmain.expires > Math.floor(Date.now() / 1000), 'x-main 过期时间应在未来');
});

test('已过期的 expires 退化为会话 cookie（-1）', () => {
  const out = ci.mapCookie(
    { name: 'x-main', value: 'v', domain: '.amazon.com', path: '/', expires: 1000, session: true },
    { now: 2000 }
  );
  assert.strictEqual(out.expires, -1);
});

test('sameSite 映射到 Playwright 取值', () => {
  const mk = (ss, secure = true) =>
    ci.mapCookie({ name: 'n', value: 'v', domain: '.amazon.com', path: '/', sameSite: ss, secure, expires: 4e9 });
  assert.strictEqual(mk('unspecified').sameSite, 'Lax');
  assert.strictEqual(mk('no_restriction').sameSite, 'None');
  assert.strictEqual(mk('strict').sameSite, 'Strict');
  assert.strictEqual(mk('lax').sameSite, 'Lax');
  assert.strictEqual(mk(undefined).sameSite, 'Lax', '缺省按 Chrome 默认 Lax');
});

test('SameSite=None 且非 secure 会被 Chromium 拒绝 → 降级为 Lax 而非丢弃', () => {
  const out = ci.mapCookie({
    name: 'n', value: 'v', domain: '.amazon.com', path: '/',
    sameSite: 'no_restriction', secure: false, expires: 4e9,
  });
  assert.strictEqual(out.sameSite, 'Lax');
  assert.strictEqual(out.secure, false);
});

test('映射结果的字段集正好是 Playwright addCookies 所需', () => {
  const { cookies } = ci.mapCookies(raw);
  const expected = ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'];
  assert.deepStrictEqual(Object.keys(cookies[0]).sort(), [...expected].sort());
});

test('鉴权 cookie 齐全时 missingAuth 为空', () => {
  const { missingAuth } = ci.mapCookies(raw);
  assert.deepStrictEqual(missingAuth, [], '脱敏 fixture 保留了完整鉴权 cookie 集');
});

test('缺失鉴权 cookie 时能报出来', () => {
  const partial = raw.filter((c) => c.name !== 'x-main');
  const { missingAuth } = ci.mapCookies(partial);
  assert.deepStrictEqual(missingAuth, ['x-main']);
});

test('★ 安全：拒绝读取 git 工作区内的凭据文件', () => {
  // 自造一个带 .git 的目录，不依赖本测试文件是否恰好位于 git 仓库中
  // （部署副本可能没有 .git，那样断言会假阴性）
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'apinsight-fakerepo-'));
  fs.mkdirSync(path.join(repo, '.git'));
  const nested = path.join(repo, 'sub', 'dir');
  fs.mkdirSync(nested, { recursive: true });

  const atRoot = path.join(repo, 'cookies.json');
  const deep = path.join(nested, 'cookies.json');
  fs.writeFileSync(atRoot, '[]');
  fs.writeFileSync(deep, '[]');

  assert.throws(() => ci.assertOutsideGitRepo(atRoot), /git 工作区/, '仓库根目录下应被拒');
  assert.throws(() => ci.assertOutsideGitRepo(deep), /git 工作区/, '仓库子目录下也应被拒');
  assert.throws(() => ci.loadExport(deep), /git 工作区/, 'loadExport 也走同一道校验');
});

test('仓库外的路径可以正常通过校验', () => {
  const outside = path.join(os.tmpdir(), 'apinsight-test-cookies.json');
  fs.writeFileSync(outside, '[]');
  try {
    assert.strictEqual(ci.assertOutsideGitRepo(outside), path.resolve(outside));
  } finally {
    fs.unlinkSync(outside);
  }
});

test('loadExport 读取纯 JSON 导出', () => {
  const outside = path.join(os.tmpdir(), 'apinsight-test-load.json');
  fs.writeFileSync(outside, JSON.stringify(raw));
  try {
    const arr = ci.loadExport(outside);
    assert.strictEqual(arr.length, 49);
  } finally {
    fs.unlinkSync(outside);
  }
});

test('loadExport 按 --line 取多账号文本里的第 N 个账号', () => {
  const outside = path.join(os.tmpdir(), 'apinsight-test-multi.txt');
  const a = JSON.stringify([{ name: 'a', domain: '.amazon.com', path: '/', value: '1' }]);
  const b = JSON.stringify([{ name: 'b', domain: '.amazon.com', path: '/', value: '2' }]);
  // 模拟真实形态：行首是账号凭据前缀，其后才是 JSON
  fs.writeFileSync(outside, `Name 1380000 pw 2FA-CODES ${a}\nName2 1390000 pw2 2FA ${b}\n`);
  try {
    assert.strictEqual(ci.loadExport(outside, { line: 1 })[0].name, 'a');
    assert.strictEqual(ci.loadExport(outside, { line: 2 })[0].name, 'b');
    assert.throws(() => ci.loadExport(outside, { line: 3 }), /只有 2 个账号/);
  } finally {
    fs.unlinkSync(outside);
  }
});
