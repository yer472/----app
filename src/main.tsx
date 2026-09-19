import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { registerServiceWorker } from './pwa/register'
import { router } from './router'
import './index.css'

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 容器')

createRoot(container).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)

// 注册不阻塞首屏：预缓存在 SW 线程里跑，主线程该画什么画什么。
registerServiceWorker()
