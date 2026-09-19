import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * 构建结束后生成 dist/sw.js。
 *
 * 做成插件而不是写进 npm script 的 `&&` 后面，是因为直接跑 `vite build`
 * （跳过 npm script）同样会踩坑：emptyOutDir 会把上次的 dist/sw.js 删掉，
 * 于是服务器在发新文件、浏览器还在用旧 SW 和旧缓存——
 * 一个「看起来能跑但其实错位」的状态，很难查。
 * 挂在这里，任何一次 vite build 都会正确生成。
 */
function serviceWorkerPlugin(): Plugin {
  return {
    name: 'xxbj-build-service-worker',
    apply: 'build',
    async closeBundle() {
      // 动态 import：这个模块是 .mjs，不在 tsconfig.node.json 的 include 里，
      // 静态 import 会让 tsc 去为它找类型声明。
      const { buildServiceWorker } = await import('./scripts/build-sw.mjs')
      const result = await buildServiceWorker()
      this.info(
        `dist/sw.js: 预缓存 ${result.count} 项（核心 ${result.coreCount} 项），` +
          `跳过 ${result.skipped} 项，缓存名 xxbj-${result.buildHash}`,
      )
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorkerPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
