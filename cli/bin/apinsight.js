#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const pkg = require('../package.json');

const program = new Command();
program
  .name('apinsight')
  .description('Alexa 产品洞察 · 无人化采集 CLI（驱动真 Chrome 问 Amazon Alexa for Shopping）')
  .version(pkg.version);

const fail = (e) => {
  console.error(`\x1b[31m✗ ${e.message}\x1b[0m`);
  process.exit(typeof e.exitCode === 'number' ? e.exitCode : 1);
};

// ---- accounts ----
const acc = program.command('accounts').description('账号池管理');

acc.command('add')
  .description('登记一个账号（不导入凭据，随后用 login 人工登录）')
  .requiredOption('--id <id>', '账号 id，如 us-a')
  .option('--marketplace <mk>', '站点', 'US')
  .option('--max-per-day <n>', '该账号日配额', '600')
  .action((o) => { try { require('../src/commands/accounts.js').addAccount(o); } catch (e) { fail(e); } });

acc.command('import')
  .description('从 cookie 导出文件建立账号登录态（文件必须在仓库外；不解析密码与 2FA）')
  .requiredOption('--id <id>', '账号 id，如 us-a')
  .requiredOption('--file <path>', 'cookie 导出文件的绝对路径（仓库外）')
  .option('--line <n>', '多账号文件里取第几个（从 1 开始）', '1')
  .option('--marketplace <mk>', '站点', 'US')
  .option('--max-per-day <n>', '该账号日配额', '600')
  .option('--channel <c>', 'chrome | chromium', 'chrome')
  .option('--headed', '显示浏览器窗口')
  .option('-v, --verbose')
  .action(async (o) => {
    try {
      const r = await require('../src/commands/accounts.js').importCookies({ ...o, headless: !o.headed });
      process.exit(r.ok ? 0 : 4);
    } catch (e) { fail(e); }
  });

acc.command('list').description('查看账号池状态')
  .action(() => { try { require('../src/commands/accounts.js').list(); } catch (e) { fail(e); } });

acc.command('enable <id>').description('启用账号（并清除验证码/登录失效标记）')
  .action((id) => { try { require('../src/commands/accounts.js').setEnabled(id, true); } catch (e) { fail(e); } });

acc.command('disable <id>').description('停用账号')
  .action((id) => { try { require('../src/commands/accounts.js').setEnabled(id, false); } catch (e) { fail(e); } });

acc.command('reset-quota <id>').description('重置账号今日配额')
  .action((id) => { try { require('../src/commands/accounts.js').resetQuota(id); } catch (e) { fail(e); } });

// ---- login ----
program.command('login')
  .description('打开浏览器人工登录（cookie 失效时的兜底；工具不接触密码与验证码）')
  .requiredOption('--account <id>', '账号 id')
  .option('--asin <asin>', '用于验证 Alexa 是否可用的商品页', 'B08JHCVHTY')
  .option('--timeout-min <n>', '最多等待多少分钟', '15')
  .option('--channel <c>', 'chrome | chromium', 'chrome')
  .option('-v, --verbose')
  .action(async (o) => {
    try {
      const r = await require('../src/commands/accounts.js').login(o);
      process.exit(r.ok ? 0 : 4);
    } catch (e) { fail(e); }
  });

// ---- collect ----
program.command('collect')
  .description('批量采集：逐 ASIN 逐题问 Alexa 并落盘')
  .option('--asins <spec>', 'ASIN 串或文件路径')
  .option('--questions <spec>', '分类 id 逗号串 / all / 文件路径')
  .option('--marketplace <mk>', '站点', 'US')
  .option('--accounts <ids>', '限定使用的账号（逗号分隔），默认用池里全部启用账号')
  .option('--resume [runId]', '续跑（省略 runId 则取最近一个 run）')
  .option('--run-id <id>', '指定 run 名称')
  .option('--out-dir <dir>', '输出根目录')
  .option('--limit <n>', '本次最多问多少题')
  .option('--max-hours <n>', 'run 级总时长上限（小时），超时优雅收工')
  .option('--max-per-day <n>', '覆盖每个账号的日配额')
  .option('--timeout <sec>', '单题最长等待秒数', '60')
  .option('--delay-q <min,max>', '题间抖动区间（秒）')
  .option('--delay-asin <min,max>', 'ASIN 间抖动区间（秒）')
  .option('--break-every <n>', '每 N 题长休息')
  .option('--allow-mixed-account', '允许同一 ASIN 跨账号续跑（默认关，会牺牲回答可比性）')
  .option('--shuffle-questions', '随机题序')
  .option('--seed <n>', '洗牌种子', '42')
  .option('--retry-errors', '续跑时重试此前的错误行')
  .option('--headless', '无头模式（风险更高，不建议）')
  .option('--no-metadata', '不采集标题与价格')
  .option('--with-account', '导出的 CSV 追加 Account 列')
  .option('--channel <c>', 'chrome | chromium', 'chrome')
  .option('-v, --verbose')
  .action(async (o) => {
    try {
      const r = await require('../src/commands/collect.js').collect(o);
      process.exit(r.exitCode);
    } catch (e) { fail(e); }
  });

// ---- export / status / doctor ----
program.command('export')
  .description('从 run 目录重新导出 CSV/JSON')
  .option('--run <runId>', 'run 名称，默认最近一个')
  .option('--out-dir <dir>')
  .option('--format <f>', 'csv | json | both', 'both')
  .option('--with-account', 'CSV 追加 Account 列')
  .action((o) => { try { require('../src/commands/export.js').exportRun(o); } catch (e) { fail(e); } });

program.command('status')
  .description('查看 run 进度与账号池状态')
  .option('--run <runId>')
  .option('--out-dir <dir>')
  .action((o) => { try { require('../src/commands/status.js').status(o); } catch (e) { fail(e); } });

program.command('doctor')
  .description('环境与账号自检')
  .option('--accounts <ids>', '只检查指定账号（逗号分隔）')
  .option('--skip-browser', '跳过浏览器检查')
  .option('--skip-alexa', '跳过 Alexa 面板可用性探测')
  .option('--json', '输出结构化状态（供 agent 消费；含稳定 code 与 needsHuman）')
  .option('--headed', '显示浏览器窗口')
  .option('--channel <c>', 'chrome | chromium', 'chrome')
  .option('-v, --verbose')
  .action(async (o) => {
    try {
      const accounts = o.accounts ? String(o.accounts).split(',') : null;
      const r = await require('../src/commands/doctor.js').doctor({ ...o, accounts, headless: !o.headed });
      process.exit(r.ok ? 0 : 1);
    } catch (e) { fail(e); }
  });

program.parseAsync(process.argv).catch(fail);
