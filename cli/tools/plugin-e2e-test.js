/**
 * 插件 content script 端到端实测工具。
 *
 * 为什么需要它：Chrome 137+ 移除了 `--load-extension` 自动化通道（Chrome 151 上连
 * --disable-features=DisableLoadExtensionCommandLineSwitch 也无效），而 Playwright
 * 自带的 Chromium 又打不开 Chrome 新版建立的 profile。所以无法用自动化真正"安装"插件。
 *
 * 变通：把 chrome.runtime 打桩后注入插件**真实的** content.js，再走 background.js
 * 用的同一个入口 ASK_RUFUS → handleAskAssistant。这样覆盖了选择器、开面板、提问、
 * 网络捕获、SSE 解析全链路；未覆盖的只有 popup↔background↔content 的消息管道。
 *
 * 前置：目标 profile 需已在本机完成真实登录（Alexa 要求完整认证，见 cli/README.md）。
 *
 * 用法：
 *   cd cli && node tools/plugin-e2e-test.js [ASIN] [问题]
 *   cd cli && PROFILE=us-b node tools/plugin-e2e-test.js B0DCH8VDXF
 *
 * 放在 cli/ 下是因为它依赖 playwright（cli 的依赖）——Node 按脚本位置解析模块，
 * 放在仓库根的 tools/ 会找不到。
 *
 * 退出码 0 = 答案干净（无重复碎片、无 markdown 残渣）。
 */
const { chromium } = require('playwright');
const os = require('os'), path = require('path'), fs = require('fs');

const REPO = path.resolve(__dirname, '..', '..');   // cli/tools → 仓库根
const PROFILE = path.join(os.homedir(), '.apinsight', 'profiles', process.env.PROFILE || 'us-a');
const ASIN = process.argv[2] || 'B0DCH8VDXF';
const QUESTION = process.argv[3] || 'What are the most common complaints in the negative reviews for this product?';

const CHROME_STUB = `
  window.__pluginMessages = [];
  window.__pluginListeners = [];
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => window.__pluginListeners.push(fn) },
      sendMessage: (msg) => { window.__pluginMessages.push(msg); return Promise.resolve({ ok: true }); },
      lastError: null,
    },
  };
`;

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: true, channel: 'chrome', viewport: null,
  });
  // 顺序等同插件 manifest：network-hook 先(document_start)，content.js 后(document_idle)
  await ctx.addInitScript({ content: CHROME_STUB });
  await ctx.addInitScript({ path: path.join(REPO, 'content', 'network-hook.js') });

  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(`https://www.amazon.com/dp/${ASIN}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise(r => setTimeout(r, 4000));

  // 注入插件真实的 content.js
  const contentSrc = fs.readFileSync(path.join(REPO, 'content', 'content.js'), 'utf8');
  await page.evaluate(contentSrc);
  const ready = await page.evaluate(() => ({
    listeners: window.__pluginListeners.length,
    msgs: window.__pluginMessages.map(m => m.action),
  }));
  console.log('content.js 已注入:', JSON.stringify(ready));
  if (!ready.listeners) { console.log('✗ 消息监听器未注册'); await ctx.close(); process.exit(1); }

  // 走 background 用的同一入口
  console.log('触发 ASK_RUFUS …');
  await page.evaluate(({ q, asin }) => {
    window.__pluginListeners[0](
      { action: 'ASK_RUFUS', payload: {
          question: q, category: '核心必问', asin, questionIndex: 0,
          settings: { stableChecks: 3, checkInterval: 1.5, maxWaitTime: 60, collectMetadata: true },
      } },
      {}, () => {}
    );
  }, { q: QUESTION, asin: ASIN });

  // 等插件把结果 sendMessage 回来
  const deadline = Date.now() + 90000;
  let result = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    result = await page.evaluate(() =>
      window.__pluginMessages.find(m => m.action === 'RUFUS_RESPONSE' || m.action === 'RUFUS_ERROR') || null);
    if (result) break;
  }

  console.log('\n=== 插件返回 ===');
  if (!result) { console.log('✗ 90s 内无结果'); await ctx.close(); process.exit(1); }
  console.log('action:', result.action);
  const p = result.payload || {};
  console.log('asin:', p.asin, '| title:', (p.productTitle || '').slice(0, 45), '| price:', p.price);
  if (result.action === 'RUFUS_ERROR') { console.log('error:', p.error); await ctx.close(); process.exit(1); }
  console.log('answer 长度:', (p.answer || '').length);
  console.log('--- answer ---');
  console.log((p.answer || '').slice(0, 700));
  const dup = ((p.answer || '').match(/Based on customer reviews/g) || []).length;
  console.log('\n--- 质量检查 ---');
  console.log('  开场白出现次数:', dup, dup <= 1 ? '✓' : '✗ 有重复碎片');
  console.log('  含 [** 残渣:', (p.answer || '').includes('[**') ? '✗ 是' : '✓ 否');
  await ctx.close();
  process.exit(dup <= 1 && !(p.answer || '').includes('[**') ? 0 : 1);
})();
