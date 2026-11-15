// 常驻的读屏播报区域 / always-mounted screen-reader live regions.
// 为什么常驻、为什么分 polite / assertive 两个：见 utils/announce.ts 顶部注释。
// Why they stay mounted, and why there are two: see the header of utils/announce.ts.
//
// portal 到 body，不留在 #root 里：模态弹窗（下单弹窗、确认框、图表页手机抽屉）都 portal 到
// body，打开期间 utils/dialogStack 会给 #root 加 aria-hidden（TalkBack 不认 aria-modal）。
// 播报区如果在 #root 里，弹窗开着时写进去的字一句都不会读，而下单回执、删除失败这类提示
// 恰恰是在弹窗开着的时候出现的。
// Portalled to body, outside #root: modal dialogs (order sheet, confirm modal, the charts
// page's mobile sheet) portal to body, and while one is open utils/dialogStack aria-hides
// #root (TalkBack ignores aria-modal). Regions inside #root would go silent exactly when an
// order receipt or a delete failure is announced, which is while such a dialog is open.
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { registerLiveRegion } from '../utils/announce'

export default function LiveRegions() {
  const politeRef = useRef<HTMLDivElement>(null)
  const assertiveRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    registerLiveRegion('polite', politeRef.current)
    registerLiveRegion('assertive', assertiveRef.current)
    return () => {
      registerLiveRegion('polite', null)
      registerLiveRegion('assertive', null)
    }
  }, [])
  return createPortal(
    <>
      <div ref={politeRef} className="sr-only" role="status" aria-live="polite" aria-atomic="true" />
      <div ref={assertiveRef} className="sr-only" role="alert" aria-live="assertive" aria-atomic="true" />
    </>,
    document.body,
  )
}
