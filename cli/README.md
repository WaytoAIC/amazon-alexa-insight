# apinsight — Alexa 产品洞察无人化采集 CLI

**把 Alexa 问出来的话，变成能算的数据。**

Amazon 的 AI 导购 Alexa 会基于真实评论回答商品问题——买家在抱怨什么、哪里质量翻车、
值不值这个价。这套工具把它批量问出来，落成结构化数据。

```
一批 ASIN  →  逐题问 Alexa  →  抓 SSE 回答  →  CSV / JSON
```

| 50 个 | 102 题 | 10 秒 | 9 小时 |
|---|---|---|---|
| ASIN / 天（各 24 核心题） | 内置题库 16 类 | 单题实测中位（21 题样本） | 跑满一天配额 |

相对插件的改进：不用人盯着、断点续跑、多账号轮换、拟人化限速、日配额、
结构化自检（`doctor --json`，供 AI agent 消费）。输出 CSV 九列与插件同 schema。

## ⚠️ 一个前提：每台机器每个账号需人工登录一次

**实测（2026-08-26，Mac mini）**：把导出的 cookie 导入 profile 后，账号栏能显示 `Hello, X`，
浏览、看价格都正常 —— 但 Alexa 面板会显示：

> Please sign in to begin using Alexa.

其登录链接带 `openid.pape.max_auth_age=0`，即 **强制实时重新认证**。
说明 Amazon 把状态分成两级：

| 状态 | 来源 | 能做什么 |
|---|---|---|
| 已识别 recognized | 重放 `x-main` / `at-main` 等 cookie | 浏览、显示姓名、看价格 |
| 已认证 authenticated | 在**本机**真实完成一次登录 | **Alexa 才可用** |

所以每个账号需要在**执行机上**人工登录一次（`apinsight login --account <id>`）。
登录态随后保存在该账号的持久化 profile 里，之后就能长期无人值守跑。
本工具不接触密码与 2FA —— 登录窗口全程由你自己操作。

`apinsight doctor` 会明确区分这两种状态并给出修复命令。

> 换新机器或交给别人用？看 [换机与交接手册.md](换机与交接手册.md)（给人看）
> 与 [Agent 操作契约](../AGENTS.md)（给 AI 看）。

## 安装

需要 Node ≥ 20 与系统 Google Chrome（强烈建议用真 Chrome，指纹差异会显著提高触发人机验证的概率）。

```bash
cd cli && npm install
```

无 sudo 装 Node（执行机常用）：把官方 macOS ARM64 tarball 解到 `~/.local/node`，
再把 `~/.local/node/bin` 加进 PATH。

## 快速开始

```bash
# 1. 登记账号。没有 cookie 导出就用 add：
apinsight accounts add --id us-a
#    有 cookie 导出可改用 import（文件必须在仓库外，且只解析 cookie 段）：
#    apinsight accounts import --id us-a --file ~/.config/ai-hub/amazon-buyers/buyer-a.json

# 2. 在本机真实登录一次（Alexa 的硬性要求，见上）—— 唯一需要人的一步
apinsight login --account us-a

# 3. 自检：环境 / 登录态 / Alexa 是否真的可用
apinsight doctor

# 4. 采集
apinsight collect --asins B08JHCVHTY --questions summary_all
```

## 命令

| 命令 | 用途 |
|---|---|
| `accounts import --id <id> --file <path> [--line N]` | 从 Cookie-Editor 导出建立登录态 |
| `accounts list / enable / disable / reset-quota` | 账号池运维 |
| `login --account <id>` | 人工登录（工具不碰密码与验证码） |
| `collect` | 批量采集 |
| `export --run <id> [--with-account]` | 重新导出 CSV/JSON |
| `status` | run 进度 + 账号池状态 |
| `doctor` | 环境、登录态、Alexa 可用性自检 |

`--questions` 取值：分类 id 逗号串 / `all`（16 类 102 题）/ 每行一题的文件。

## 退出码（cron 告警按此分流）

| 码 | 含义 | 处理 |
|---|---|---|
| 0 | 全部完成 | — |
| 2 | 完成但有 error 行 | 看 CSV 的 Status 列 |
| 3 | 有账号撞人机验证 | 人工处理后 `accounts enable <id>` |
| 4 | 有账号登录态失效 / Alexa 需重新认证 | `login --account <id>` |
| 5 | 全池今日配额耗尽 | 等次日或加账号 |
| 1 | 致命错误 | 看 run.log |

## 多账号轮换

策略是**配额+健康度驱动**：一个账号一直跑，撞日配额或被判异常才换，且**切换只发生在 ASIN 边界**。

**同一 ASIN 不跨账号** —— Alexa 回答按账号个性化，混用会让同一 ASIN 的回答不可比。
中途换号时，前一账号已答的行会被标 `superseded`（jsonl 里保留可审计，导出时排除），
整个 ASIN 由新账号重跑。`--allow-mixed-account` 可放宽，代价是牺牲可比性。

绝不并行使用多账号 —— 同机并发是最强的账号关联信号。

## 限速默认值

| 项 | 默认 |
|---|---|
| 题间 | 4-9s 抖动 |
| ASIN 间 | 20-45s 抖动 |
| 切号后静默 | 30-90s |
| 长休息 | 每 25 题休 2-5 分钟 |
| 日配额 | 600 题 / 账号 |

## 断点续跑

```bash
apinsight collect --resume              # 续最近一个 run
apinsight collect --resume <runId>      # 续指定 run
apinsight collect --resume --retry-errors   # 顺带重试此前的错误行
```

`results.jsonl` 是 append-only，每题落盘一次，进程被杀不丢数据（末尾半行会被容忍）。
问题列表在 run 创建时冻结进 `state.json`，续跑不受题库文件后续改动影响。

## 定时无人值守（macOS LaunchAgent）

必须用 **LaunchAgent**（跑在用户的 Aqua 会话里，能开 headed 窗口），不是 LaunchDaemon。
写入 `~/Library/LaunchAgents/com.waytoaic.apinsight.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.waytoaic.apinsight</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string><string>-lc</string>
    <string>caffeinate -i "$HOME/.local/node/bin/node" "$HOME/apinsight-repo/cli/bin/apinsight.js" collect --asins "$HOME/.apinsight/asins.txt" --questions summary_all --max-hours 10 >> "$HOME/.apinsight/cron.log" 2>&1</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.waytoaic.apinsight.plist
```

要点：
- `caffeinate -i` 防止机器休眠打断长跑
- `--max-hours` 给 run 级兜底，避免卡死占着账号
- 按退出码告警：3/4 要人工（验证码 / 重新登录），5 是配额耗尽属正常
- 每天先 `apinsight doctor` 确认 Alexa 仍可用，再跑采集

## 输出

run 目录下：

- `results.jsonl` — 全量明细（含 `account` / `captureSource` / `elapsedMs` / `superseded`）
- `alexa-insight-<站点>-<时间>.csv` — **与插件逐字节同 schema 的 9 列**（有差分测试保障）
- `alexa-insight-<站点>-<时间>.json`
- `state.json` / `run.log`

CSV 默认不含 account 列，是为了能和插件的导出直接对照；需要时加 `--with-account`。

## 实测插件本身

系统 Chrome 装不了：Chrome 137+ 移除了 `--load-extension` 自动化通道，Chrome 151 上连
`--disable-features=DisableLoadExtensionCommandLineSwitch` 也无效（CDP `Target.getTargets`
里扩展 target 数为 0）。**但 Playwright 自带的 Chromium 构建保留了这个能力**，且
playwright 1.62.1 捆绑的 Chromium 151 与当前系统 Chrome 同主版本，可直接复用
Chrome 建立的已认证 profile（低版本 Chromium 打开会崩溃）。

两个工具，分工不同：

```bash
# 快测：注入 content.js 打桩跑，不复制 profile，覆盖采集链路
cd cli && node tools/plugin-e2e-test.js B0DCH8VDXF

# 全测：真正装扩展，驱动 popup → background → content，额外覆盖消息管道层
cd cli && node tools/plugin-full-ext-test.js B0DCH8VDXF
```

全测会把源 profile 复制成独立的 `ext151`，不污染生产 profile。
两者都要求源 profile 已在本机完成真实登录。

## 与插件的行为差异

1. 导航失败时插件会静默丢弃整个 ASIN 且不留记录；CLI 补一行 `question=NAVIGATION_FAILED` 的 error 行
2. 标题与价格插件每题采一次，CLI 每 ASIN 采一次（schema 不变）
3. CLI 不做翻译，`Answer` 与 `Answer (EN)` 同为原文（等同插件的 `mode: none`）
4. CSV 采用 background 版的全字段转义（popup 版漏转义 asin/status/timestamp，是 bug）

## 安全约束

- **凭据由 ai-hub 统一托管**：`~/.config/ai-hub/amazon-buyers/`（700，文件 600），
  并登记在 `~/dev/ai-hub/registry/inventory.toml` 的不收口层（`amazon-buyer-accounts`）。
  换机时 `aihub bootstrap` 的恢复清单会列出"每台机器需人工登录一次"这条。
  cookie 属登录态、收口即失效，**不进 secrets.env**（ai-hub SOP §1.5）
- 凭据文件**必须在仓库外**，`accounts import` 会拒绝读取 git 工作区内的文件
- 只解析 cookie 段；密码与 2FA 恢复码不解析、不落盘、不使用
- 只保留 amazon 自有域 cookie，广告追踪域全部丢弃
- 遇人机验证只识别与上报，**绝不尝试绕过或求解**

## 已知风险

- **账号关联**：多账号跑在同一台设备、同一出口 IP 是最容易被关联的模式。
  profile 只隔离 cookie，设备指纹与 IP 是共享的，本工具**不做指纹伪装**。
  `accounts.json` 里每个账号预留了 `proxy` 字段，填上即生效，无需改代码。
- **Alexa 入口会变**：2026-08 实测 Amazon 已把 Alexa 从商品页内嵌组件
  （`.ask-pill` / `#dpx-nice-widget-container`）改为全局导航侧边面板
  （`#nav-rufus-disco` / `#nav-rufus-content`）。选择器列表保留了新旧两套候选。
