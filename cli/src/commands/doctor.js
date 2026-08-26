'use strict';
/**
 * 环境与账号自检。
 *
 * 双输出：人看的日志，与 `--json` 的结构化状态。
 * 本工具主要由 AI agent 安装维护，agent 不该去 grep 中文日志猜状态 ——
 * JSON 里每个问题都带稳定的 `code` 和 `needsHuman`，据此就能决定下一步。
 */

const fs = require('fs');
const { AccountPool, ACCOUNTS_PATH, STATUS } = require('../lib/account-pool.js');
const { launchForAccount, firstPage, resolveChannel } = require('../lib/browser.js');
const guard = require('../lib/guard.js');
const { marketplaceHome } = require('../lib/asins.js');
const { createLogger } = require('../lib/log.js');
const collector = require('../lib/collector.js');

/** 稳定原因码 —— agent 的判定依据，改动等同破坏契约 */
const CODES = {
  NODE_TOO_OLD:            { needsHuman: false, action: '安装 Node >= 20' },
  PLAYWRIGHT_MISSING:      { needsHuman: false, action: 'cd cli && npm install' },
  CHROME_MISSING:          { needsHuman: false, action: '安装 Google Chrome（否则降级 chromium，风控概率升高）' },
  ACCOUNTS_NOT_CONFIGURED: { needsHuman: false, action: 'apinsight accounts add --id <id>' },
  BROWSER_LAUNCH_FAILED:   { needsHuman: false, action: '检查 Chrome 安装与 profile 目录权限' },
  NOT_LOGGED_IN:           { needsHuman: true,  action: 'apinsight login --account <id>' },
  ALEXA_AUTH_REQUIRED:     { needsHuman: true,  action: 'apinsight login --account <id>' },
  ROBOT_CHECK:             { needsHuman: true,  action: '人工处理验证码后 apinsight accounts enable <id>' },
  ALEXA_STATE_UNKNOWN:     { needsHuman: false, action: '重跑 doctor；持续出现可能是 Amazon 改版' },
  QUOTA_EXHAUSTED:         { needsHuman: false, action: '等次日重置或增加账号' },
  ACCOUNT_COOLING:         { needsHuman: false, action: '等冷却结束（见 cooldownUntil）' },
  ACCOUNT_DISABLED:        { needsHuman: false, action: 'apinsight accounts enable <id>' },
};

function blocker(code, account = null, detail = null) {
  const meta = CODES[code] || { needsHuman: false, action: null };
  return { code, account, detail, action: meta.action, needsHuman: meta.needsHuman };
}

async function probeAlexa(page) {
  try {
    await collector.openAssistantChat(page);
    return { usable: true, authRequired: false, text: '' };
  } catch (e) {
    const panel = await collector.readPanelState(page);
    return {
      usable: false,
      authRequired: e.incidentType === 'alexa_auth_required' || panel.authRequired,
      text: panel.text || e.message,
    };
  }
}

async function doctor(opts = {}) {
  const json = Boolean(opts.json);
  const log = json
    ? { info(){}, ok(){}, warn(){}, error(){}, step(){}, debug(){}, close(){} }
    : createLogger({ verbose: opts.verbose });

  const result = { ok: true, checks: {}, accounts: [], blockers: [] };
  const fail = (code, account, detail) => {
    result.ok = false;
    result.blockers.push(blocker(code, account, detail));
  };

  // ---------- 运行环境 ----------
  log.step('运行环境');
  const nodeMajor = Number(process.version.slice(1).split('.')[0]);
  result.checks.node = { ok: nodeMajor >= 20, value: process.version, required: '>=20' };
  log.info(`  Node ${process.version}（要求 >= v20）`);
  if (!result.checks.node.ok) { log.error('  Node 版本过低'); fail('NODE_TOO_OLD'); }

  try {
    result.checks.playwright = { ok: true, value: require('playwright/package.json').version };
    log.info(`  playwright 已安装 ${result.checks.playwright.value}`);
  } catch (e) {
    result.checks.playwright = { ok: false, value: null };
    log.error('  playwright 未安装 —— 在 cli/ 下执行 npm install');
    fail('PLAYWRIGHT_MISSING');
    return finish();
  }

  const channel = await resolveChannel(opts.channel || 'chrome', log);
  result.checks.chrome = { ok: channel === 'chrome', channel: channel || 'chromium' };
  log.info(`  浏览器通道：${channel || 'chromium（Playwright 自带）'}`);
  if (channel !== 'chrome') {
    result.blockers.push({ ...blocker('CHROME_MISSING'), severity: 'warning' });
  }

  // ---------- 账号池 ----------
  log.step('账号池');
  if (!fs.existsSync(ACCOUNTS_PATH)) {
    result.checks.accountsConfig = { ok: false, path: ACCOUNTS_PATH, count: 0 };
    log.error(`  未配置：${ACCOUNTS_PATH}`);
    log.info('  先跑：apinsight accounts add --id us-a');
    fail('ACCOUNTS_NOT_CONFIGURED');
    return finish();
  }

  const pool = AccountPool.load({ only: opts.accounts });
  result.checks.accountsConfig = { ok: true, path: ACCOUNTS_PATH, count: pool.accounts.length };

  for (const account of pool.accounts) {
    const st = pool.stateOf(account.id);
    const row = {
      id: account.id,
      marketplace: account.marketplace || 'US',
      enabled: account.enabled,
      status: st.status,
      used: st.questionsAsked,
      maxPerDay: account.maxPerDay,
      remaining: pool.remainingQuota(account),
      cooldownUntil: st.cooldownUntil,
      hasProxy: Boolean(account.proxy),
      loggedIn: null,
      alexaUsable: null,
      accountLine: null,
    };
    log.info(`  [${account.id}] 状态 ${st.status}，今日 ${st.questionsAsked}/${account.maxPerDay}，代理 ${account.proxy ? '有' : '无'}`);

    if (!account.enabled) fail('ACCOUNT_DISABLED', account.id);
    else if (st.status === STATUS.CAPTCHA_BLOCKED) fail('ROBOT_CHECK', account.id);
    else if (st.status === STATUS.SIGNIN_EXPIRED) fail('ALEXA_AUTH_REQUIRED', account.id);
    else if (st.status === STATUS.COOLING) fail('ACCOUNT_COOLING', account.id, `冷却至 ${new Date(st.cooldownUntil).toISOString()}`);
    else if (row.remaining === 0) fail('QUOTA_EXHAUSTED', account.id);

    if (opts.skipBrowser) { result.accounts.push(row); continue; }

    let context;
    try {
      ({ context } = await launchForAccount(account, {
        headless: opts.headless !== false, channel: opts.channel || 'chrome', log,
      }));
      const page = await firstPage(context);
      await page.goto(marketplaceHome(row.marketplace), { waitUntil: 'domcontentloaded', timeout: 45000 });

      await guard.settleForAuth(page);
      const incident = await guard.check(page);
      if (incident) {
        log.warn(`    页面异常：${incident.type} —— ${incident.detail}`);
        if (incident.type === 'robot_check') fail('ROBOT_CHECK', account.id, incident.detail);
        else fail('ALEXA_STATE_UNKNOWN', account.id, incident.detail);
      }

      const status = await guard.isLoggedIn(context, page);
      row.loggedIn = status.loggedIn;
      row.accountLine = status.accountLine || null;
      if (status.loggedIn) log.ok(`    已登录：${status.accountLine}`);
      else {
        log.error(`    未登录（账号栏「${status.accountLine || '空'}」，鉴权 cookie ${status.cookieSaysLoggedIn ? '在' : '缺'}）`);
        fail('NOT_LOGGED_IN', account.id);
      }

      // 登录态"看起来正常"不等于 Alexa 可用：重放 cookie 只到"已识别"，
      // Alexa 另外要求完整认证。必须单独探测，否则要到真正采集时才发现。
      if (status.loggedIn && !opts.skipAlexa) {
        const alexa = await probeAlexa(page);
        row.alexaUsable = alexa.usable;
        if (alexa.usable) log.ok('    Alexa 面板可用');
        else if (alexa.authRequired) {
          log.error('    Alexa 不可用：需要在本机真实登录一次');
          log.info(`      面板提示：「${alexa.text.slice(0, 80)}」`);
          log.info(`      修复：apinsight login --account ${account.id}`);
          fail('ALEXA_AUTH_REQUIRED', account.id, alexa.text.slice(0, 120));
        } else {
          log.warn(`    Alexa 面板状态未知${alexa.text ? `：「${alexa.text.slice(0, 80)}」` : '（未找到面板）'}`);
          fail('ALEXA_STATE_UNKNOWN', account.id, alexa.text.slice(0, 120));
        }
      }
    } catch (e) {
      log.error(`    检查失败：${e.message}`);
      fail('BROWSER_LAUNCH_FAILED', account.id, e.message);
    } finally {
      await context?.close();
    }
    result.accounts.push(row);
  }

  log.step(result.ok ? '自检通过' : '自检发现问题（见上）');
  return finish();

  function finish() {
    // --skip-browser 时没验过 Alexa，usableAccounts 必须是 null(未知) 而不是 0(没有)。
    // 否则 agent 会把"没查"误判成"没有可用账号"。
    result.browserChecked = !opts.skipBrowser;
    result.usableAccounts = opts.skipBrowser
      ? null
      : result.accounts.filter((a) => a.alexaUsable === true).length;
    result.needsHuman = result.blockers.some((b) => b.needsHuman && b.severity !== 'warning');
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
}

module.exports = { doctor, probeAlexa, CODES };
