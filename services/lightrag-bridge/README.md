# SD LightRAG Bridge

这个目录是 **SD 的独立本地知识引擎运行位**，不是 LightRAG 源码副本。

## 原则

- SD 的 `Data/sd.db` 是业务真源，禁止让本服务直接写入；
- 服务只监听 `127.0.0.1:9621`；
- LightRAG 的图谱和向量数据是派生索引，可由 SD 重新构建；
- 当前 L0 仅完成 SD 侧适配器与健康检查。L1 才引入文档同步 API 和 Python 运行入口，避免未经模型/版本验证就写入用户资料。

## 依赖基线

`requirements.txt` 固定为 `lightrag-hku[api]==1.5.7`（Python 3.10+）。安装、模型下载和首次索引会在 L1 由 SD 的“知识引擎”设置向导执行；不应把 LightRAG 仓库克隆进本目录。

已配置 Conda 环境后，可用项目根目录的 `Start-LightRAG.cmd` 启动服务。它固定监听 `127.0.0.1:9621`，并为 Windows 控制台设置 UTF-8，避免 LightRAG 启动横幅在 GBK 环境中退出。启动前仍需准备本地模型端点。

## 健康契约

当服务在 L1 启动后，必须提供：

```json
GET /health
{ "status": "healthy", "version": "1.5.7", "model": "本地模型标识" }
```

SD 兼容官方的 `status: "healthy"` 和自建桥接的 `status: "ok"`；其他响应均安全降级到现有检索。
