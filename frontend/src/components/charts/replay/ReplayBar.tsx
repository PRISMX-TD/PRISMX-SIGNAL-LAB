// 回放控制条（浮在图表底部正中）：重选起点 · 播放 / 暂停 · 前进一根 · 速度 · 当前时间 · 回到实时。
// 键盘：Shift+→ 前进一根，Shift+↓ 播放 / 暂停（捕获阶段先处理并 preventDefault，useChartHotkeys 看到
// defaultPrevented 就不再滚动 / 缩放）。提示（起点被夹到最早、没数据、到头了）在控制条上方冒一下。
// 390px 宽的手机也放得下：窄屏把时间缩成两行小字、速度只显示倍数。
// Replay controls (floating, bottom centre): re-pick start · play / pause · forward one bar ·
// speed · current time · back to real-time. Keys: Shift+→ steps, Shift+↓ plays / pauses (handled in
// the capture phase with preventDefault, so useChartHotkeys sees defaultPrevented and doesn't
// scroll / zoom). Hints (start clamped to the earliest bar, no data, reached the end) pop above
// the bar. Fits a 390px phone: narrow screens shrink the time to two small lines and the speed to
// its multiplier.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReplayApi } from '../useChartData'
import { REPLAY_SPEEDS } from './replayModel'
import { Ico, RI } from './icons'
import './replay.css'

function inTextField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

const HINT_MS = 4500

export default function ReplayBar({ replay, fmtTime, scopeRef }: {
  replay: ReplayApi
  // 图表时区的时间格式（timeFmt.crosshair）/ time formatter in the chart timezone (timeFmt.crosshair)
  fmtTime: (t: number) => string
  // 只有焦点在这里面时才响应快捷键（多图布局每格一个）/ hotkeys only while focus is inside (one per chart cell)
  scopeRef?: { current: HTMLElement | null }
}) {
  const { t } = useTranslation()
  const [speedOpen, setSpeedOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const r = useRef(replay)
  r.current = replay

  // 快捷键 / hotkeys
  useEffect(() => {
    if (!replay.active) return
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || inTextField(e.target)) return
      const scope = scopeRef?.current
      if (scope && !(document.activeElement && scope.contains(document.activeElement))) return
      if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); r.current.pause(); r.current.step() }
      else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); r.current.toggle() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [replay.active, scopeRef])

  // 提示自动消失 / hints dismiss themselves
  const hintId = replay.hint?.id
  useEffect(() => {
    if (hintId == null) return
    const id = window.setTimeout(() => r.current.dismissHint(), HINT_MS)
    return () => window.clearTimeout(id)
  }, [hintId])

  // 速度菜单点外面关 / close the speed menu on an outside press
  useEffect(() => {
    if (!speedOpen) return
    const onDown = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) setSpeedOpen(false) }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [speedOpen])

  if (!replay.active && !(replay.loading && !replay.selecting) && !replay.hint) return null
  const hint = replay.hint
  const hintText = hint
    ? String(t(`charts.replay.hint.${hint.kind}`, { date: hint.t != null ? fmtTime(hint.t) : '' }))
    : ''
  const when = replay.cursorTime != null ? fmtTime(replay.cursorTime) : ''
  const fmtSpeed = (x: number) => `${x}×`

  return (
    <div ref={rootRef} className={`rp-bar ${!replay.active && !replay.loading ? 'bare' : ''}`} role="toolbar" aria-label={String(t('charts.replay.title'))}>
      {hint && <div className={`rp-hint ${hint.kind === 'failed' || hint.kind === 'noData' ? 'bad' : ''}`} role="status">{hintText}</div>}
      {replay.active && (
        <>
          <button type="button" className="rp-btn" onClick={() => replay.beginSelect()} title={String(t('charts.replay.reselect'))} aria-label={String(t('charts.replay.reselect'))}>
            <Ico>{RI.cut}</Ico>
          </button>
          <button type="button" className="rp-btn main" onClick={() => replay.toggle()} disabled={replay.atEnd}
            title={`${t(replay.playing ? 'charts.replay.pause' : 'charts.replay.play')} (Shift+↓)`} aria-label={String(t(replay.playing ? 'charts.replay.pause' : 'charts.replay.play'))}>
            <Ico>{replay.playing ? RI.pause : RI.play}</Ico>
          </button>
          <button type="button" className="rp-btn" onClick={() => { replay.pause(); replay.step() }} disabled={replay.atEnd}
            title={`${t('charts.replay.step')} (Shift+→)`} aria-label={String(t('charts.replay.step'))}>
            <Ico>{RI.step}</Ico>
          </button>
          <div className="rp-speed">
            <button type="button" className="rp-btn txt" aria-haspopup="menu" aria-expanded={speedOpen} onClick={() => setSpeedOpen((v) => !v)}
              title={String(t('charts.replay.speed'))} aria-label={`${t('charts.replay.speed')} ${fmtSpeed(replay.speed)}`}>
              {fmtSpeed(replay.speed)}
            </button>
            {speedOpen && (
              <div className="rp-menu" role="menu">
                {[...REPLAY_SPEEDS].reverse().map((x) => (
                  <button key={x} type="button" role="menuitemradio" aria-checked={x === replay.speed} className={x === replay.speed ? 'on' : ''}
                    onClick={() => { replay.setSpeed(x); setSpeedOpen(false) }}>
                    {fmtSpeed(x)}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="rp-when" aria-live="off" title={when}>
            {replay.loading ? <span className="rp-spin" aria-label={String(t('charts.replay.loading'))} /> : null}
            {when}
          </span>
        </>
      )}
      {!replay.active && replay.loading && (
        <span className="rp-when"><span className="rp-spin" />{t('charts.replay.loading')}</span>
      )}
      {replay.active && (
        <button type="button" className="rp-btn exit" onClick={() => replay.exit()} title={String(t('charts.replay.exit'))} aria-label={String(t('charts.replay.exit'))}>
          <Ico>{RI.realtime}</Ico>
        </button>
      )}
    </div>
  )
}

// 顶栏上的「回放」按钮：没在回放 → 进入选起点；正在选 → 取消；正在回放 → 退出。
// The top-bar Replay button: idle → pick a start; picking → cancel; replaying → exit.
export function ReplayButton({ replay, className = '', showLabel = false, disabled = false }: {
  replay: ReplayApi
  className?: string
  showLabel?: boolean
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const on = replay.active || replay.selecting
  const label = String(t(replay.active ? 'charts.replay.exitTip' : 'charts.replay.start'))
  return (
    <button type="button" className={`${className} ${on ? 'on' : ''}`} aria-pressed={on} title={label} aria-label={label} disabled={disabled}
      onClick={() => {
        if (replay.active) replay.exit()
        else if (replay.selecting) replay.cancelSelect()
        else replay.beginSelect()
      }}>
      <Ico>{RI.replay}</Ico>
      {showLabel && <span>{t('charts.replay.start')}</span>}
    </button>
  )
}
