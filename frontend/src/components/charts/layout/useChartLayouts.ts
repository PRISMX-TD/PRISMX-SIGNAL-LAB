// 图表布局的保存 / 载入 / 自动保存 / 跨设备同步（阶段 6，后端 rev 57 的 /chart/layouts）。
// 当前布局 id 与自动保存开关存在 chartv2 / layout（新键，不动 chartv2 的其它键）。
// 没有存过布局、又只开一张图时什么都不写——和以前一模一样；第一次切成多图（自动保存开着）才懒建一份
// 「我的布局」。自动保存：改动停 2 秒后 PUT 当前布局。别的设备改了当前布局（WS CHART_LAYOUTS_UPDATE）、
// 本地又没有没存的改动时，套用远端那份（第 0 格除外，见 layoutModel.mergeDoc）。
// Saving / loading / autosaving / cross-device sync of chart layouts (phase 6, backend rev 57's
// /chart/layouts). The active layout id and the autosave flag live in chartv2 / layout (a new key; the
// other chartv2 keys are untouched). With no saved layout and a single chart nothing is written — exactly
// as before; the first switch to a multi-chart grid (autosave on) lazily creates a "My layout". Autosave
// PUTs the active layout 2 s after the last change. When another device changes the active layout (WS
// CHART_LAYOUTS_UPDATE) and nothing local is unsaved, the remote copy is applied (except cell 0, see
// layoutModel.mergeDoc).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { chartApi } from '../../../api/client'
import type { ChartLayout } from '../../../api/types'
import { usePrefs } from '../../../store/prefs'
import { CHART_PREFS_NS } from '../useChartPrefs'
import { fitLayoutSize, mergeDoc, sanitizeLayout, uniqueName, type LayoutDoc } from './layoutModel'
import { onChartLayoutsUpdate } from './layoutEvents'
import type { PaneState } from './paneState'

export const LAYOUT_PREFS_KEY = 'layout'
export const AUTOSAVE_MS = 2000

export interface LayoutPrefs {
  id: string | null
  autosave: boolean
}

export function normalizeLayoutPrefs(raw: unknown): LayoutPrefs {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    id: typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 64 ? r.id : null,
    autosave: typeof r.autosave === 'boolean' ? r.autosave : true,
  }
}

interface Opts {
  // 云端偏好已加载 / cloud prefs are in
  ready: boolean
  // 当前完整布局（第 0 格已按全站偏好填好）/ the current full layout (cell 0 filled from the app-wide prefs)
  doc: LayoutDoc
  fallback: PaneState
  // 把布局套到页面上；full = 手动载入（第 0 格也换）/ apply a layout to the page; full = explicit load (cell 0 too)
  apply: (doc: LayoutDoc, full: boolean) => void
  onError: (msg: string) => void
  defaultName: string
  copyName: (name: string) => string
  tooBig: string
}

export interface ChartLayoutsApi {
  list: ChartLayout[] | null
  loading: boolean
  activeId: string | null
  autosave: boolean
  saving: boolean
  dirty: boolean
  refresh: () => Promise<ChartLayout[] | null>
  load: (id: string) => void
  save: () => Promise<boolean>
  saveAs: (name: string) => Promise<boolean>
  rename: (id: string, name: string) => Promise<boolean>
  copy: (id: string) => Promise<boolean>
  remove: (id: string) => Promise<boolean>
  setAutosave: (v: boolean) => void
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function useChartLayouts(o: Opts): ChartLayoutsApi {
  const { getPref, setPref } = usePrefs()
  const rawPrefs = getPref<unknown>(CHART_PREFS_NS, LAYOUT_PREFS_KEY, null)
  const prefs = useMemo(() => normalizeLayoutPrefs(rawPrefs), [rawPrefs])
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  const setPrefs = useCallback((patch: Partial<LayoutPrefs>) => {
    const next = { ...prefsRef.current, ...patch }
    prefsRef.current = next
    setPref(CHART_PREFS_NS, LAYOUT_PREFS_KEY, next)
  }, [setPref])

  const [list, setList] = useState<ChartLayout[] | null>(null)
  const listRef = useRef<ChartLayout[] | null>(null)
  listRef.current = list
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [restored, setRestored] = useState(false)

  const docJson = useMemo(() => JSON.stringify(o.doc), [o.doc])
  const docRef = useRef(o.doc)
  docRef.current = o.doc
  const docJsonRef = useRef(docJson)
  docJsonRef.current = docJson
  const optsRef = useRef(o)
  optsRef.current = o
  // 最近一次与服务器一致的布局 JSON / the layout JSON last known to match the server
  const lastSavedJsonRef = useRef<string | null>(null)
  // 最近一次本机写入 / 套用的那份的 updatedAt（自己写的回声不再套用）/ updatedAt of our own last write / apply (skip our echo)
  const lastSavedAtRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const againRef = useRef(false)
  const errShownRef = useRef(false)

  const upsert = useCallback((l: ChartLayout) => {
    setList((prev) => {
      const arr = prev ?? []
      const i = arr.findIndex((x) => x.id === l.id)
      return i < 0 ? [l, ...arr] : arr.map((x) => (x.id === l.id ? l : x))
    })
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const r = await chartApi.listLayouts()
      const arr = Array.isArray(r.layouts) ? r.layouts : []
      setList(arr)
      listRef.current = arr
      return arr
    } catch (e) {
      optsRef.current.onError(errMsg(e))
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  // restore = 进页面时套用：当前格也用存下的那个（跨设备的实时同步才保留本地当前格）
  // restore = applying on entry: the saved active cell is used too (only live cross-device sync keeps the local one)
  const applyRemote = useCallback((l: ChartLayout, full: boolean, restore = false) => {
    const { fallback, apply } = optsRef.current
    const remote = sanitizeLayout(l.data, fallback)
    const m = mergeDoc(docRef.current, remote, full)
    const merged = restore ? { ...m, active: remote.active } : m
    lastSavedJsonRef.current = JSON.stringify(merged)
    lastSavedAtRef.current = l.updatedAt
    apply(merged, full)
  }, [])

  // 进页面：有当前布局就拉一次列表并套用（第 0 格仍听全站偏好）；那份已被删掉就忘了它。
  // On entry: with an active layout, fetch the list once and apply it (cell 0 still follows the
  // app-wide prefs); forget it if it was deleted.
  useEffect(() => {
    if (!o.ready || restored) return
    const id = prefs.id
    if (!id) {
      lastSavedJsonRef.current = docJsonRef.current
      setRestored(true)
      return
    }
    let alive = true
    void (async () => {
      const arr = await refresh()
      if (!alive) return
      const l = arr?.find((x) => x.id === id)
      if (l) applyRemote(l, false, true)
      else {
        if (arr) setPrefs({ id: null })
        lastSavedJsonRef.current = docJsonRef.current
      }
      setRestored(true)
    })()
    return () => { alive = false }
  }, [o.ready, restored, prefs.id, refresh, applyRemote, setPrefs])

  // 写一次：有当前布局就 PUT，没有就新建一份默认名的并设为当前。
  // One write: PUT the active layout, or create a default-named one and make it active.
  const flush = useCallback(async (): Promise<boolean> => {
    if (busyRef.current) { againRef.current = true; return false }
    const json = docJsonRef.current
    const doc = fitLayoutSize(docRef.current)
    const { onError, defaultName, tooBig } = optsRef.current
    if (!doc) { onError(tooBig); return false }
    busyRef.current = true
    setSaving(true)
    try {
      const id = prefsRef.current.id
      let saved: ChartLayout
      if (id) saved = await chartApi.updateLayout(id, { data: doc })
      else {
        const names = (listRef.current ?? []).map((x) => x.name)
        saved = await chartApi.createLayout(uniqueName(defaultName, names), doc)
        setPrefs({ id: saved.id })
      }
      lastSavedAtRef.current = saved.updatedAt
      lastSavedJsonRef.current = json
      errShownRef.current = false
      upsert(saved)
      return true
    } catch (e) {
      if (!errShownRef.current) onError(errMsg(e))
      errShownRef.current = true
      return false
    } finally {
      busyRef.current = false
      setSaving(false)
      if (againRef.current) {
        againRef.current = false
        if (docJsonRef.current !== lastSavedJsonRef.current) void flushRef.current()
      }
    }
  }, [setPrefs, upsert])
  const flushRef = useRef(flush)
  flushRef.current = flush

  // 自动保存：改动停 2 秒后写。没存过布局、又只有一张图：不写（和以前一样）。
  // Autosave 2 s after the last change. No saved layout and a single chart: no write (as before).
  const multi = o.doc.grid !== '1'
  useEffect(() => {
    if (!o.ready || !restored || !prefs.autosave) return
    if (docJson === lastSavedJsonRef.current) return
    if (!prefs.id && !multi) return
    const tm = window.setTimeout(() => { void flushRef.current() }, AUTOSAVE_MS)
    return () => window.clearTimeout(tm)
  }, [docJson, o.ready, restored, prefs.autosave, prefs.id, multi])

  // 别的设备（或本机）写了布局：重拉列表；当前布局被别处改了、本地没有没存的改动就套用。
  // A layout was written elsewhere (or here): refetch the list; apply the active one's remote copy when
  // nothing local is unsaved.
  useEffect(() => onChartLayoutsUpdate(({ id }) => {
    const activeId = prefsRef.current.id
    if (listRef.current == null && !activeId) return
    void (async () => {
      const arr = await refresh()
      if (!arr || !id || id !== prefsRef.current.id) return
      const l = arr.find((x) => x.id === id)
      if (!l) { setPrefs({ id: null }); return }
      if (l.updatedAt === lastSavedAtRef.current) return
      if (busyRef.current || docJsonRef.current !== lastSavedJsonRef.current) return
      applyRemote(l, false)
    })()
  }), [refresh, applyRemote, setPrefs])

  const load = useCallback((id: string) => {
    const l = listRef.current?.find((x) => x.id === id)
    if (!l) return
    setPrefs({ id })
    applyRemote(l, true)
  }, [applyRemote, setPrefs])

  const save = useCallback(() => flushRef.current(), [])

  const saveAs = useCallback(async (name: string) => {
    const doc = fitLayoutSize(docRef.current)
    const { onError, tooBig, defaultName } = optsRef.current
    if (!doc) { onError(tooBig); return false }
    try {
      const names = (listRef.current ?? []).map((x) => x.name)
      const saved = await chartApi.createLayout(uniqueName(name.trim() || defaultName, names), doc)
      setPrefs({ id: saved.id })
      lastSavedAtRef.current = saved.updatedAt
      lastSavedJsonRef.current = docJsonRef.current
      upsert(saved)
      return true
    } catch (e) { onError(errMsg(e)); return false }
  }, [setPrefs, upsert])

  const rename = useCallback(async (id: string, name: string) => {
    const n = name.trim().slice(0, 60)
    if (!n) return false
    try {
      const saved = await chartApi.updateLayout(id, { name: n })
      if (id === prefsRef.current.id) lastSavedAtRef.current = saved.updatedAt
      upsert(saved)
      return true
    } catch (e) { optsRef.current.onError(errMsg(e)); return false }
  }, [upsert])

  const copy = useCallback(async (id: string) => {
    const l = listRef.current?.find((x) => x.id === id)
    if (!l) return false
    try {
      const names = (listRef.current ?? []).map((x) => x.name)
      const saved = await chartApi.createLayout(uniqueName(optsRef.current.copyName(l.name), names), l.data)
      upsert(saved)
      return true
    } catch (e) { optsRef.current.onError(errMsg(e)); return false }
  }, [upsert])

  const remove = useCallback(async (id: string) => {
    try {
      await chartApi.deleteLayout(id)
      setList((prev) => (prev ?? []).filter((x) => x.id !== id))
      if (id === prefsRef.current.id) {
        setPrefs({ id: null })
        // 删掉当前布局后，眼前这份不算「没存」——下一次改动才会（自动保存开着时）新建一份
        // After deleting the active layout the current state isn't "unsaved"; the next change creates a new one (autosave on)
        lastSavedJsonRef.current = docJsonRef.current
      }
      return true
    } catch (e) { optsRef.current.onError(errMsg(e)); return false }
  }, [setPrefs])

  const setAutosave = useCallback((v: boolean) => setPrefs({ autosave: v }), [setPrefs])

  return {
    list, loading, activeId: prefs.id, autosave: prefs.autosave, saving,
    dirty: restored && docJson !== lastSavedJsonRef.current,
    refresh, load, save, saveAs, rename, copy, remove, setAutosave,
  }
}
