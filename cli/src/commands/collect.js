'use strict';
/**
 * 采集主编排。
 *
 * ⚠️ 编排语义 SOURCE OF TRUTH: background/background.js
 *  - 超时按题跳过而非按 ASIN 跳过（:643 的 maxWaitTime+15 兜底定时器）
 *  - 错误行也入库（:503-513）
 *  - 页面 load 后 3s 才问第一题（:672-678）
 *
 * 一处明知故改：background.js:201-203 导航失败只写日志直接跳过，该 ASIN 全部题
 * 静默丢失且无 error 行。这里改为写一行 question='NAVIGATION_FAILED' 的 ASIN 级 error 行。
 */

const path = require('path');
const fs = require('fs');

const { AccountPool, PoolExhaustedError, EXIT_CODE } = require('../lib/account-pool.js');
const { launchForAccount, firstPage } = require('../lib/browser.js');
const collector = require('../lib/collector.js');
const guard = require('../lib/guard.js');
const exporter = require('../lib/exporter.js');
const { RunState, STATUS } = require('../lib/state.js');
const { Pacer, parseRange, DEFAULTS: PACE_DEFAULTS, sleep } = require('../lib/pacing.js');
const { resolveQuestions, shuffle } = require('../lib/questions.js');
const { resolveAsins, productUrl } = require('../lib/asins.js');
const { createLogger } = require('../lib/log.js');

const NAVIGATION_FAILED = 'NAVIGATION_FAILED';

function makeRunId(marketplace) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${marketplace}`;
}

/** 每题的硬超时，复刻 background.js:643 */
function hardTimeout(ms, label) {
  let t;
  const p = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} 硬超时 ${ms / 1000}s`)), ms); });
  p.cancel = () => clearTimeout(t);
  return p;
}

async function collect(opts) {
  const marketplace = opts.marketplace || 'US';
  const outDir = path.resolve(opts.outDir || path.join(__dirname, '..', '..', 'runs'));

  // ---- 恢复或新建 run ----
  let state;
  let resuming = false;
  if (opts.resume) {
    const dir = typeof opts.resume === 'string' && opts.resume !== 'true'
      ? path.join(outDir, opts.resume)
      : latestRunDir(outDir);
    if (!dir) throw new Error(`${outDir} 下没有可恢复的 run`);
    state = RunState.load(dir);
    resuming = true;
  } else {
    const asins = resolveAsins(opts.asins);
    let questions = resolveQuestions(opts.questions);
    if (opts.shuffleQuestions) questions = shuffle(questions, Number(opts.seed) || 42);
    const runId = opts.runId || makeRunId(marketplace);
    state = RunState.create(path.join(outDir, runId), {
      runId, marketplace, asins, questions,
      settings: {
        stableChecks: Number(opts.stableChecks) || 3,
        checkInterval: Number(opts.checkInterval) || 1.5,
        maxWaitTime: Number(opts.timeout) || 60,
        delayQuestion: parseRange(opts.delayQ, PACE_DEFAULTS.delayQuestion),
        delayAsin: parseRange(opts.delayAsin, PACE_DEFAULTS.delayAsin),
        breakEvery: opts.breakEvery === undefined ? PACE_DEFAULTS.breakEvery : Number(opts.breakEvery),
        allowMixedAccount: Boolean(opts.allowMixedAccount),
        collectMetadata: opts.metadata !== false,
      },
      accounts: opts.accounts || null,
    });
  }

  const log = createLogger({ file: path.join(state.dir, 'run.log'), verbose: opts.verbose });
  const cfg = state.data.settings;
  const pacer = new Pacer({
    delayQuestion: cfg.delayQuestion, delayAsin: cfg.delayAsin, breakEvery: cfg.breakEvery,
  });

  log.step(`${resuming ? '恢复' : '开始'} run ${state.data.runId}`);
  log.info(`  ${state.data.asins.length} 个 ASIN × ${state.data.questions.length} 题，站点 ${state.data.marketplace}`);
  log.info(`  输出目录 ${state.dir}`);

  const pool = AccountPool.load({ only: opts.accounts ? String(opts.accounts).split(',') : null });
  if (opts.maxPerDay) for (const a of pool.accounts) a.maxPerDay = Number(opts.maxPerDay);
  log.info(`  账号池：${pool.accounts.map((a) => a.id).join(', ')}`);

  const done = state.doneSet({ retryErrors: Boolean(opts.retryErrors) });
  if (resuming) log.info(`  已完成 ${done.size} 题，跳过`);

  const limit = opts.limit ? Number(opts.limit) : Infinity;
  let asked = 0;

  let ctx = null;
  let page = null;
  let currentAccountId = null;
  let exitCode = 0;

  const closeCtx = async () => { if (ctx) { await ctx.close().catch(() => {}); ctx = null; page = null; } };

  try {
    for (const asin of state.data.asins) {
      const pending = state.data.questions
        .map((q, i) => ({ q, i }))
        .filter(({ i }) => !done.has(`${asin}::${i}`));
      if (!pending.length) { log.debug(`${asin} 全部已完成，跳过`); continue; }
      if (asked >= limit) break;

      // 该 ASIN 最多重试 池大小 次（每次换一个账号）
      let attempts = 0;
      let asinDone = false;

      while (!asinDone && attempts <= pool.accounts.length) {
        attempts++;
        let account;
        try {
          account = pool.acquire();
        } catch (e) {
          if (e instanceof PoolExhaustedError) {
            log.error(e.message);
            state.setStatus(
              e.reason === 'quota' ? STATUS.QUOTA_EXHAUSTED
                : e.reason === 'signin' ? STATUS.PAUSED_SIGNIN : STATUS.PAUSED_ALL_BLOCKED,
              e.message
            );
            exitCode = e.exitCode;
            return finish();
          }
          throw e;
        }

        if (account.id !== currentAccountId) {
          await closeCtx();
          log.step(`切换账号 → ${account.id}`);
          ({ context: ctx } = await launchForAccount(account, {
            headless: Boolean(opts.headless), channel: opts.channel || 'chrome', log,
          }));
          page = await firstPage(ctx);
          if (currentAccountId !== null) await pacer.afterAccountSwitch(log);
          currentAccountId = account.id;
        }

        // ---- 导航 ----
        const url = productUrl(asin, state.data.marketplace);
        log.step(`[${account.id}] ${asin} → ${url}`);
        let navOk = true;
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        } catch (e) {
          navOk = false;
          log.error(`  导航失败：${e.message}`);
        }

        if (navOk) {
          const incident = await guard.check(page);
          if (incident && (incident.type === 'robot_check' || incident.type === 'signin')) {
            log.warn(`  [${account.id}] ${incident.detail} —— 标记账号并换号，本 ASIN 重跑`);
            pool.mark(account, incident.type);
            const n = state.supersedeAsin(asin);
            if (n) log.info(`  已作废该 ASIN 的 ${n} 行（回答按账号个性化，不混用）`);
            for (const { i } of pending) done.delete(`${asin}::${i}`);
            continue;                       // while 循环换号重跑
          }
          if (incident) {
            log.error(`  ${incident.detail}`);
            navOk = false;
          }
        }

        if (!navOk) {
          // 明知故改：插件此处静默丢弃整个 ASIN，这里补一行 ASIN 级 error
          state.appendResult({
            ...exporter.errorRow({ asin, category: '', question: NAVIGATION_FAILED, error: '导航失败或页面异常' }),
            runId: state.data.runId, account: account.id,
          });
          state.data.counters.asinFailed++;
          asinDone = true;
          break;
        }

        await pacer.settle();               // 复刻 background.js 的 3s 落地等待

        let meta = { productTitle: '', price: '' };
        if (cfg.collectMetadata) {
          meta = await collector.collectMetadata(page).catch(() => meta);
          log.debug(`  标题「${meta.productTitle.slice(0, 40)}」价格「${meta.price}」`);
        }

        try {
          await collector.openAssistantChat(page);
        } catch (e) {
          log.error(`  ${e.message}`);
          if (e.incidentType === 'alexa_auth_required') {
            // 账号本身没被封，只是这台机器上没有完整认证的会话 —— 标记后换号，本 ASIN 重跑
            pool.mark(account, e.incidentType);
            const n = state.supersedeAsin(asin);
            if (n) log.info(`  已作废该 ASIN 的 ${n} 行`);
            for (const { i } of pending) done.delete(`${asin}::${i}`);
            continue;
          }
          state.appendResult({
            ...exporter.errorRow({ asin, category: '', question: 'ALEXA_ENTRY_NOT_FOUND', error: e.message }),
            runId: state.data.runId, account: account.id,
          });
          state.data.counters.asinFailed++;
          asinDone = true;
          break;
        }

        // ---- 逐题 ----
        let yielded = false;
        for (const { q, i } of pending) {
          if (done.has(`${asin}::${i}`)) continue;
          if (asked >= limit) { log.info(`已达 --limit ${limit}，停止`); asinDone = true; break; }

          log.info(`  [${i + 1}/${state.data.questions.length}] ${q.question.slice(0, 60)}`);
          const hard = hardTimeout((cfg.maxWaitTime + 15) * 1000, '本题');
          let row;
          try {
            const r = await Promise.race([
              collector.askAndCapture(page, q.question, {
                stableChecks: cfg.stableChecks, checkInterval: cfg.checkInterval, maxWaitTime: cfg.maxWaitTime,
              }),
              hard,
            ]);
            row = {
              ...exporter.successRow({
                asin, productTitle: meta.productTitle, price: meta.price,
                category: q.category, question: q.question, answer: r.answer,
              }),
              runId: state.data.runId, questionIndex: i, categoryId: q.categoryId,
              captureSource: r.source, elapsedMs: r.elapsedMs, account: account.id,
            };
            log.ok(`    ${r.source} · ${r.answer.length} 字 · ${Math.round(r.elapsedMs / 1000)}s`);
          } catch (e) {
            row = {
              ...exporter.errorRow({ asin, category: q.category, question: q.question, error: e.message }),
              runId: state.data.runId, questionIndex: i, categoryId: q.categoryId, account: account.id,
            };
            log.error(`    ${e.message}`);
          } finally {
            hard.cancel();
          }

          state.appendResult(row);
          done.add(`${asin}::${i}`);
          asked++;
          pool.recordQuestion(account, row.status);

          if (pool.shouldYield(account)) {
            log.info(`  [${account.id}] 撞配额或转入冷却，下个 ASIN 换号`);
            yielded = true;
            break;
          }
          await pacer.afterQuestion(log);
        }

        // 本轮把该 ASIN 的待办跑完了（或让位/达上限）
        const stillPending = pending.some(({ i }) => !done.has(`${asin}::${i}`));
        if (!stillPending || !yielded) asinDone = true;
        if (yielded && stillPending) {
          // 同 ASIN 不跨账号：让位时把已答的行作废，换号后整个 ASIN 重跑
          if (!cfg.allowMixedAccount) {
            const n = state.supersedeAsin(asin);
            if (n) log.info(`  已作废该 ASIN 的 ${n} 行，换号后整体重跑（保证回答同源可比）`);
            for (const { i } of pending) done.delete(`${asin}::${i}`);
            asinDone = false;
          } else {
            asinDone = false;               // 允许混账号：换号续跑
          }
        }
      }

      if (asked >= limit) break;
      await pacer.afterAsin();
    }

    state.setStatus(state.data.counters.error > 0 ? STATUS.COMPLETED_WITH_ERRORS : STATUS.COMPLETED);
    exitCode = state.data.counters.error > 0 ? 2 : 0;
    return finish();
  } catch (e) {
    log.error(`致命错误：${e.stack || e.message}`);
    state.setStatus(STATUS.ABORTED, e.message);
    exitCode = 1;
    return finish();
  } finally {
    await closeCtx();
  }

  function finish() {
    const results = state.materializedResults();
    const csv = exporter.buildResultsCsv(results, { withAccount: Boolean(opts.withAccount) });
    const json = exporter.buildResultsJson(results, {
      marketplace: state.data.marketplace, totalAsins: state.data.asins.length,
    });
    fs.writeFileSync(path.join(state.dir, exporter.exportFilename(state.data.marketplace, 'csv')), csv);
    fs.writeFileSync(path.join(state.dir, exporter.exportFilename(state.data.marketplace, 'json')), json);

    const c = state.data.counters;
    log.step(`结束：成功 ${c.success} / 错误 ${c.error} / ASIN 级失败 ${c.asinFailed} / 作废 ${c.superseded}`);
    log.info(`  ${state.dir}`);
    log.close();
    return { exitCode, dir: state.dir, counters: c };
  }
}

function latestRunDir(outDir) {
  if (!fs.existsSync(outDir)) return null;
  const dirs = fs.readdirSync(outDir)
    .map((d) => path.join(outDir, d))
    .filter((d) => fs.existsSync(path.join(d, 'state.json')))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return dirs[0] || null;
}

module.exports = { collect, latestRunDir, NAVIGATION_FAILED };
