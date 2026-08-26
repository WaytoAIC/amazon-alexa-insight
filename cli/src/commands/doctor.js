'use strict';
/** 环境与账号自检 */

const fs = require('fs');
const { AccountPool, ACCOUNTS_PATH } = require('../lib/account-pool.js');
const { launchForAccount, firstPage, resolveChannel } = require('../lib/browser.js');
const guard = require('../lib/guard.js');
const { marketplaceHome } = require('../lib/asins.js');
const { createLogger } = require('../lib/log.js');
const collector = require('../lib/collector.js');

/** 打开 Alexa 面板并判断是否真的可用（不只是登录态看起来正常） */
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
  const log = createLogger({ verbose: opts.verbose });
  let ok = true;

  log.step('运行环境');
  log.info(`  Node ${process.version}（要求 >= v20）`);
  if (Number(process.version.slice(1).split('.')[0]) < 20) { log.error('  Node 版本过低'); ok = false; }

  try {
    require('playwright');
    log.info('  playwright 已安装');
  } catch (e) {
    log.error('  playwright 未安装 —— 在 cli/ 下执行 npm install');
    return { ok: false };
  }

  const channel = await resolveChannel(opts.channel || 'chrome', log);
  log.info(`  浏览器通道：${channel || 'chromium（Playwright 自带）'}`);

  log.step('账号池');
  if (!fs.existsSync(ACCOUNTS_PATH)) {
    log.error(`  未配置：${ACCOUNTS_PATH}`);
    log.info('  先跑：apinsight accounts import --id us-a --file <cookie导出路径>');
    return { ok: false };
  }

  const pool = AccountPool.load({ only: opts.accounts });
  for (const account of pool.accounts) {
    const st = pool.stateOf(account.id);
    log.info(`  [${account.id}] 状态 ${st.status}，今日 ${st.questionsAsked}/${account.maxPerDay}，代理 ${account.proxy ? '有' : '无'}`);

    if (opts.skipBrowser) continue;

    let context;
    try {
      ({ context } = await launchForAccount(account, {
        headless: opts.headless !== false, channel: opts.channel || 'chrome', log,
      }));
      const page = await firstPage(context);
      await page.goto(marketplaceHome(account.marketplace || 'US'), { waitUntil: 'domcontentloaded', timeout: 45000 });

      await guard.settleForAuth(page);
      const incident = await guard.check(page);
      if (incident) {
        log.warn(`    页面异常：${incident.type} —— ${incident.detail}`);
        ok = false;
      }
      const status = await guard.isLoggedIn(context, page);
      if (status.loggedIn) log.ok(`    已登录：${status.accountLine}`);
      else {
        log.error(`    未登录（账号栏「${status.accountLine || '空'}」，鉴权 cookie ${status.cookieSaysLoggedIn ? '在' : '缺'}）`);
        ok = false;
      }

      // 登录态"看起来正常"不等于 Alexa 可用：重放 cookie 只到"已识别"，
      // Alexa 另外要求完整认证。必须单独探测，否则要到真正采集时才发现。
      if (status.loggedIn && !opts.skipAlexa) {
        const alexa = await probeAlexa(page);
        if (alexa.usable) log.ok('    Alexa 面板可用');
        else if (alexa.authRequired) {
          log.error('    Alexa 不可用：需要在本机真实登录一次');
          log.info(`      面板提示：「${alexa.text.slice(0, 80)}」`);
          log.info(`      修复：apinsight login --account ${account.id}`);
          ok = false;
        } else {
          log.warn(`    Alexa 面板状态未知${alexa.text ? `：「${alexa.text.slice(0, 80)}」` : '（未找到面板）'}`);
          ok = false;
        }
      }
    } catch (e) {
      log.error(`    检查失败：${e.message}`);
      ok = false;
    } finally {
      await context?.close();
    }
  }

  log.step(ok ? '自检通过' : '自检发现问题（见上）');
  return { ok };
}

module.exports = { doctor, probeAlexa };
