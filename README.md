<div align="center">
  <img src="resources/icon.png" alt="SD Knowledge Logo" width="120" />
</div>

<div align="center">

# SD Knowledge

**面向 AI Agent 的本地知识中枢**

集知识库、知识图谱、混合检索、流式问答与项目工作台于一体的本地优先桌面应用

[English](./README_EN.md) | 简体中文

<p>
  <a href="https://github.com/gqallen931/sd-knowledge/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/Version-1.0.0-blue.svg" alt="Version" />
  <img src="https://img.shields.io/badge/Electron-30-47848F?logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Platform-Windows-0078D6?logo=windows&logoColor=white" alt="Platform" />
  <img src="https://img.shields.io/badge/PRs-Welcome-brightgreen.svg" alt="PRs Welcome" />
</p>

</div>

---

## 目录

- [项目简介](#项目简介)
- [为什么选择 SD Knowledge](#为什么选择-sd-knowledge)
- [项目演示](#项目演示)
- [核心特性](#核心特性)
- [技术架构](#技术架构)
- [快速开始](#快速开始)
- [安装与配置](#安装与配置)
- [使用示例](#使用示例)
- [运行模式](#运行模式)
- [项目结构](#项目结构)
- [文档](#文档)
- [安全与隐私](#安全与隐私)
- [路线图](#路线图)
- [贡献指南](#贡献指南)
- [许可证](#许可证)
- [联系方式](#联系方式)

## 项目简介

SD Knowledge 是一款**本地优先（Local-First）**的知识管理与智能问答平台。它将散落在本地各处的文档解析为可检索、可溯源的知识资产，通过 **FTS5 全文检索 + 向量检索的 RRF 混合排序**提供精准检索能力，并可接入任意 OpenAI 兼容的大模型，实现**带引用出处的流式问答**。

同时，内置的 **MCP Server** 让 AI Agent 能够通过标准协议直接检索与读写你的知识库——SD Knowledge 不只是给人用的知识库，更是 AI Agent 的知识底座。

## 为什么选择 SD Knowledge

| 维度 | SD Knowledge | 传统云笔记 / SaaS 知识库 |
| --- | --- | --- |
| 数据归属 | 100% 本地 SQLite，数据完全私有 | 数据托管在第三方云端 |
| AI 能力 | 自带 LLM 网关 + RAG 问答 + MCP 协议 | 依赖厂商封闭 AI，无法对接自有 Agent |
| 检索质量 | 全文 + 向量 RRF 混合排序，结果可溯源到分块 | 多为关键词匹配，无法核验出处 |
| 可扩展性 | 插件架构（ADR-005），内建功能即插件 | 功能封闭，无法扩展 |
| 离线可用 | 完全离线可用，LLM 未配置时自动降级为检索 | 断网即不可用 |

## 项目演示

<!-- DEMO VIDEO：录制后取消注释，视频托管至 Release 附件或 B 站/YouTube
<div align="center">
  <a href="https://github.com/gqallen931/sd-knowledge/releases/download/demo/demo.mp4">
    <img src="docs/assets/demo-cover.png" alt="SD Knowledge 演示视频" width="800" />
  </a>
  <p><em>点击观看完整演示视频（2 分钟）</em></p>
</div>
-->

| 知识概览仪表盘 | 流式问答（DeepSeek） |
| :---: | :---: |
| ![知识概览](docs/assets/screenshot-dashboard.png) | ![问答页](docs/assets/screenshot-ask.png) |
| **资源汇 · GitHub 每日榜单** | **知识图谱** |
| ![资源汇](docs/assets/screenshot-resources.png) | ![知识图谱](docs/assets/screenshot-graph.png) |

## 核心特性

### 📚 知识库与混合检索
- **多格式文档解析**：PDF、Word、Excel、图片（OCR + EXIF）、视频（关键帧抽取），统一分块入库
- **RRF 混合检索**：FTS5 全文检索（trigram 分词，原生支持中文）+ 本地向量检索，倒数排名融合排序
- **分块级溯源**：检索与问答结果均可回查至原文档的具体分块与位置锚点（页码 / 时间戳）
- **文件夹映射**：监听本地目录，增量同步入库，支持目录树与跨项目桥接

### 🤖 AI 问答与 Agent 接入
- **流式问答**：基于 SSE 的流式输出，引用面板实时展示出处；LLM 未配置时自动降级为纯检索页，不留无效入口
- **LLM 网关**：支持任意 OpenAI 兼容端点（DeepSeek 等），密钥仅存主进程，渲染进程零暴露
- **MCP Server**：内置 Model Context Protocol 服务，AI Agent 可通过标准协议检索、读写知识库
- **质量可度量**：内置检索评测集与基线回归（`npm run eval`），检索质量持续可度量

### 🕸️ 知识图谱
- 自动从文档抽取实体与关系，构建可视化知识图谱
- 支持图谱编辑、实体合并建议、别名管理与合并历史审计

### 📊 项目工作台
- 项目、任务分组、甘特图、日程与分析看板一体化
- 资源汇：GitHub 多领域 Star 榜单每日快照、开源项目卡片式管理

### 🧩 插件架构
- 遵循 ADR-005 的四层插件体系：注册表 / 加载器 / 宿主 / 内建插件
- **「吃自己的狗粮」原则**：所有内建功能均通过插件路径实现，扩展点经过真实验证
- 插件通过 `manifest.json` 声明 apiVersion 与权限；加载失败自动隔离，宿主零影响

## 技术架构

![SD Knowledge 架构总览](docs/assets/architecture.png)

| 层 | 技术选型 |
| --- | --- |
| 桌面壳 | Electron 30（主进程 / 预加载 / 渲染进程隔离） |
| 前端 | React 18 · TypeScript · Vite · Tailwind CSS · ECharts |
| 后端 | Node.js · Express（Web 模式 API） |
| 数据库 | better-sqlite3（FTS5 · WAL · 版本化迁移） |
| AI / NLP | @xenova/transformers（本地向量）· nodejieba · compromise |
| 文档解析 | pdfjs-dist · mammoth · xlsx/exceljs · tesseract.js · fluent-ffmpeg |
| Agent 接入 | @modelcontextprotocol/sdk |

## 快速开始

### 环境要求

- Node.js ≥ 18
- Windows 10/11（当前主要支持平台；macOS / Linux 适配见[路线图](#路线图)）

### 三分钟跑起来

```bash
# 1. 克隆仓库
git clone https://github.com/gqallen931/sd-knowledge.git
cd sd-knowledge

# 2. 安装依赖并重建原生模块（better-sqlite3）
npm install
npm run rebuild

# 3. 启动开发环境（Vite 热更新 + Electron）
npm run dev
```

启动后创建项目、拖入文档，待解析完成即可在检索中心搜索；配置 LLM 后（见下文）即可开启流式问答。

## 安装与配置

### 生产环境安装

```bash
# 构建并打包 Windows 安装包（输出至 release/）
npm run package:win
```

### LLM 配置（可选）

在「设置 → LLM 网关」中配置任意 OpenAI 兼容端点：

| 配置项 | 示例 | 说明 |
| --- | --- | --- |
| API Endpoint | `https://api.deepseek.com/v1` | OpenAI 兼容接口地址 |
| API Key | `sk-...` | 仅存储于主进程，不上传、不暴露给渲染进程 |
| Model | `deepseek-chat` | 模型标识 |

> 未配置 LLM 时，问答页自动降级为检索页，核心检索能力不受影响。

## 使用示例

<details>
<summary><b>示例 1：流式问答（带引用溯源）</b></summary>

在问答页输入问题，系统先执行混合检索，再将命中的分块作为上下文交给 LLM 流式生成答案，每个结论附引用编号；点击引用可跳转到原文档的具体分块位置。本地语料无法支撑结论时，系统如实返回「资料中没有相关内容」，不编造答案。
</details>

<details>
<summary><b>示例 2：通过 MCP 让 AI Agent 接入知识库</b></summary>

```bash
# 以 MCP Server 形态启动
npm run mcp
```

在支持 MCP 的 Agent（如 Claude Desktop）配置中注册该 Server，Agent 即可调用检索、读取、写入等标准工具，直接操作你的知识库。
</details>

<details>
<summary><b>示例 3：文件夹映射自动入库</b></summary>

在「文件管理 → 文件夹源」中添加本地目录（如 `D:\Documents\项目资料`），系统持续监听目录变化，新增/修改的文档自动解析、分块、建立索引，无需手动导入。
</details>

## 运行模式

| 模式 | 命令 | 适用场景 |
| --- | --- | --- |
| 桌面模式 | `npm run dev` / `npm run start:desktop` | Electron 完整形态，全部能力可用 |
| Web 模式 | `npm run dev:web` | 浏览器访问，适合局域网多设备共享 |
| MCP 模式 | `npm run mcp` | 作为 MCP Server 供外部 AI Agent 接入 |

## 项目结构

```
sd-knowledge/
├── electron/                  # 主进程
│   ├── main.ts                # 桌面模式入口
│   ├── webEntry.ts            # Web 模式入口
│   ├── mcpEntry.ts            # MCP Server 入口
│   └── services/              # 核心服务层
│       ├── database.ts        # SQLite 连接与版本化迁移
│       ├── searchService.ts   # RRF 混合检索
│       ├── answerService.ts   # 流式问答与引用溯源
│       ├── graphBuilder.ts    # 知识图谱构建
│       ├── processingEngine.ts# 文档解析流水线
│       ├── vectorIndex.ts     # 本地向量索引
│       ├── mcpServer.ts       # MCP 协议服务
│       ├── gateway/           # LLM 网关（密钥隔离）
│       ├── plugins/           # 插件体系（注册表/加载器/宿主）
│       └── workbench/         # 工作台服务
├── src/                       # 渲染进程（React）
│   ├── pages/                 # 问答 / 检索 / 图谱 / 文件 / 资源汇 / 设置
│   └── workbench/             # 工作台 UI
├── tests/                     # 集成测试与检索评测集
└── resources/                 # 图标等打包资源
```

## 文档

项目维护完整的设计文档体系，关键架构决策均有 ADR 记录：

| 文档 | 内容 |
| --- | --- |
| ADR-001 | FTS5 Trigram 中文全文检索方案 |
| ADR-002 | 作用域图谱与日闭环设计 |
| ADR-004 | LLM 接入策略与密钥隔离 |
| ADR-005 | 插件架构（注册表 / 加载器 / 宿主 / 内建插件） |

> 完整设计文档（特性设计、缺陷复盘、产品规划）目前随私有文档库维护，将逐步迁移至仓库 `docs/` 目录。

## 安全与隐私

- **本地优先**：全部业务数据存于本地 SQLite，无任何云端同步
- **密钥隔离**：LLM API Key 仅存储于主进程，渲染进程无法访问
- **错误分级**：后端接口统一错误分级，不向外部泄露 SQL、文件路径等敏感信息
- **出域闸门**：所有外发请求（LLM 调用、GitHub API）均有明确开关与审计日志
- **故障隔离**：插件加载失败仅隔离插件本身，宿主应用零影响

## 路线图

- [x] **S0** — 文档解析流水线 · RRF 混合检索 · 分块溯源
- [x] **S1** — LLM 网关 · 流式问答 · 引用溯源
- [x] **S2** — 插件架构 · 实体别名 · 审计保留 · 日程/分析聚合
- [ ] **S3** — 资源汇榜单每日自动更新 · 更多 LLM Provider · 本地模型支持
- [ ] **S4** — macOS / Linux 打包适配 · 设计文档全量开源

## 贡献指南

欢迎提交 Issue 与 Pull Request。提交 PR 前请确保：

1. `npm run typecheck` 类型检查通过
2. `npm test` 集成测试全部通过
3. 涉及检索逻辑的变更，运行 `npm run eval` 确认无基线回归
4. 提交信息遵循约定式提交（如 `feat:` / `fix:` / `docs:`）

## 许可证

本项目基于 [MIT License](./LICENSE) 开源，可自由用于个人与商业用途。

## 联系方式

- **Issue 反馈**：[GitHub Issues](https://github.com/gqallen931/sd-knowledge/issues)
- **讨论交流**：[GitHub Discussions](https://github.com/gqallen931/sd-knowledge/discussions)

---

<div align="center">

如果这个项目对你有帮助，欢迎点个 ⭐ Star 支持一下

</div>
