# Changelog

本项目的所有显著变更都会记录在此文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/)，版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Fixed
- **回答内容被切碎重复**：Alexa 的答案是 RFC 6902 JSON Patch 流（`type:"JSONPatches"`，
  `op:add/replace` + JSON Pointer 路径），实测单条流 193 次 `replace` + 14 次 `add`，
  同一路径被反复覆盖。原实现把见过的每个 `value.children` 全收集，只靠"后面有更长版本
  包含它"去重，中间态全部残留，产出形如「Based on customer reviews for the [**Blink
  Plus subscription / Based on customer reviews for the / , the most common complaints
  are:」的重复碎片。改为按序应用 patch 重建文档树再按文档顺序取文本；原启发式保留为
  非 JSONPatches 流的兜底。
- **找不到 Alexa 入口**：Amazon 已把 Alexa 从商品页内嵌组件（`.ask-pill` /
  `#dpx-nice-widget-container`）改为**全局导航侧边面板**，入口是 `#nav-rufus-disco`。
  旧选择器全部失效，插件此前无法打开 Alexa。新入口置于候选首位，旧的保留作兜底。
- **问题可能被打进隐藏的反馈输入框**：面板内另有 `#rufus-text-area-inner-N`
  （placeholder "Add your feedback..."，不可见）且 DOM 顺序更靠前，泛化的
  `... textarea` 选择器会先命中它。稳定 ID `#rufus-text-area` 提至最前，
  泛化候选加 `:not([id*="inner"])` 排除。
- **订阅类商品页标题为空**：这类页面不渲染标准商品详情 DOM（`#productTitle` /
  `#dp-container` 均不存在），改为回落解析 `document.title`。

### Added
- `cli/` 无人化采集 CLI（Playwright 驱动，多账号轮换、断点续跑、拟人化限速）。
  详见 [cli/README.md](cli/README.md)。CLI 与本插件的解析链由差分测试锁住一致性。

### Notes
- Alexa 需要**完整认证**的会话：导出的 cookie 异地重放只能到"已识别"级
  （账号栏显示姓名），面板会提示 `Please sign in to begin using Alexa`
  （登录链接带 `openid.pape.max_auth_age=0` 强制实时认证）。每个账号需在每台机器上
  人工登录一次。

## [1.0.0] - 2026-06-24

首个公开发布版本 · First public release.

### Added
- 批量向 Amazon **Alexa for Shopping**（原 Rufus）提问，自动采集竞品问答
- 支持 20+ 亚马逊站点（US / UK / DE / FR / IT / ES / JP / CA / AU / IN 等）
- 17 类、100+ 条内置通用问题，并支持自定义问题
- 自动检测回答完成、断点续传（暂停 / 继续 / 停止 / 任务恢复）
- 回答处理：保留英文原文 / 免费翻译 / 大模型翻译（OpenAI 兼容 & Anthropic，支持本地 Ollama、LM Studio）
- 采集结果一键导出 CSV / Excel / JSON
- 图文使用说明书 `使用说明.html` 与 `使用教程.md`
- 抓包 / 选择器调试脚本 `tools/`（network-spy、click-spy）

### Notes
- 数据本地优先，结果存于浏览器本地存储，不上传服务器
- 适配亚马逊将 Rufus 合并改名为 Alexa for Shopping 后的页面与交互
