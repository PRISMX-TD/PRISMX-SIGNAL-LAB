// 记住用户上次自己设的下单手数，下次打开任一下单入口默认就是它（没有则 0.01）。
//
// 与 useLastAccount 同一套做法：走 usePrefs（按用户存后端、跨设备同步、WS 推送），
// localStorage 只是它的离线缓存，首帧就能读到。只在**用户主动设置**时写入——
// 输入后失焦 / ± 步进 / 快捷档 / 成功下单；风险百分比模式自动算出来的手数不写，
// 用户定的是"风险 1%"而不是那个数，把它记成默认会让下次手数模式莫名冒出个
// 0.37 手。写入前置：正数才存。
//
// Remembers the lots the user last set explicitly so every order entry point
// defaults to it (0.01 when nothing is remembered). Same mechanism as
// useLastAccount: usePrefs (server-side, per user, cross-device) with its
// localStorage cache for the first frame. Only explicit edits are recorded —
// risk-% auto-sizing never is, since the user chose a percentage, not that
// lot number.
import { useCallback } from 'react'
import { usePrefs } from '../store/prefs'

const NS = 'trade'
const KEY = 'lastVolume'

export function useLastVolume() {
  const { getPref, setPref } = usePrefs()
  const lastVolume = getPref<number | null>(NS, KEY, null)

  const rememberVolume = useCallback(
    (raw: string | number) => {
      const v = typeof raw === 'number' ? raw : parseFloat(raw)
      if (Number.isFinite(v) && v > 0) setPref(NS, KEY, v)
    },
    [setPref],
  )

  return { lastVolume, rememberVolume }
}
