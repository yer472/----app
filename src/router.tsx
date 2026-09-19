import { lazy } from 'react'
import { createBrowserRouter } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout'
import { ChapterPage } from '@/pages/ChapterPage'
import { DevDbCheckPage } from '@/pages/DevDbCheckPage'
import { NotFoundPage } from '@/pages/NotFoundPage'
import { SearchPage } from '@/pages/SearchPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { SubjectListPage } from '@/pages/SubjectListPage'
import { SubjectPage } from '@/pages/SubjectPage'

/**
 * 笔记页按需加载。
 *
 * Milkdown 连同 CodeMirror、KaTeX 等依赖有 1.5MB 左右，
 * 而「翻科目列表」这类操作根本用不到编辑器。拆出去之后，
 * 首屏只加载轻量的列表页，打开笔记时再拉编辑器——
 * 对本地应用来说这点延迟无所谓，但首屏快慢是能直接感觉到的。
 */
const NotePage = lazy(() =>
  import('@/pages/NotePage').then((m) => ({ default: m.NotePage })),
)

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      { index: true, element: <SubjectListPage /> },
      { path: 'subjects/:subjectId', element: <SubjectPage /> },
      {
        path: 'subjects/:subjectId/chapters/:chapterId',
        element: <ChapterPage />,
      },
      {
        path: 'subjects/:subjectId/chapters/:chapterId/notes/:noteId',
        element: <NotePage />,
      },
      { path: 'search', element: <SearchPage /> },
      { path: 'settings', element: <SettingsPage /> },
      // 开发期的自检页。等功能稳定后可以删掉
      { path: 'dev/db-check', element: <DevDbCheckPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
])
