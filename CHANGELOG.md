# Changelog

本项目的所有显著变更都会记录在此文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/)，版本遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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
