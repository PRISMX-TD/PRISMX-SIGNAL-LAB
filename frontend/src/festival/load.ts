// 节日重包的唯一加载点 / the single loader for the heavy festival chunk
//
// 同一个 Promise 全站共用：Provider 预热、各个轻壳的 lazy() 都走这里，只发一次请求。
// 失败时清掉缓存，下一次（换页、重放）还能再试。
// One shared promise: the provider's warm-up and every shell's lazy() go through
// here, so there is only ever one request. A failure clears the cache so the
// next attempt (navigation, replay) can try again.
export type FestivalHeavy = typeof import('./heavy')

let pending: Promise<FestivalHeavy> | null = null

export function loadFestivalHeavy(): Promise<FestivalHeavy> {
  if (!pending) {
    pending = import('./heavy').catch((err) => {
      pending = null
      throw err
    })
  }
  return pending
}
