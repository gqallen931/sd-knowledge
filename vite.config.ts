import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// 仅在需要构建 Electron 时加载插件
// 浏览器开发模式下禁用，避免沙箱环境中 Electron 相关路径访问问题
const useElectron = process.env.VITE_ELECTRON === 'true'

// 浏览器开发模式下把 /local/* 反向代理到 webEntry 后端，从而获得 Vite HMR
const webRpcPort = process.env.SD_WEB_RPC_PORT || '5174'

let electronPlugin: any = null
if (useElectron) {
  const electron = require('vite-plugin-electron/simple')
  electronPlugin = electron.default({
    main: {
      entry: 'electron/main.ts',
      vite: {
        build: {
          outDir: 'dist-electron',
          rollupOptions: {
            external: [
              'better-sqlite3', 'express', 'cors', 'ws', 'mammoth', 'exceljs',
              'pdfjs-dist', 'tesseract.js', 'fluent-ffmpeg', 'nodejieba',
              'compromise', 'multer', 'express-rate-limit', 'bcryptjs',
              'jsonwebtoken', 'uuid', 'chalk', '@xenova/transformers',
              '@modelcontextprotocol/sdk', 'jszip', 'exifr', 'marked',
              'fs', 'path', 'os', 'child_process', 'crypto', 'stream',
              'util', 'events', 'url', 'http', 'https', 'net'
            ]
          }
        }
      }
    },
    preload: {
      input: 'electron/preload.ts',
      vite: {
        build: {
          outDir: 'dist-electron'
        }
      }
    }
  })
}

// 开发/构建共用：把后端直连地址注入 import.meta.env（VITE_ 前缀才会暴露给前端代码）。
// SSE 经 Vite 代理即使完整收完，Chromium 也会记 net::ERR_ABORTED，故开发态直连后端端口绕开代理。
process.env.VITE_RPC_ORIGIN ||= `http://127.0.0.1:${process.env.SD_WEB_RPC_PORT || 5174}`

export default defineConfig({
  plugins: [
    react(),
    ...(electronPlugin ? [electronPlugin] : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    proxy: useElectron ? undefined : {
      '/local': { target: `http://127.0.0.1:${webRpcPort}` }
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
})
