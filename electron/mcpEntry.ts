#!/usr/bin/env node
import { app } from 'electron'
import * as path from 'path'
import DatabaseService from './services/database'
import { FileService } from './services/fileService'
import { SearchService } from './services/searchService'
import { GraphBuilder } from './services/graphBuilder'
import { ProcessingEngine } from './services/processingEngine'
import { McpServerService } from './services/mcpServer'
import { LlmGateway } from './services/gateway/llmGateway'
import { LlmService } from './services/gateway/llmService'
import { AnswerService } from './services/answerService'
import { TaskRepository } from './services/workbench/taskRepository'
import { TaskService } from './services/workbench/taskService'
import { WorkbenchService } from './services/workbench/workbenchService'
import { initPerfLog } from './services/perfLogger'

async function runMcpServer() {
  const defaultBase = path.dirname(app.getPath('exe'))
  const drive = defaultBase.split(path.sep)[0] || 'C:'
  const sdRoot = path.join(drive + path.sep, 'SD')
  const dataDir = process.env.SD_DATA_PATH || path.join(app.getPath('userData'), 'Data')

  const fs = require('fs')
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
  initPerfLog(path.join(dataDir, 'logs'))

  const db = new DatabaseService(path.join(dataDir, 'sd.db'))
  await db.init()

  const fileService = new FileService(db, dataDir)
  const searchService = new SearchService(db)
  const graphBuilder = new GraphBuilder(db)
  const processingEngine = new ProcessingEngine(db, dataDir)
  searchService.setProcessingEngine(processingEngine)

  // 工作台域与内核域共用同一个 sd.db（ADR-003 决策 2），MCP 出口自然能同时触达两侧
  const workbenchDomains = {
    workbench: new WorkbenchService(db),
    tasks: new TaskService(new TaskRepository(db)),
  }

  // RAG 问答（S1-03）在 MCP 出口也要可用：装配 LLM 网关与问答服务（未配置模型时降级为纯检索）
  const llmGateway = new LlmGateway()
  const llmService = new LlmService(db, dataDir, llmGateway)
  const answerService = new AnswerService(searchService, llmService, row => db.logAgentQuery(row))

  const mcpServer = new McpServerService(db, fileService, searchService, graphBuilder, workbenchDomains, answerService)
  await mcpServer.start()
  // 退出前把向量索引快照落盘（ADR-002 P2）；'exit' 阶段只允许同步操作
  process.on('exit', () => processingEngine.flushIndexes())
}

app.whenReady().then(runMcpServer)
