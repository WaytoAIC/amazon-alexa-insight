/**
 * 插件完整端到端测试：真正加载扩展，驱动 popup UI → background → content script。
 *
 * 需要 Playwright 自带的 Chromium（不是系统 Chrome）：
 * Chrome 137+ 移除了 --load-extension 自动化通道，但 Playwright 的 Chromium 构建保留了。
 * playwright 1.62.1 捆绑 Chromium 151，与当前系统 Chrome 同主版本，因此能直接复用
 * Chrome 建立的已认证 profile（低版本 Chromium 打开会崩）。
 *
 * 与 plugin-e2e-test.js 的分工：
 *   plugin-e2e-test.js  注入 content.js 打桩测，快、不需要复制 profile，覆盖采集链路
 *   本脚本              真正装扩展跑 popup→background→content，额外覆盖消息管道层
 *
 * 前置：源 profile 需已在本机完成真实登录（Alexa 要求完整认证）。
 * 脚本会把它复制成独立的 ext151 profile，不污染生产 profile。
 *
 * 用法：
 *   cd cli && node tools/plugin-full-ext-test.js [ASIN]
 *   cd cli && SRC_PROFILE=us-b node tools/plugin-full-ext-test.js B0DCH8VDXF
 */
const { chromium } = require('playwright');
const os = require('os'), path = require('path'), fs = require('fs');
const EXT = path.resolve(__dirname, '..', '..');            // cli/tools → 仓库根
const SRC = path.join(os.homedir(), '.apinsight', 'profiles', process.env.SRC_PROFILE || 'us-a');
const PROFILE = path.join(os.homedir(), '.apinsight', 'profiles', 'ext151');
const ASIN = process.argv[2] || 'B0DCH8VDXF';

if (!fs.existsSync(SRC)) { console.error(`源 profile 不存在：${SRC}`); process.exit(1); }
// 复制一份，绝不动生产 profile
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.cpSync(SRC, PROFILE, { recursive: true });

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false, viewport: null,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;
  console.log('扩展已加载:', extId);

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 2500));
  console.log('popup 已打开:', await popup.title());

  // 填 ASIN
  await popup.fill('#asinInput', ASIN);
  await popup.dispatchEvent('#asinInput', 'input');
  await new Promise(r => setTimeout(r, 1200));
  console.log('ASIN 计数:', (await popup.textContent('#asinCount').catch(() => '?'))?.trim());

  // 选一个分类
  const cats = await popup.evaluate(() => {
    const grid = document.querySelector('#categoriesGrid');
    return Array.from(grid.children).map((e, i) => ({ i, text: (e.textContent || '').trim().slice(0, 18) }));
  });
  console.log('可选分类数:', cats.length, '| 第一个:', cats[0]?.text);
  await popup.evaluate(() => document.querySelector('#categoriesGrid').children[0].click());
  await new Promise(r => setTimeout(r, 800));

  // 缩短等待，减少测试耗时
  await popup.evaluate(() => { const e = document.querySelector('#maxWaitTime'); if (e) e.value = '60'; });

  // 收集 popup 侧日志
  popup.on('console', (m) => { const t = m.text(); if (/Alexa洞察/.test(t)) console.log('  [popup]', t.slice(0, 110)); });

  console.log('\n点击开始采集 …');
  await popup.click('#startBtn');

  // 等结果回流到 popup
  const deadline = Date.now() + 150000;
  let res = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    res = await popup.evaluate(() => {
      const rows = document.querySelectorAll('#resultsList > *');
      return { count: rows.length,
               progress: document.querySelector('#completedQuestions')?.textContent?.trim(),
               first: rows[0] ? rows[0].innerText.replace(/\s+/g,' ').slice(0, 260) : null };
    }).catch(() => null);
    if (res && res.count > 0) break;
  }

  console.log('\n=== popup 里的结果 ===');
  console.log('结果条数:', res?.count, '| 进度:', res?.progress);
  console.log('首条:', res?.first);

  // 从 background 的 storage 里取完整结果（最权威）
  const stored = await sw.evaluate(async () => {
    const d = await chrome.storage.local.get(['apinsightResults']);
    return (d.apinsightResults || []).map(r => ({
      asin: r.asin, title: (r.productTitle||'').slice(0,40), price: r.price,
      status: r.status, len: (r.answer||'').length,
      dup: ((r.answer||'').match(/Based on customer reviews/g)||[]).length,
      residue: (r.answer||'').includes('[**'),
      head: (r.answer||'').slice(0,150),
    }));
  }).catch(e => ({ err: e.message }));
  console.log('\n=== background storage 里的结果 ===');
  console.log(JSON.stringify(stored, null, 1).slice(0, 1400));
  await ctx.close();
})();
