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
const { marketplaceHome } = require('../lib/asins.js');
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

/** apinsight login --account us-a：headed 人工登录兜底 */
async function login(opts) {
  const log = createLogger({ verbose: opts.verbose });
  const id = opts.account;
  if (!id) throw new Error('必须指定 --account');
  const cfg = readAccountsConfig();
  const account = cfg.accounts.find((a) => a.id === id);
  if (!account) throw new Error(`未知账号：${id}（先跑 accounts import 登记）`);

  const { context } = await launchForAccount(account, { headless: false, channel: opts.channel || 'chrome', log });
  const page = await firstPage(context);
  await page.goto(marketplaceHome(account.marketplace || 'US'), { waitUntil: 'domcontentloaded' });

  log.info('浏览器已打开。请在窗口里自行完成登录 —— 本工具不会读取或输入你的密码与验证码。');
  log.info('登录成功后会自动检测并退出；也可以随时 Ctrl+C。');

  const deadline = Date.now() + 10 * 60 * 1000;
  try {
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const status = await guard.isLoggedIn(context, page).catch(() => null);
      if (status?.loggedIn) {
        log.ok(`登录成功：${status.accountLine}`);
        const pool = AccountPool.load({ only: [id] });
        pool.setEnabled(id, true);      // 清掉 signin_expired / captcha_blocked
        return { ok: true };
      }
    }
    log.warn('10 分钟内未检测到登录成功，已退出。');
    return { ok: false };
  } finally {
    await context.close();
  }
}

function list() {
  const pool = AccountPool.load();
  const rows = pool.summary();
  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('ID', 12) + pad('站点', 6) + pad('状态', 18) + pad('今日用量', 12) + pad('代理', 6) + '备注');
  console.log('-'.repeat(78));
  for (const r of rows) {
    const quota = `${r.used}/${r.maxPerDay}`;
    let note = '';
    if (!r.enabled) note = '已停用';
    else if (r.status === STATUS.COOLING && r.cooldownUntil) note = `冷却至 ${new Date(r.cooldownUntil).toLocaleTimeString()}`;
    else if (r.status === STATUS.CAPTCHA_BLOCKED) note = '需人工处理验证码后 enable';
    else if (r.status === STATUS.SIGNIN_EXPIRED) note = '需重新导入 cookie 或 login';
    else if (r.remaining === 0) note = '今日配额已用尽';
    console.log(pad(r.id, 12) + pad(r.marketplace, 6) + pad(r.status, 18) + pad(quota, 12) + pad(r.hasProxy ? '是' : '否', 6) + note);
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

module.exports = { importCookies, login, list, setEnabled, resetQuota, readAccountsConfig, upsertAccount };
