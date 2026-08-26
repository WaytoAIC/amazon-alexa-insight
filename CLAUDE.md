# CLAUDE.md — alexa-insight

本仓库两个产物：`cli/` 是无人化采集器 apinsight（主力，由 agent 安装维护），
根目录其余是同名 Chrome 插件（人工使用，与 CLI 共享解析逻辑）。

## Git 约定

级别 L2,私有远端见项目登记册;全局规则见 `~/dev/sops/git协作规范.md`(节点提交、标题末尾 `@Agent名` 落款 hook 强制、密钥不入仓)。

---

# apinsight · Agent 操作契约

**面向 agent 安装与维护。人看的版本在 [cli/换机与交接手册.md](cli/换机与交接手册.md)。**

所有判定走 `doctor --json` 与退出码，**不要 grep 日志文本**（中文、会变）。

## 传感器：一条命令拿全部状态

```bash
cd <repo>/cli && node bin/apinsight.js doctor --json
```

```jsonc
{
  "ok": false,
  "needsHuman": true,          // ← 唯一需要升级给人的判据
  "usableAccounts": 1,
  "checks":   { "node": {...}, "playwright": {...}, "chrome": {...}, "accountsConfig": {...} },
  "accounts": [ { "id":"us-a", "loggedIn":true, "alexaUsable":true, "remaining":589, ... } ],
  "blockers": [ { "code":"ALEXA_AUTH_REQUIRED", "account":"us-b",
                  "action":"apinsight login --account <id>", "needsHuman":true } ]
}
```

`--skip-browser` 只查配置与配额（秒级）；不带则真开浏览器验登录态与 Alexa 可用性（每账号约 10 秒）。

⚠️ `--skip-browser` 时 `browserChecked:false` 且 **`usableAccounts` 为 `null`（未知）而非 `0`**。
判定时先看 `browserChecked`，别把"没查"当成"没有"。

## 原因码 → 动作

`code` 是稳定契约，改动等同破坏 API。

| code | needsHuman | 动作 |
|---|---|---|
| `NODE_TOO_OLD` | 否 | 装 Node ≥ 20 |
| `PLAYWRIGHT_MISSING` | 否 | `cd cli && npm install` |
| `CHROME_MISSING` | 否 | 装 Chrome（`severity:"warning"`，可继续但风控概率升高） |
| `ACCOUNTS_NOT_CONFIGURED` | 否 | `accounts add --id <id>` |
| `ACCOUNT_DISABLED` | 否 | `accounts enable <id>` |
| `ACCOUNT_COOLING` | 否 | 等 `cooldownUntil` |
| `QUOTA_EXHAUSTED` | 否 | 等次日重置或加账号 |
| `BROWSER_LAUNCH_FAILED` | 否 | 查 Chrome 与 profile 目录权限 |
| `ALEXA_STATE_UNKNOWN` | 否 | 重跑 doctor；持续出现 = Amazon 可能改版，需人介入排查 |
| **`NOT_LOGGED_IN`** | **是** | `login --account <id>` |
| **`ALEXA_AUTH_REQUIRED`** | **是** | `login --account <id>` |
| **`ROBOT_CHECK`** | **是** | 人工过验证码后 `accounts enable <id>` |

## 采集退出码

| 码 | 含义 | agent 动作 |
|---|---|---|
| 0 | 完成 | — |
| 2 | 完成但有 error 行 | 读 `runs/<id>/results.jsonl` 里 `status=="error"` 的行 |
| 3 | 撞人机验证 | **升级给人** |
| 4 | 登录态失效 | **升级给人** |
| 5 | 配额耗尽 | 正常收工，次日再跑 |
| 1 | 致命错误 | 读 `runs/<id>/run.log` |

## ⛔ 唯一无法自动化的一步

**每台机器 × 每个账号需要人工登录一次。** Amazon 把登录态分两级：重放 cookie
只到「已识别」（账号栏显示姓名、能浏览），Alexa 要求「已认证」——必须在**那台机器上**
真实登录。面板会明说 `Please sign in to begin using Alexa`，登录链接带
`openid.pape.max_auth_age=0`（强制实时认证）。

agent 到此**必须停下并升级给人**：
- 不要尝试输入密码或 2FA 验证码
- 不要尝试绕过或求解验证码
- 拷贝 profile 到另一台机器无效

`login` 命令会开好窗口停在登录页等人操作，成功判据是 Alexa 面板真正可用（不是账号栏有名字）。

## 安装（幂等，可重复跑）

```bash
git clone https://github.com/WaytoAIC/amazon-alexa-insight.git ~/apinsight-repo
cd ~/apinsight-repo/cli
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install    # 用系统 Chrome，自带 chromium 用不上
node --test test/*.test.js                        # 门禁：107 个必须全绿
node bin/apinsight.js doctor --json               # 读 blockers 决定下一步
```

**不能只拷 `cli/`**：CLI 用写死的相对路径复用 `content/network-hook.js`、
`data/preset-questions.js`、`utils/asin-parser.js`。

## 采集

```bash
node bin/apinsight.js collect --asins <file|B0X,B0Y> --questions summary_all --max-hours 10
node bin/apinsight.js collect --resume            # 断点续跑，幂等
```

产物在 `runs/<runId>/`：`results.jsonl`（明细，含 `account`/`captureSource`/`superseded`）、
CSV/JSON 导出、`state.json`、`run.log`。

`captureSource` 是质量信号：`network` 正常；大量 `dom` 说明主路有问题，查 run.log。

## 改代码前必读

1. **`cli/` 与插件共享解析逻辑，差分测试锁住一致性**
   `test/sse-parser-differential.test.js` 从 `content/content.js` 抽原实现在沙箱里跑，
   与 `cli/src/lib/sse-parser.js` 逐输入比对。**改任一侧都要同步另一侧**，否则测试红。
   唯一有意分歧：JSON Patch 主路（两侧实现逐字一致，但 CLI 先落地）。

2. **`MAX_NETWORK_RAW_CHARS` 不是随手设的余量**
   Alexa 单题 SSE 流实测 152KB–446KB。JSON Patch 流创建根节点的
   `op:add path:"/"` 在流的**最开头**，截断丢头 = 后续 patch 全跳过 = 答案静默变空。
   当前 2MB，测试断言要求 ≥5 倍实测最大值。调小会复现"偶发失败"。

3. **提问框选择器顺序不能动**
   面板里有隐藏的反馈框 `#rufus-text-area-inner-N`，DOM 顺序比提问框更靠前。
   稳定 ID `#rufus-text-area` 必须排最前，泛化候选必须带 `:not([id*="inner"])`。

4. **DOM 兜底有质量闸门**
   `isPanelBoilerplate` 拦截面板样板文字。删掉它会让 UI 文案以 `status=success` 入库，
   静默污染数据集。

5. **限速默认值别调**
   1200 题/天已是需求的 2.5 倍。调快不带来价值，却拿买家号冒险。
   要调先连续 7 天零 captcha，且一次只动一个参数。并发恒为 1，不开放。

6. **凭据永不进仓**
   `accounts import` 会拒绝读取 git 工作区内的文件。测试 fixture 必须脱敏。
