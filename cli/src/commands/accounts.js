'use strict';
/**
 * 账号管理：导入 cookie 建立登录态、查看池状态、启停、重置配额。
 *
 * 工具全程不接触密码与 2FA 恢复码 —— 导入只解析 cookie JSON 段。
 */

const fs = require('fs');
const path = require('path');

const ci = require('../lib/cookie-import.js');
const { AccountPool, ACCOUNTS_PATH, STATUS, atomicWriteJson } = require('../lib/account-pool.js');
const { launchForAccount, firstPage } = require('../lib/browser.js');
const guard = require('../lib/guard.js');
const { marketplaceHome, productUrl } = require('../lib/asins.js');
const collector = require('../lib/collector.js');
const { createLogger } = require('../lib/log.js');

function readAccountsConfig() {
  if (!fs.existsSync(ACCOUNTS_PATH)) return { accounts: [] };
  return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
}

function upsertAccount(entry) {
  const cfg = readAccountsConfig();
  const i = cfg.accounts.findIndex((a) => a.id === entry.id);
  if (i >= 0) cfg.accounts[i] = { ...cfg.accounts[i], ...entry };
  else cfg.accounts.push(entry);
  atomicWriteJson(ACCOUNTS_PATH, cfg);
  return cfg;
}

/**
 * apinsight accounts add --id us-a
 * 只登记账号，不导入任何凭据。适用于没有 cookie 导出、直接人工登录的情形。
 */
function addAccount(opts) {
  const { id, marketplace = 'US', maxPerDay = 600 } = opts;
  if (!id) throw new Error('必须指定 --id');
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('账号 id 只能用字母数字与 -_');

  const existing = readAccountsConfig().accounts.find((a) => a.id === id);
  upsertAccount({ id, marketplace, maxPerDay: Number(maxPerDay), enabled: true, proxy: null });
  console.log(`${existing ? '已更新' : '已登记'}账号 ${id}（站点 ${marketplace}，日配额 ${maxPerDay}）`);
  console.log(`下一步：apinsight login --account ${id}   # 在本机人工登录一次`);
  return { id };
}

/** apinsight accounts import --id us-a --file <仓库外路径> [--line 1] */
async function importCookies(opts) {
  const log = createLogger({ verbose: opts.verbose });
  const { id, file, line = 1, marketplace = 'US', maxPerDay = 600 } = opts;
  if (!id) throw new Error('必须指定 --id');
  if (!file) throw new Error('必须指定 --file');

  log.step(`解析 cookie 导出：${file}（第 ${line} 个账号）`);
  const raw = ci.loadExport(file, { line: Number(line) });
  const { cookies, stats, missingAuth } = ci.mapCookies(raw);

  log.info(`共 ${stats.total} 条，保留 amazon 域 ${stats.kept} 条，丢弃广告追踪域 ${stats.droppedNonAmazon} 条`);
  if (stats.sessionOnly) log.warn(`${stats.sessionOnly} 条没有有效过期时间，将作为会话 cookie（重启后失效）`);
  if (missingAuth.length) {
    log.warn(`缺少鉴权 cookie：${missingAuth.join(', ')} —— 导入后很可能仍是未登录状态`);
  }
  if (!cookies.length) throw new Error('没有可导入的 amazon 域 cookie');

  upsertAccount({ id, marketplace, maxPerDay: Number(maxPerDay), enabled: true, proxy: null });
  log.ok(`账号已登记到 ${ACCOUNTS_PATH}`);

  const account = { id, marketplace, maxPerDay: Number(maxPerDay), enabled: true, proxy: null };
  log.step(`打开 profile 写入登录态（${AccountPool.profileDir(id)}）`);
  const { context, channel } = await launchForAccount(account, {
    headless: opts.headless !== false, channel: opts.channel || 'chrome', log,
  });
  log.debug(`浏览器通道：${channel}`);

  try {
    await context.addCookies(cookies);
    const page = await firstPage(context);
    await page.goto(marketplaceHome(marketplace), { waitUntil: 'domcontentloaded', timeout: 45000 });

    await guard.settleForAuth(page);
    const incident = await guard.check(page);
    if (incident) {
      log.warn(`导入后页面异常：${incident.type} —— ${incident.detail}`);
    }

    const status = await guard.isLoggedIn(context, page);
    if (status.loggedIn) {
      log.ok(`登录态验真通过：${status.accountLine}`);
    } else {
      log.error('登录态验真未通过');
      log.info(`  账号栏文本：${status.accountLine || '(空)'}`);
      log.info(`  鉴权 cookie 就位：${status.cookieSaysLoggedIn ? '是' : '否'}`);
      log.info('  cookie 是在别的设备上导出的，换设备/换 IP 重放可能被 Amazon 判为异常。');
      log.info(`  兜底：apinsight login --account ${id}（在本机人工登录一次）`);
    }
    return { ok: status.loggedIn, stats, missingAuth, status };
  } finally {
    // 持久化 context 在 close 时才把 cookie 落盘到 profile
    await context.close();
    log.debug('profile 已落盘');
  }
}

/**
 * apinsight login --account us-a：headed 人工登录。
 *
 * ⚠️ 成功判据是 **Alexa 面板真正可用**，不是账号栏有没有名字。
 * 重放 cookie 后账号栏就已经显示 "Hello, X"（已识别级），若以此为准会立刻误报成功、
 * 让人根本没机会登录，而 Alexa 依旧不可用。
 *
 * 流程：打开商品页 → 展开 Alexa 面板 → 若提示需要登录，直接把面板里那条
 * max_auth_age=0 的链接导航过去（这是 Amazon 自己给的强制实时认证入口）→
 * 人工完成登录 → 轮询直到 Alexa 面板可用。
 *
 * 全程不读取、不输入密码与验证码 —— 那部分只能由人在窗口里自己完成。
 */
async function login(opts) {
  const log = createLogger({ verbose: opts.verbose });
  const id = opts.account;
  if (!id) throw new Error('必须指定 --account');
  const cfg = readAccountsConfig();
  const account = cfg.accounts.find((a) => a.id === id);
  if (!account) throw new Error(`未知账号：${id}（先跑 accounts import 登记）`);

  const marketplace = account.marketplace || 'US';
  const asin = opts.asin || 'B08JHCVHTY';   // 用于探测 Alexa 面板的商品页
  const timeoutMin = Number(opts.timeoutMin) || 15;

  const { context } = await launchForAccount(account, { headless: false, channel: opts.channel || 'chrome', log });
  const page = await firstPage(context);

  try {
    await page.goto(productUrl(asin, marketplace), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await guard.settleForAuth(page);

    // 先看现在到底缺什么
    const before = await probeAlexaState(page);
    if (before.usable) {
      log.ok('Alexa 面板已可用，无需登录。');
      AccountPool.load({ only: [id] }).setEnabled(id, true);
      return { ok: true, alreadyUsable: true };
    }

    if (before.signinHref) {
      log.step('Alexa 要求实时认证，正在打开它给出的登录入口…');
      const href = before.signinHref.startsWith('http')
        ? before.signinHref
        : new URL(before.signinHref, page.url()).toString();
      await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }

    log.info('');
    log.info(`  浏览器窗口已在 mini 上打开，停在 ${account.id} 的登录页。`);
    log.info('  请在窗口里自行输入账号密码与验证码 —— 本工具不读取、不输入这些内容。');
    log.info(`  登录后会自动检测 Alexa 是否真正可用，可用即自动收工（最多等 ${timeoutMin} 分钟）。`);
    log.info('');

    const deadline = Date.now() + timeoutMin * 60 * 1000;
    let announced = false;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));

      const url = page.url();
      if (/\/ap\/(signin|cvf|mfa)/i.test(url)) continue;      // 还在登录流程里
      if (!announced) { log.info('  已离开登录页，正在验证 Alexa…'); announced = true; }

      // 回到商品页验 Alexa（登录后 Amazon 一般会自己跳回，这里兜底）
      if (!/\/dp\//.test(url)) {
        await page.goto(productUrl(asin, marketplace), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await guard.settleForAuth(page);
      }

      const st = await probeAlexaState(page);
      if (st.usable) {
        const who = await guard.isLoggedIn(context, page).catch(() => ({ accountLine: '' }));
        log.ok(`登录成功，Alexa 面板已可用：${who.accountLine || account.id}`);
        AccountPool.load({ only: [id] }).setEnabled(id, true);   // 清掉 signin_expired / captcha_blocked
        return { ok: true };
      }
      if (st.authRequired) announced = false;                 // 还没过认证，继续等
    }

    log.warn(`${timeoutMin} 分钟内 Alexa 仍不可用，已退出。可重跑本命令再试。`);
    return { ok: false };
  } finally {
    await context.close();
  }
}

/** 探测 Alexa 面板状态（复用 collector 的入口逻辑，避免两处判定漂移） */
async function probeAlexaState(page) {
  try {
    await collector.openAssistantChat(page);
    return { usable: true, authRequired: false, signinHref: null };
  } catch (e) {
    const panel = await collector.readPanelState(page);
    return {
      usable: false,
      authRequired: e.incidentType === 'alexa_auth_required' || panel.authRequired,
      signinHref: panel.signinHref || null,
      text: panel.text || e.message,
    };
  }
}

function list() {
  const pool = AccountPool.load();
  const rows = pool.summary();
  const pad = (s, n) => `${String(s).padEnd(n)} `;   // 列间恒留空格，避免长 id 与下一列黏连
  const idW = Math.max(10, ...rows.map((r) => r.id.length));
  console.log(pad('ID', idW) + pad('站点', 5) + pad('状态', 16) + pad('今日用量', 10) + pad('代理', 4) + '备注');
  console.log('-'.repeat(idW + 45));
  for (const r of rows) {
    const quota = `${r.used}/${r.maxPerDay}`;
    let note = '';
    if (!r.enabled) note = '已停用';
    else if (r.status === STATUS.COOLING && r.cooldownUntil) note = `冷却至 ${new Date(r.cooldownUntil).toLocaleTimeString()}`;
    else if (r.status === STATUS.CAPTCHA_BLOCKED) note = '需人工处理验证码后 enable';
    else if (r.status === STATUS.SIGNIN_EXPIRED) note = '需重新导入 cookie 或 login';
    else if (r.remaining === 0) note = '今日配额已用尽';
    console.log(pad(r.id, idW) + pad(r.marketplace, 5) + pad(r.status, 16) + pad(quota, 10) + pad(r.hasProxy ? '是' : '否', 4) + note);
  }
  return rows;
}

function setEnabled(id, enabled) {
  const cfg = readAccountsConfig();
  const a = cfg.accounts.find((x) => x.id === id);
  if (!a) throw new Error(`未知账号：${id}`);
  a.enabled = enabled;
  atomicWriteJson(ACCOUNTS_PATH, cfg);
  const pool = AccountPool.load();
  pool.setEnabled(id, enabled);
  console.log(`账号 ${id} 已${enabled ? '启用' : '停用'}`);
}

function resetQuota(id) {
  const pool = AccountPool.load();
  pool.resetQuota(id);
  console.log(`账号 ${id} 今日配额已重置`);
}

module.exports = { addAccount, importCookies, login, list, setEnabled, resetQuota, readAccountsConfig, upsertAccount, probeAlexaState };
