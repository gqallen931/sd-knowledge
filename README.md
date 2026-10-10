# SD Knowledge

> 面向 AI Agent 的本地知识中枢 —— 集知识库、知识图谱、混合检索、流式问答与项目工作台于一体的桌面应用

<p>
  <img src="https://img.shields.io/badge/Electron-30-47848F?logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/SQLite-FTS5-003B57?logo=sqlite&logoColor=white" alt="SQLite" />
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License" />
</p>

---

## 简介

SD Knowledge 是一款**本地优先（Local-First）**的知识管理软件。它将本地文档解析为可检索、可溯源的知识资产，通过 FTS5 全文检索 + 向量检索的 RRF 混合排序提供精准检索，并可接入 LLM 实现带引用出处的流式问答。同时内置项目工作台、知识图谱可视化与 MCP Server，让 AI Agent 能够直接读写你的知识库。

所有数据存储于本地 SQLite，不依赖任何云服务；LLM 密钥仅保存在主进程，不上传、不暴露给渲染进程。

## 核心特性

### 知识库与检索
- **多格式文档解析**：PDF、Word、Excel、图片（OCR + EXIF）、视频（关键帧抽取）等，统一分块入库
- **混合检索**：FTS5 全文检索（trigram 分词，支持中文）+ 本地向量检索，RRF 融合排序
- **分块溯源**：检索/问答结果可回查到原文档的具体分块与位置锚点（页码、时间戳）
- **文件夹映射**：监听本地目录，增量同步入库，支持目录树与跨项目桥接

### AI 问答与 Agent 接入
- **流式问答**：基于 SSE 的流式输出，引用面板实时展示出处，未配置 LLM 时自动降级为纯检索页
- **LLM 网关**：支持 OpenAI 兼容端点（DeepSeek 等），密钥仅存主进程
- **MCP Server**：内置 Model Context Protocol 服务，AI Agent 可通过标准协议检索、读写知识库
- **检索评测**：内置评测集与基线回归（`npm run eval`），保障检索质量可度量

### 知识图谱
- 自动从文档中抽取实体与关系，构建知识图谱
- ECharts 可视化交互图谱，支持图谱编辑、实体合并建议与别名管理

### 项目工作台
- 项目、任务分组、甘特图、日程与分析看板
- 资源汇：GitHub 多领域 Star 榜单每日快照、开源项目卡片式管理
- 统一搜索入口，跨知识库与工作台数据

### 插件架构
- 遵循 ADR-005 的四层插件体系：注册表 / 加载器 / 宿主 / 内建插件
- 「吃自己的狗粮」原则：内建功能均通过插件路径实现
- 插件通过 `manifest.json` 声明 apiVersion 与权限，加载失败自动隔离，不影响宿主

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面壳 | Electron 30（主进程 / 预加载 / 渲染进程隔离） |
| 前端 | React 18、TypeScript、Vite、Tailwind CSS、ECharts |
| 后端 | Node.js、Express（Web 模式 API） |
| 数据库 | better-sqlite3（FTS5、WAL、迁移体系） |
| AI / NLP | @xenova/transformers（本地向量）、nodejieba、compromise |
| 文档解析 | pdfjs-dist、mammoth、xlsx/exceljs、tesseract.js、fluent-ffmpeg |
| Agent 接入 | @modelcontextprotocol/sdk |

## 快速开始

### 环境要求
- Node.js ≥ 18
- Windows（当前主要支持平台，NSIS 打包）

### 安装与开发

```bash
# 安装依赖
npm install

# 重建原生模块（better-sqlite3）
npm run rebuild

# 桌面模式开发（Vite + Electron 热更新）
npm run dev

# Web 模式开发（浏览器访问，API 端口 5174）
npm run dev:web
```

### 构建与打包

```bash
# 类型检查 + 前端构建
npm run build

# 打包 Windows 安装包（输出至 release/）
npm run package:win
```

### 测试与质量

```bash
# 类型检查 + 集成测试 + 认证流程测试
npm test

# 检索质量评测
npm run eval

# 性能报告
npm run perf:report
```

## 运行模式

| 模式 | 命令 | 说明 |
| --- | --- | --- |
| 桌面模式 | `npm run dev` / `npm start:desktop` | Electron 完整形态，全部能力可用 |
| Web 模式 | `npm run dev:web` | 浏览器访问，适合局域网内多设备使用 |
| MCP 模式 | `npm run mcp` | 以 MCP Server 形态启动，供外部 AI Agent 接入 |

## 项目结构

```
sd-knowledge/
├── electron/               # 主进程
│   ├── main.ts             # 桌面入口
│   ├── webEntry.ts         # Web 模式入口
│   ├── mcpEntry.ts         # MCP Server 入口
│   └── services/           # 核心服务
│       ├── database.ts     # SQLite 连接与迁移
│       ├── searchService.ts    # RRF 混合检索
│       ├── answerService.ts    # 流式问答与引用溯源
│       ├── graphBuilder.ts     # 知识图谱构建
│       ├── processingEngine.ts # 文档解析流水线
│       ├── vectorIndex.ts      # 向量索引
│       ├── mcpServer.ts        # MCP 协议服务
│       ├── gateway/            # LLM 网关
│       ├── plugins/            # 插件体系（注册表/加载器/宿主）
│       └── workbench/          # 工作台服务
├── src/                    # 渲染进程（React）
│   ├── pages/              # 问答 / 检索 / 图谱 / 文件 / 资源汇 / 设置等页面
│   └── workbench/          # 工作台 UI
├── tests/                  # 集成测试与检索评测
└── resources/              # 图标等打包资源
```

## 设计文档

仓库维护有完整的设计文档体系（ADR 架构决策记录、特性设计、缺陷复盘），包括：

- **ADR-001** FTS5 Trigram 中文全文检索
- **ADR-002** 作用域图谱与日闭环
- **ADR-004** LLM 接入策略
- **ADR-005** 插件架构（注册表 / 加载器 / 宿主 / 内建插件）

## 安全与隐私

- **本地优先**：全部业务数据存于本地 SQLite，无云端同步
- **密钥隔离**：LLM API Key 仅存储于主进程，渲染进程无法访问
- **错误分级**：后端接口统一错误分级，不向外部泄露 SQL、文件路径等敏感信息
- **出域闸门**：任何外发请求（LLM 调用、GitHub API）均有明确开关与审计日志

## 路线图

- [x] S0：文档解析流水线 + RRF 混合检索 + 分块溯源
- [x] S1：LLM 网关 + 流式问答 + 引用溯源
- [x] S2：插件架构、实体别名、审计保留、日程/分析聚合
- [ ] 资源汇榜单每日自动更新（定时任务）
- [ ] 更多 LLM Provider 与本地模型支持
- [ ] macOS / Linux 打包适配

## 贡献

欢迎提交 Issue 与 Pull Request。提交前请确保：

1. `npm run typecheck` 通过
2. `npm test` 全部通过
3. 涉及检索逻辑变更时运行 `npm run eval` 确认无基线回归

## 许可证

[MIT](./LICENSE)
