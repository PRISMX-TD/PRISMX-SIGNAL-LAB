// 画线工具：图标 + 单行横条（手机报价条第二行、全屏）。桌面左侧竖轨 2026-11-26 起两套外壳都用
// pro/ProDrawRail，这里只剩横条。
// (The desktop rail moved to pro/ProDrawRail for both shells on 2026-11-26; only the strip remains.)
// 2026-11-25（阶段 2）起工具按组排：每组一个按钮，显示该组上次用的工具，点小三角（或再点一次已选中的
// 按钮）弹出组内全部工具；列表里的星标把工具加进收藏栏。
// Draw tools: icons plus two layouts. rail = the desktop chart's left rail; strip = the phone's
// single-line bar. Since 2026-11-25 (phase 2) tools are grouped: one button per group showing the
// group's last-used tool; the corner chevron (or clicking the active button again) opens the whole
// group, and the star in that list adds a tool to the favourites bar.
import { Fragment, useRef, useState, type RefObject } from 'react'
import type { DrawLayerHandle } from './DrawLayer'
import { type Tool, TOOL_GROUPS, TOOL_HOTKEYS, COLORS } from './draw/model'
import { DrawToolIcon } from './draw/DrawToolIcon'
import { IcRuler, IcMagnet, IcStay, IcLock, IcEye, IcTree, IcTrash } from './draw/railIcons'
import ChartPopover from './ChartPopover'
import { usePrefs } from '../../store/prefs'
import { CHART_PREFS_NS } from './useChartPrefs'
import { useOverflowHint } from '../../utils/useOverflowHint'

// 图标 2026-11-26 起在 draw/DrawToolIcon（28 格细线 + 空心端点）；这里转出，旧的引用不用改
// Icons live in draw/DrawToolIcon since 2026-11-26 (28 grid, hollow anchors); re-exported for existing imports
export { DrawToolIcon }

// 快捷键提示文字 / shortcut hint text
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
const ALT = isMac ? '⌥' : 'Alt+'
export function toolKeyHint(tl: Tool): string {
  const k = TOOL_HOTKEYS[tl]
  if (!k) return ''
  return `${ALT}${k.shift ? '⇧' : ''}${k.code.replace('Key', '')}`
}

const CHEVRON = <svg width="6" height="6" viewBox="0 0 6 6" aria-hidden><path d="M6 0v6H0z" fill="currentColor" /></svg>

// 分组按钮（竖轨、手机横条、全屏悬浮栏共用）/ group buttons (rail, phone strip, fullscreen bar)
export function DrawToolGroups({ drawLayerRef, bumpDraw, t, compact = false }: {
  drawLayerRef: RefObject<DrawLayerHandle>
  bumpDraw: () => void
  t: (key: string) => unknown
  compact?: boolean
}) {
  const { getPref, setPref } = usePrefs()
  const last = getPref<Record<string, Tool>>(CHART_PREFS_NS, 'drawGroupLast', {}) || {}
  const [open, setOpen] = useState<string | null>(null)
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const dl = drawLayerRef.current
  const cur = dl?.tool ?? 'cursor'
  const favs = dl?.favorites ?? []
  const pick = (gid: string, tl: Tool) => {
    drawLayerRef.current?.setTool(tl)
    if (last[gid] !== tl) setPref(CHART_PREFS_NS, 'drawGroupLast', { ...last, [gid]: tl })
    setOpen(null)
    bumpDraw()
  }
  return (
    <>
      {TOOL_GROUPS.map((g) => {
        const active = g.tools.includes(cur)
        const shown: Tool = active ? cur : (last[g.id] && g.tools.includes(last[g.id]) ? last[g.id] : g.tools[0])
        const hint = toolKeyHint(shown)
        return (
          <span key={g.id} className={`term-tool-grp ${compact ? 'compact' : ''}`}>
            <button
              ref={(el) => { refs.current[g.id] = el }}
              type="button"
              title={`${String(t(`charts.draw.${shown}`))}${hint ? ` (${hint})` : ''}`}
              aria-label={String(t(`charts.draw.${shown}`))}
              aria-pressed={active}
              aria-haspopup="dialog"
              onClick={() => { if (active && cur === shown) setOpen(open === g.id ? null : g.id); else pick(g.id, shown) }}
              className={`term-tool-btn ${active ? 'on' : ''}`}
            >
              <DrawToolIcon tool={shown} />
            </button>
            <button type="button" className="term-tool-more" aria-label={String(t(`charts.draw.grp_${g.id}`))} title={String(t(`charts.draw.grp_${g.id}`))} onClick={() => setOpen(open === g.id ? null : g.id)}>{CHEVRON}</button>
            <ChartPopover open={open === g.id} onClose={() => setOpen(null)} anchorRef={{ current: refs.current[g.id] }} width={248} label={String(t(`charts.draw.grp_${g.id}`))}>
              <div className="chart-iv-grp">
                <b>{String(t(`charts.draw.grp_${g.id}`))}</b>
              </div>
              {g.tools.map((tl) => (<Fragment key={tl}>
                {g.secs?.[tl] &&<div className="chart-pop-sec">{String(t(`charts.draw.sec_${g.secs[tl]}`))}</div>}
                <div className={`chart-pop-row ${cur === tl ? 'on' : ''}`}>
                  <button type="button" className="chart-pop-item" onClick={() => pick(g.id, tl)}>
                    <DrawToolIcon tool={tl} /><span>{String(t(`charts.draw.${tl}`))}</span>{toolKeyHint(tl) && <small>{toolKeyHint(tl)}</small>}
                  </button>
                  <button type="button" className={`chart-pop-star ${favs.includes(tl) ? 'on' : ''}`} aria-pressed={favs.includes(tl)}
                    aria-label={String(t(favs.includes(tl) ? 'charts.draw.unfav' : 'charts.draw.fav'))}
                    onClick={() => { drawLayerRef.current?.toggleFavorite(tl); bumpDraw() }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill={favs.includes(tl) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden><path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z" /></svg>
                  </button>
                </div>
              </Fragment>))}
            </ChartPopover>
          </span>
        )
      })}
    </>
  )
}

export default function DrawToolsRow({
  drawLayerRef,
  bumpDraw,
  t,
  measureOn,
  onMeasure,
}: {
  drawLayerRef: RefObject<DrawLayerHandle>
  bumpDraw: () => void
  t: (key: string) => unknown
  // 只剩横条一种（手机抽屉、全屏）；桌面竖轨 2026-11-26 起两套外壳都用 ProDrawRail
  // Strip only (mobile sheet, fullscreen); the desktop rail is ProDrawRail in both shells since 2026-11-26
  variant?: 'strip'
  // 测量（尺子）按钮：只有传了才显示 / the ruler button shows only when these are passed
  measureOn?: boolean
  onMeasure?: () => void
}) {
  const Divider = () => <span className="term-toolbar-divider" />
  const dl = drawLayerRef.current
  // 画线层挂上之前 ref 还是空的，此时按「可见」画 / before the layer mounts, treat drawings as visible
  const visible = dl?.visible ?? true
  const magnet = dl?.magnet ?? 'off'
  const allLocked = (dl?.drawCount ?? 0) > 0 && dl?.lockedCount === dl?.drawCount
  const hintRef = useOverflowHint<HTMLDivElement>()

  return (
    <div ref={hintRef} className="term-tools-strip no-sb" role="group" aria-label={String(t('charts.draw.tools'))}>
      <DrawToolGroups drawLayerRef={drawLayerRef} bumpDraw={bumpDraw} t={t} />
      {onMeasure && (
        <button
          type="button"
          title={`${String(t('charts.measure.title'))} (Shift+🖱)`}
          aria-label={String(t('charts.measure.title'))}
          aria-pressed={!!measureOn}
          onClick={onMeasure}
          className={`term-tool-btn ${measureOn ? 'on' : ''}`}
        >
          <IcRuler />
        </button>
      )}
      <Divider />
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          title={String(t('charts.draw.color'))}
          aria-label={String(t('charts.draw.color'))}
          onClick={() => { drawLayerRef.current?.applyColor(c); bumpDraw() }}
          className={`term-color-dot ${dl?.color === c ? 'on' : ''}`}
          style={{ background: c }}
        />
      ))}
      <Divider />
      <button
        type="button"
        title={String(t(`charts.draw.magnet_${magnet}`))}
        aria-label={String(t(`charts.draw.magnet_${magnet}`))}
        aria-pressed={magnet !== 'off'}
        onClick={() => { drawLayerRef.current?.setMagnet(magnet === 'off' ? 'weak' : magnet === 'weak' ? 'strong' : 'off'); bumpDraw() }}
        className={`term-tool-btn ${magnet !== 'off' ? 'on' : ''}`}
      >
        <IcMagnet strong={magnet === 'strong'} />
      </button>
      <button
        type="button"
        title={String(t('charts.draw.stayInDraw'))}
        aria-label={String(t('charts.draw.stayInDraw'))}
        aria-pressed={!!dl?.stayInDraw}
        onClick={() => { drawLayerRef.current?.setStayInDraw(!drawLayerRef.current?.stayInDraw); bumpDraw() }}
        className={`term-tool-btn ${dl?.stayInDraw ? 'on' : ''}`}
      >
        <IcStay />
      </button>
      <button
        type="button"
        title={String(allLocked ? t('charts.draw.unlockAll') : t('charts.draw.lockAll'))}
        aria-label={String(allLocked ? t('charts.draw.unlockAll') : t('charts.draw.lockAll'))}
        aria-pressed={allLocked}
        disabled={(dl?.drawCount ?? 0) === 0}
        onClick={() => { if (allLocked) drawLayerRef.current?.unlockAll(); else drawLayerRef.current?.lockAll(); bumpDraw() }}
        className={`term-tool-btn warn ${allLocked ? 'on' : ''}`}
      >
        <IcLock locked={allLocked} />
      </button>
      <button
        type="button"
        title={String(visible ? t('charts.draw.hideAll') : t('charts.draw.showAll'))}
        aria-label={String(visible ? t('charts.draw.hideAll') : t('charts.draw.showAll'))}
        onClick={() => { drawLayerRef.current?.setVisible(!drawLayerRef.current?.visible); bumpDraw() }}
        className={`term-tool-btn warn ${!visible ? 'on' : ''}`}
      >
        <IcEye off={!visible} />
      </button>
      <button
        type="button"
        title={String(t('charts.draw.objectTree'))}
        aria-label={String(t('charts.draw.objectTree'))}
        aria-pressed={!!dl?.treeOpen}
        onClick={() => { drawLayerRef.current?.toggleTree(); bumpDraw() }}
        className={`term-tool-btn ${dl?.treeOpen ? 'on' : ''}`}
      >
        <IcTree />
      </button>
      <button
        type="button"
        title={String(t('charts.draw.clear'))}
        aria-label={String(t('charts.draw.clear'))}
        onClick={() => { drawLayerRef.current?.clearAll(); bumpDraw() }}
        disabled={(dl?.drawCount ?? 0) === 0}
        className="term-tool-btn"
      >
        <IcTrash />
      </button>
    </div>
  )
}
