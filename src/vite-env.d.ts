/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 开发态后端直连地址（vite.config 注入）：SSE 绕开 Vite 代理，避免 Chromium 记 net::ERR_ABORTED */
  readonly VITE_RPC_ORIGIN?: string
}
