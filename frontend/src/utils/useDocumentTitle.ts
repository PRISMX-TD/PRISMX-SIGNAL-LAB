import { useEffect } from 'react'

/** 记下当前标题，返回把它还原回去的函数。/ Remembers the current title; returns a restore fn. */
export function holdDocumentTitle(doc: { title: string } = document): () => void {
  const prev = doc.title
  return () => {
    doc.title = prev
  }
}

// 统一的 document.title 设置：此前三个登录后页面各自手写 effect，写法不一。
// 公开页（落地/法务/FAQ）不要用这个——它们的 title 由 seo/PublicShell 按
// seo/meta.ts 的每页元数据统一管理，两套来源并存会互相覆盖。
// restoreOnUnmount：卸载时还原进来之前的标题。给「下一页自己不设标题」的场景用
// （公开比赛页 → /login：不还原的话标签页一直挂着比赛名）。
// restoreOnUnmount: put back the title from before mount on unmount, for pages
// whose successors don't set their own (public competition page → /login).
export function useDocumentTitle(title: string, opts?: { restoreOnUnmount?: boolean }) {
  const restore = opts?.restoreOnUnmount ?? false
  // 必须声明在设标题的 effect 前面：同一次提交里 effect 按声明顺序执行，这样记下的才是
  // 进来之前的标题。/ Declared first so it captures the title from before this page.
  useEffect(() => (restore ? holdDocumentTitle() : undefined), [restore])
  useEffect(() => {
    document.title = title
  }, [title])
}
