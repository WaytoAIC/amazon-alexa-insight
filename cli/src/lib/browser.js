'use strict';
/**
 * 浏览器生命周期：每账号一个持久化 context。
 *
 * 默认走系统真 Chrome（channel:'chrome'）—— 真 Chrome 的 UA-CH brand、编解码器与 GPU
 * 指纹显著降低风控概率；未装则降级到 Playwright 自带 chromium 并告警。
 *
 * 始终使用独立 userDataDir（~/.apinsight/profiles/<id>），绝不碰用户日常浏览器 profile。
 */

const path = require('path');
const fs = require('fs');

const { AccountPool } = require('./account-pool.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const NETWORK_HOOK = path.join(REPO_ROOT, 'content', 'network-hook.js');   // 零修改复用插件文件
const COLLECTOR_HOOK = path.join(__dirname, 'inject', 'collector-hook.js');

let _chromium = null;
function chromium() {
  if (!_chromium) {
    try {
      _chromium = require('playwright').chromium;
    } catch (e) {
      throw new Error('未安装 playwright。请在 cli/ 目录下执行：npm install');
    }
  }
  return _chromium;
}

/** 探测系统 Chrome；不可用则降级 */
async function resolveChannel(preferred, log) {
  if (preferred === 'chromium') return null;
  const macChrome = '/Applications/Google Chrome.app';
  const exists = process.platform !== 'darwin' || fs.existsSync(macChrome);
  if (exists) return 'chrome';
  log?.warn?.('未检测到系统 Google Chrome，降级使用 Playwright 自带 chromium；'
    + '指纹差异会提高触发人机验证的概率，建议装上 Chrome。');
  return null;
}

/**
 * 为某个账号打开持久化 context。
 * 两个 initScript 在任何页面脚本之前、且对所有 frame 生效 ——
 * 这一点比插件更强（插件的 parent-post 只上传一层，嵌套 iframe 会丢）。
 */
async function launchForAccount(account, {
  headless = false,
  channel = 'chrome',
  log = console,
  timezoneId,
  locale = 'en-US',
} = {}) {
  const userDataDir = AccountPool.profileDir(account.id);
  fs.mkdirSync(userDataDir, { recursive: true });

  const resolved = await resolveChannel(channel, log);
  const options = {
    headless,
    viewport: null,
    locale,
    args: ['--disable-blink-features=AutomationControlled'],
  };
  if (resolved) options.channel = resolved;
  if (timezoneId) options.timezoneId = timezoneId;
  if (account.proxy) options.proxy = account.proxy;   // 预留：接代理只改 accounts.json

  const context = await chromium().launchPersistentContext(userDataDir, options);

  await context.addInitScript({ path: NETWORK_HOOK });
  await context.addInitScript({ path: COLLECTOR_HOOK });

  return { context, channel: resolved || 'chromium', userDataDir };
}

/** 取 context 的首个页面（持久化 context 启动时自带一个） */
async function firstPage(context) {
  const pages = context.pages();
  return pages.length ? pages[0] : await context.newPage();
}

module.exports = { launchForAccount, firstPage, resolveChannel, NETWORK_HOOK, COLLECTOR_HOOK };
