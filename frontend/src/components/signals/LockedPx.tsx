// 游客预览里被锁住的价位：一串磨砂的数字 + 锁。
//
// 数字是**随机的**，只借用该品种当前报价的位数与小数位，让磨砂底下看起来像一个真价格。
// 真实价位从来没有发到浏览器（服务端把 entry/stopLoss/takeProfit 置空），所以 F12
// 看到的也只是这串随机数。按 seed 固定，避免每次重渲染都换一串、在磨砂底下闪。
// A locked price in the guest preview: frosted digits plus a lock. The digits are random,
// borrowing only the digit count and decimals of the symbol's live quote so the frost looks
// like a real price. The real level never reaches the browser (the server nulls the prices),
// so devtools show nothing but this noise. Seeded so re-renders don't reshuffle it.
import { memo, type FC } from 'react'
import { useTranslation } from 'react-i18next'
import { useGlobalQuote } from '../../store/live'

function seeded(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507)
    h = Math.imul(h ^ (h >>> 13), 3266489909)
    return ((h ^= h >>> 16) >>> 0) / 4294967296
  }
}

const LockedPx: FC<{ symbol: string; seed: string }> = ({ symbol, seed }) => {
  const { t } = useTranslation()
  const q = useGlobalQuote(symbol)
  const digits = q?.digits ?? 2
  const shape = q?.bid != null ? q.bid.toFixed(digits) : '0000.00'
  const rnd = seeded(seed)
  const fake = shape.replace(/\d/g, (_, i: number) => String(i === 0 ? 1 + Math.floor(rnd() * 9) : Math.floor(rnd() * 10)))
  return (
    <span className="px-locked" title={t('guest.lockedPrice')} aria-label={t('guest.lockedPrice')}>
      <span className="px-locked-blur" aria-hidden>{fake}</span>
      <svg className="px-locked-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </svg>
    </span>
  )
}

export default memo(LockedPx)

export const LockIcon: FC<{ size?: number }> = ({ size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
)
