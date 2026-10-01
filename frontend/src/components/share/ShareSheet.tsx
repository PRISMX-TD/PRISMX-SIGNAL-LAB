// 分享弹层的按需加载外壳：模板、导出与二维码渲染都在 ShareCardModal 的 chunk 里，点了分享才下载。
// Lazy shell for the share sheet: templates, export and QR rendering live in ShareCardModal's chunk,
// downloaded only when someone taps Share.
import { Suspense, lazy } from 'react'
import type { ComponentProps } from 'react'

const ShareCardModal = lazy(() => import('./ShareCardModal'))
export type ShareSpec = Omit<ComponentProps<typeof ShareCardModal>, 'onClose'>

export default function ShareSheet({ spec, onClose }: { spec: ShareSpec | null; onClose: () => void }) {
  if (!spec) return null
  return (
    <Suspense fallback={null}>
      <ShareCardModal {...spec} onClose={onClose} />
    </Suspense>
  )
}
