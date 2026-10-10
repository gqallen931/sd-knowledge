import { contextBridge, ipcRenderer } from 'electron'

const api = {
  file: {
    import: (paths: string[]) => ipcRenderer.invoke('file:import', paths),
    reference: (paths: string[]) => ipcRenderer.invoke('file:reference', paths),
    list: (filters: any) => ipcRenderer.invoke('file:list', filters),
    detail: (id: number) => ipcRenderer.invoke('file:detail', id),
    delete: (id: number) => ipcRenderer.invoke('file:delete', id),
    process: (id: number) => ipcRenderer.invoke('file:process', id),
    select: () => ipcRenderer.invoke('file:select'),
    selectFolder: () => ipcRenderer.invoke('folder:select'),
  },
  search: {
    fulltext: (query: string, filters?: any) => ipcRenderer.invoke('search:fulltext', query, filters),
    semantic: (query: string, options?: any) => ipcRenderer.invoke('search:semantic', query, options),
  },
  graph: {
    nodes: (filters?: any) => ipcRenderer.invoke('graph:nodes', filters),
    edges: (filters?: any) => ipcRenderer.invoke('graph:edges', filters),
    overview: () => ipcRenderer.invoke('graph:overview'),
    bridges: (options?: { limit?: number; source_id?: number | null }) => ipcRenderer.invoke('graph:bridges', options),
    entities: (options?: any) => ipcRenderer.invoke('graph:entities', options),
    entity: (name: string) => ipcRenderer.invoke('graph:entity', name),
    stats: () => ipcRenderer.invoke('graph:stats'),
    addRelationship: (sourceType: string, sourceId: number, targetType: string, targetId: number, relationType: string) =>
      ipcRenderer.invoke('graph:addRelationship', sourceType, sourceId, targetType, targetId, relationType),
    deleteRelationship: (id: number) => ipcRenderer.invoke('graph:deleteRelationship', id),
    mergeEntities: (sourceId: number, targetId: number) => ipcRenderer.invoke('graph:mergeEntities', sourceId, targetId),
    mergeEntitiesBatch: (sourceIds: number[], targetId: number) => ipcRenderer.invoke('graph:mergeEntitiesBatch', sourceIds, targetId),
    renameEntity: (id: number, name: string, type?: string) => ipcRenderer.invoke('graph:renameEntity', id, name, type),
    batchRenameEntities: (items: Array<{ id: number; name: string; type?: string }>) => ipcRenderer.invoke('graph:batchRenameEntities', items),
    searchNodes: (query: string, limit?: number) => ipcRenderer.invoke('graph:searchNodes', query, limit),
    searchEntities: (query: string, limit?: number) => ipcRenderer.invoke('graph:searchEntities', query, limit),
    suggestEntityMerges: (options?: { limit?: number; minScore?: number; type?: string }) => ipcRenderer.invoke('graph:suggestEntityMerges', options),
    listAliases: (entityId?: number) => ipcRenderer.invoke('graph:listAliases', entityId),
    addAlias: (entityId: number, alias: string) => ipcRenderer.invoke('graph:addAlias', entityId, alias),
    removeAlias: (id: number) => ipcRenderer.invoke('graph:removeAlias', id),
    listMergeHistory: (limit?: number) => ipcRenderer.invoke('graph:listMergeHistory', limit),
    ignoreMergeSuggestion: (nameA: string, nameB: string) => ipcRenderer.invoke('graph:ignoreMergeSuggestion', nameA, nameB),
    listIgnoredMergePairs: () => ipcRenderer.invoke('graph:listIgnoredMergePairs'),
  },
  dashboard: {
    stats: () => ipcRenderer.invoke('dashboard:stats'),
    recent: () => ipcRenderer.invoke('dashboard:recent'),
  },
  folder: {
    select: () => ipcRenderer.invoke('folder:select'),
    preview: (rootPath: string, options?: any) => ipcRenderer.invoke('folder:preview', rootPath, options),
    create: (payload: any) => ipcRenderer.invoke('folder:create', payload),
    list: () => ipcRenderer.invoke('folder:list'),
    update: (id: number, patch: any) => ipcRenderer.invoke('folder:update', id, patch),
    remove: (id: number, deleteDocuments = false) => ipcRenderer.invoke('folder:remove', id, deleteDocuments),
    sync: (id: number) => ipcRenderer.invoke('folder:sync', id),
    syncAll: () => ipcRenderer.invoke('folder:syncAll'),
    cleanup: (id?: number) => ipcRenderer.invoke('folder:cleanup', id),
    listFolders: (sourceId?: number) => ipcRenderer.invoke('folder:listFolders', sourceId),
  },
  queue: {
    status: () => ipcRenderer.invoke('queue:status'),
  },
  project: {
    list: () => ipcRenderer.invoke('project:list'),
    create: (name: string, description: string, color: string) => ipcRenderer.invoke('project:create', name, description, color),
    update: (id: number, name: string, description: string, color: string) => ipcRenderer.invoke('project:update', id, name, description, color),
    remove: (id: number) => ipcRenderer.invoke('project:delete', id),
    assign: (documentId: number, projectId: number | null) => ipcRenderer.invoke('project:assign', documentId, projectId),
    assignMany: (documentIds: number[], projectId: number | null) => ipcRenderer.invoke('project:assignMany', documentIds, projectId),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (settings: any) => ipcRenderer.invoke('settings:update', settings),
  },
  security: {
    status: () => ipcRenderer.invoke('security:status'),
    setup: (password: string) => ipcRenderer.invoke('security:setup', password),
    verify: (password: string) => ipcRenderer.invoke('security:verify', password),
    apiKeys: {
      list: () => ipcRenderer.invoke('security:apikey:list'),
      create: (name: string, role: string) => ipcRenderer.invoke('security:apikey:create', name, role),
      revoke: (id: number) => ipcRenderer.invoke('security:apikey:revoke', id),
    },
  },
  audit: {
    list: (filters?: any) => ipcRenderer.invoke('audit:list', filters),
    retentionGet: () => ipcRenderer.invoke('audit:retentionGet'),
    retentionSet: (days: number) => ipcRenderer.invoke('audit:retentionSet', days),
    prune: () => ipcRenderer.invoke('audit:prune'),
  },
  analytics: {
    overview: (options?: { days?: number }) => ipcRenderer.invoke('analytics:overview', options),
  },
  share: {
    exportSnapshot: () => ipcRenderer.invoke('share:exportSnapshot'),
  },
  shell: {
    openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),
    showInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
  },
  // 工作台域：单一通道转发 `组.方法`，前端用 Proxy 生成各分组门面（见 src/api.ts）。
  // 命名带双下划线，避免与门面里的 workbench / task 等分组键冲突。
  __workbenchRpc: (method: string, ...args: any[]) => ipcRenderer.invoke('workbench:rpc', method, args),
  // 问答流式（S1-05）：每块增量经 `chat:stream:chunk` 事件推给渲染进程，最终结果由本次 invoke 返回。
  // 取消走 `askStreamCancel`（对应主进程 AbortController）。
  askStream: (requestId: string, payload: any, onChunk: (chunk: string) => void) => {
    const listener = (_event: unknown, message: { requestId?: string; chunk?: string }) => {
      if (message?.requestId === requestId) onChunk(String(message.chunk ?? ''))
    }
    ipcRenderer.on('chat:stream:chunk', listener)
    return ipcRenderer.invoke('chat:askStream', requestId, payload)
      .finally(() => { ipcRenderer.removeListener('chat:stream:chunk', listener) })
  },
  askStreamCancel: (requestId: string) => ipcRenderer.invoke('chat:askStreamCancel', requestId),
  on: (channel: string, callback: (...args: any[]) => void) => {
    ipcRenderer.on(channel, (_event, ...args) => callback(...args))
  },
}

contextBridge.exposeInMainWorld('sd', api)

export type SDAPI = typeof api
