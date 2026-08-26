## 🚀 Way to AIC | 通往 AI 电商之路
---
### 🌐 官网 Website
- https://waytoaic.com
- https://www.waytoaic.com
---

### 👥 社群招募 Community
`Way to AIC 社群招募 | WaytoAIC.com`

<p align="center">
  <img src="https://github.com/user-attachments/assets/d9f8bbf4-2056-4780-975d-86c885b52bab" width="70%">
</p>

---

### 📣 公众号 WeChat Official Account
`维正 WaytoAIC`

<p align="center">
  <img src="https://github.com/user-attachments/assets/71c71a5c-e68a-4f30-9afb-f2b056619991" width="300">
</p>

---

### 🧠 知识星球 Xiaozhixing
`AI电商之路 WaytoAIC`

<p align="center">
  <img src="https://github.com/user-attachments/assets/9eccef07-0e84-45a7-a415-affcb18c928d" width="200">
  <img src="https://github.com/user-attachments/assets/4e99fbc3-1981-4fee-b113-c9821141102d" width="400">
</p>

---

### 🧩 About Way to AIC

**AIC = AI Commerce**

在 AI 重塑商业的时代，我们希望和每一个拥抱 AI 的卖家：

- 找到场景
- 定义问题
- 积累能力
- 设计系统

共同通往 AI 电商之路。

> Way to AIC 不是教学，不是工具，
> 而是一条所有电商人共同走的进化之路。

### WaytoAIC 理念 | Principles

| 中文 | English |
|---|---|
| 场景先于方法 | Context before method |
| AI 的价值来自真实业务场景，而不是技术本身。 | AI creates value through real business contexts, not through technology alone. |
| 问题先于答案 | Problem before answer |
| 定义问题，比拥有工具更重要。 | Defining the problem matters more than collecting tools. |
| 系统胜过技巧 | System over tricks |
| 技巧是术，系统才是道，决定卖家的上限。 | Tricks are tactical; systems define long-term leverage and ceiling. |
| 共创优于独行 | Co-creation over solo progress |
| 我们相信，真正的进化发生在共同探索的过程中。 | Real evolution happens through shared exploration. |

---
---

# Alexa 产品洞察 · Alexa Insight

> 批量向亚马逊 **Alexa for Shopping**（原 Rufus）提问，自动采集竞品差评痛点、好评卖点与产品洞察，一键导出表格。
>
> 两种用法：**Chrome 扩展**（人工操作，开箱即用）与 **apinsight CLI**（无人值守，可挂定时任务）。
>
> A Chrome extension that batch-asks Amazon **Alexa for Shopping** (formerly Rufus) about competitor listings, then collects negative-review pain points, positive selling points, and product insights — exportable as a spreadsheet.

<p align="center">
  <img src="https://img.shields.io/badge/platform-Chrome%20MV3-1769e0" alt="Chrome MV3">
  <img src="https://img.shields.io/badge/version-1.0.0-3b82f6" alt="v1.0.0">
  <img src="https://img.shields.io/badge/marketplaces-20%2B-17b26a" alt="20+ marketplaces">
  <img src="https://img.shields.io/badge/license-source--available-b54708" alt="source-available">
</p>

---

## ✨ 这是什么 | What it is

做亚马逊选品和运营，最值钱的情报藏在**竞品的真实评价里**。亚马逊的 AI 导购 **Alexa for Shopping**（2026 年由 Rufus 改名合并而来）已经替你读完了所有评论，你只要会问。

这个插件做的事就是**替你批量地问**：给它一批竞品 ASIN，选好想了解的角度，它会自动逐个打开商品页、唤起 Alexa、把问题一条条发过去、等回答生成完，再把所有问答整理成一张表交给你。

> The most valuable intelligence in Amazon selling lives in **real competitor reviews**. Alexa for Shopping has already read them all — you just need to ask. This extension asks **in batch**: feed it competitor ASINs, pick the angles you care about, and it opens each product page, invokes Alexa, sends every question, waits for each answer to finish, and hands you a clean table of Q&A.

---

## ⚡ 两个产物 | Two ways to run

| | Chrome 扩展 | apinsight CLI |
|---|---|---|
| 怎么跑 | 人开着浏览器、点「开始采集」 | 一条命令，无人值守 |
| 适合 | 临时查几个竞品 | 每天定量跑、挂定时任务 |
| 产能 | 取决于人盯多久 | **50 个 ASIN / 天**（各 24 核心题），约 9 小时跑完 |
| 入口 | 见下方「安装」 | [`cli/`](cli/) · [README](cli/README.md) |

### apinsight CLI 速览

把「人开着 Chrome 点开始」变成一条命令：驱动持久化的真 Chrome，逐 ASIN 逐题问 Alexa，抓 SSE 回答落盘。

```
一批 ASIN  →  逐题问 Alexa  →  抓 SSE 回答  →  CSV / JSON
```

| 50 个 | 102 题 | 10 秒 | 9 小时 |
|---|---|---|---|
| ASIN / 天 | 内置题库 16 类 | 单题实测中位 | 跑满一天配额 |

**内建**：多账号轮换 · 断点续跑 · 拟人化限速 · 日配额 · 结构化自检（`doctor --json`，供 AI agent 消费）

```bash
node bin/apinsight.js accounts add --id us-a
node bin/apinsight.js login --account us-a        # 唯一需要人的一步
node bin/apinsight.js collect --asins asins.txt --questions summary_all --max-hours 10
```

> ⚠️ **一个前提**：每台机器 × 每个账号需要人工登录一次。Amazon 把登录态分两级——重放 cookie 只到「已识别」，而 Alexa 要求「已认证」，必须在那台机器上真实登录。这一步无法自动化，拷 profile 也不行；好在只需一次。

📘 [换机与交接手册](cli/换机与交接手册.md)（给人看） · [Agent 操作契约](AGENTS.md)（给 AI 看）

---

## 🎯 功能 | Features（Chrome 扩展）

- 🛒 **20+ 亚马逊站点** — US / UK / DE / FR / IT / ES / JP / CA / AU / IN 等
- 🤖 **17 类 · 100+ 内置问题** — 差评痛点、好评驱动、质量耐用、竞品对比、性价比、改进机会等，措辞通用、任何品类都能问；也支持自定义问题
- ⚙️ **自动判完成** — 自动检测 Alexa 回答是否生成完毕，确认稳定后才进入下一题
- ⏯️ **断点续传** — 支持暂停 / 继续 / 停止，任务状态本地保存，可恢复
- 🌐 **回答处理** — 保留英文原文 / 免费翻译 / 大模型翻译（OpenAI 兼容 & Anthropic，支持本地 Ollama、LM Studio）
- 📊 **一键导出** — CSV / Excel / JSON，含标题、价格、问答、状态、时间戳
- 🔒 **本地优先** — 结果存于浏览器本地，数据不出本机

## 🚀 安装 | Install

本扩展以「开发者模式」加载，约 1 分钟：

1. 打开 Chrome 扩展管理页：`chrome://extensions/`（Edge 用 `edge://extensions/`）
2. 开启右上角「开发者模式 / Developer mode」
3. 点击「加载已解压的扩展程序 / Load unpacked」
4. 选择本项目目录（含 `manifest.json`）
5. 点击图标，面板会从浏览器**右侧边栏**滑出

> Load as an unpacked extension: open `chrome://extensions/`, enable Developer mode, click **Load unpacked**, and select this project folder.

## 📖 使用 | Usage

1. **设置**：选目标站点 → 粘贴竞品 ASIN 或商品链接 → 勾选问题分类（新手直接用 ⭐ 核心必问）
2. **采集**：点「开始采集」，在「进度」页看实时日志，支持暂停 / 停止
3. **导出**：完成后在「结果」页按 ASIN / 分类筛选，导出 CSV / Excel / JSON

📘 完整图文说明见 **[使用说明.html](使用说明.html)**（在浏览器打开）与 **[使用教程.md](使用教程.md)**。

## 🗂️ 目录结构 | Structure

```text
cli/          apinsight 无人化采集 CLI（Node + Playwright）
background/   后台任务编排与状态管理
content/      Amazon 页面注入脚本与 Alexa 交互逻辑
data/         预设问题（17 类）
popup/        侧边栏面板 UI
utils/        ASIN 解析工具
tools/        抓包 / 选择器调试脚本（network-spy、click-spy）
icons/        扩展图标
manifest.json Chrome 扩展配置
使用说明.html  图文使用说明书
使用教程.md    使用教程
```

## ❓ 常见问题 | FAQ

- **没识别到 ASIN？** 确认输入含标准 10 位 ASIN（如 `B0XXXXXXXX`），或直接粘贴商品链接。
- **Alexa 没打开 / 采不到回答？** 多为亚马逊页面改版，可在「高级设置 → 选择器配置」更新选择器，或换 ASIN / 换 US 站试试。
- **想要中文结果？** 高级设置里选「大模型翻译」，推荐配本地 Ollama / LM Studio，免费且数据不出本机。
- **结果会丢吗？** 不会，实时存浏览器本地，可随时在「结果」页导出。

## 📜 许可 | License

本仓库为**源代码可见（source-available）**项目，非 OSI 意义上的开源：可自由学习、个人非商业使用；**商业用途需获作者书面授权**。详见 [LICENSE.md](LICENSE.md) 与 [ADDITIONAL_TERMS.md](ADDITIONAL_TERMS.md)。

---

<p align="center">
  <b>Way to AIC · 通往 AI 电商之路</b><br>
  把竞品评论里的洞察，自动变成你的选品弹药
</p>
