import { useEffect } from 'react'

// 统一的 document.title 设置：此前三个登录后页面各自手写 effect，写法不一。
// 公开页（落地/法务/FAQ）不要用这个——它们的 title 由 seo/PublicShell 按
// seo/meta.ts 的每页元数据统一管理，两套来源并存会互相覆盖。
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title
  }, [title])
}
