// 成交提示音：本品种有单子成交（开仓、平仓、挂单触发后报回的成交）时响一声短促的「叮」。
// 只认第一次看到它变成 FILLED 的那一刻；页面刚打开时已经是 FILLED 的历史订单不响。
// 用 WebAudio 现合成，不加载音频文件。设置里默认关。
// A fill chime: a short ding when an order on this symbol fills. Only the moment an order is
// first seen as FILLED counts; orders already filled when the page opened stay silent.
// Synthesised with WebAudio, no audio file. Off by default in the settings.
import { useEffect, useRef } from 'react'
import type { Order } from '../../../api/types'
import { baseSymbol } from '../../../api/utils'

let ctx: AudioContext | null = null

export function playChime(up = true) {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    ctx = ctx ?? new AC()
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(up ? 880 : 660, now)
    osc.frequency.exponentialRampToValueAtTime(up ? 1320 : 990, now + 0.09)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28)
    osc.connect(gain).connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.3)
  } catch { /* 浏览器不让出声（没有用户手势等）就算了 / the browser refused; stay quiet */ }
}

export function useFillSound(orders: readonly Order[], symbol: string, on: boolean) {
  const seen = useRef<Set<string> | null>(null)
  useEffect(() => {
    const filled = orders.filter((o) => o.status === 'FILLED')
    if (seen.current == null) {
      seen.current = new Set(filled.map((o) => o.id))
      return
    }
    const base = baseSymbol(symbol)
    let fresh: Order | null = null
    for (const o of filled) {
      if (seen.current.has(o.id)) continue
      seen.current.add(o.id)
      if (baseSymbol(o.symbol) === base && (o.action ?? 'ORDER') !== 'MODIFY' && o.action !== 'MODIFY_PENDING') fresh = o
    }
    if (fresh && on) playChime(fresh.side === 'BUY')
  }, [orders, symbol, on])
}
