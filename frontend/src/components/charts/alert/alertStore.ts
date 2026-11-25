// 图表警报的前端仓库：一份全局列表（模块级，图表页卸载后还在，回来秒显示），有人订阅时才去拉。
// 后端每次写入都推 WS CHART_ALERTS_UPDATE（不带内容），这里收到就重拉一次（合并 300 ms 内的多次）。
// 自己的增删改先就地改列表，界面不等 WS。
// The chart-alert store: one global list (module level; survives leaving the charts page so
// coming back is instant), fetched once something subscribes. Every backend write pushes WS
// CHART_ALERTS_UPDATE (no payload) and the list is refetched (bursts within 300 ms merged). Our
// own writes patch the list in place, so the UI never waits for the WS.
import { useSyncExternalStore } from 'react'
import { chartApi } from '../../../api/client'
import type { ChartAlert, ChartAlertIn } from '../../../api/types'
import { onChartAlertsUpdate } from '../../../utils/chartAlertEvents'
import type { Drawing } from '../draw/model'
import { drawSpec, drawTargets, sameGeometry, toIn } from './model'

interface Snap { alerts: ChartAlert[]; loaded: boolean }
let snap: Snap = { alerts: [], loaded: false }
const subs = new Set<() => void>()
let inflight: Promise<void> | null = null
let refetchTimer: number | undefined
let wsOff: (() => void) | null = null

function set(alerts: ChartAlert[]) {
  snap = { alerts, loaded: true }
  subs.forEach((f) => f())
}

export function refreshAlerts(): Promise<void> {
  if (inflight) return inflight
  inflight = chartApi.listAlerts()
    .then((r) => set(Array.isArray(r.alerts) ? r.alerts : []))
    .catch(() => { if (!snap.loaded) set([]) })
    .finally(() => { inflight = null })
  return inflight
}

function scheduleRefetch() {
  window.clearTimeout(refetchTimer)
  refetchTimer = window.setTimeout(() => { void refreshAlerts() }, 300)
}

function subscribe(cb: () => void) {
  subs.add(cb)
  if (subs.size === 1) {
    wsOff = onChartAlertsUpdate(scheduleRefetch)
    void refreshAlerts()
  }
  return () => {
    subs.delete(cb)
    if (subs.size === 0) { wsOff?.(); wsOff = null }
  }
}
const getSnap = () => snap

export function useChartAlerts(): Snap {
  return useSyncExternalStore(subscribe, getSnap, getSnap)
}
export const alertsNow = () => snap.alerts

function upsert(a: ChartAlert) {
  const i = snap.alerts.findIndex((x) => x.id === a.id)
  set(i < 0 ? [a, ...snap.alerts] : snap.alerts.map((x) => (x.id === a.id ? a : x)))
}

export async function createAlert(body: ChartAlertIn): Promise<ChartAlert> {
  const a = await chartApi.createAlert(body)
  upsert(a)
  return a
}
export async function updateAlert(id: string, body: ChartAlertIn): Promise<ChartAlert> {
  const a = await chartApi.updateAlert(id, body)
  upsert(a)
  return a
}
export async function setAlertActive(a: ChartAlert, active: boolean, ref?: number | null): Promise<ChartAlert> {
  const spec = ref != null && ref > 0 ? { ...a.spec, ref } : a.spec
  return updateAlert(a.id, toIn(a, { active, spec }))
}
export async function deleteAlerts(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const r = await chartApi.deleteAlerts(ids)
  const gone = new Set(ids)
  set(snap.alerts.filter((x) => !gone.has(x.id)))
  return r.deleted
}

// 画线存盘时同步它的警报：画线删了 → 警报一起删；挪了 → 按 spec.part 重算几何再存。
// 只在列表已经拉到时做（没拉到说明没人看过警报，也就不会有过期几何要改）。
// On a drawing save, sync its alerts: drawing gone → delete its alerts; moved → re-derive the
// geometry by spec.part and save. Only once the list is loaded (otherwise nothing to fix).
export function syncDrawingAlerts(symbol: string, drawings: Drawing[]): void {
  if (!snap.loaded) return
  const sym = symbol.toUpperCase()
  const mine = snap.alerts.filter((a) => a.kind === 'drawing' && a.drawingId && a.symbol.toUpperCase() === sym)
  if (mine.length === 0) return
  const byId = new Map(drawings.map((d) => [d.id, d]))
  const orphans: string[] = []
  for (const a of mine) {
    const d = byId.get(a.drawingId!)
    if (!d) { orphans.push(a.id); continue }
    // 已触发 / 已过期的不动（再提交会把状态改成「已停止」）/ leave fired / expired ones (a resubmit would mark them paused)
    if (a.status !== 'active' && a.status !== 'paused') continue
    const spec = a.spec as Record<string, unknown>
    const tg = drawTargets(d).find((x) => x.part === (spec.part ?? 'line'))
    if (!tg || (tg.band ? 2 : 1) !== (Array.isArray(spec.lines) ? spec.lines.length : 0)) continue
    if (sameGeometry(spec.lines, tg.lines)) continue
    const next = { ...spec, ...drawSpec(tg) }
    delete (next as Record<string, unknown>).ref
    void updateAlert(a.id, toIn(a, { spec: next })).catch(() => { /* 下次存画线再试 / retried on the next save */ })
  }
  if (orphans.length) void deleteAlerts(orphans).catch(() => {})
}

export function resetAlertStoreForTests() {
  snap = { alerts: [], loaded: false }
  inflight = null
}
