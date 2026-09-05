// 管理后台「策略公开」页签：决定哪些策略的胜率对用户可见。
//
// 这一页**只有设置**。分析视图已经搬到信号面板的「策略分析」页签（用户端，FREE 与
// PRO 同样可见），管理页不再重复一份——两份会随时间漂移，而且没有人会去对。
//
// 表里**列出全部策略**，公开与否都显示它的胜率：你要看着这些数字才能决定公开谁，
// 只显示已公开的等于让人闭着眼睛勾。名单里存在、但窗口内没有信号的策略也补在表尾
// （显示"近 N 天没有信号"），不静默丢弃——丢掉会让人以为自己没勾过。
//
// **勾选改变的不只是列表，是分母**：用户端的时段胜率、品种胜率只用已公开策略的
// 信号计算（后端 compute_strategy_session_winrate 的 only_strategies）。所以这里
// 每勾一下，用户看到的每一个百分比都会变。
//
// 默认一个都不公开。这是刻意的：公开胜率对用户是一种承诺，必须由人主动做一次，
// 不能靠默认值替人做主。
//
// The admin "strategy publication" tab: which strategies' win rates users can
// see. **Settings only** — the analysis view now lives on the signals page for
// users, and keeping a second copy here would only let the two drift.
//
// The table lists **every** strategy with its win rate, published or not: you
// decide by comparing them, and showing only the published ones would mean
// ticking boxes blind. Whitelisted names with no signals in the window are
// appended rather than dropped, since dropping them reads as "never ticked".
//
// **Ticking a box moves the denominator, not just a list**: user-facing session
// and symbol win rates are computed from published strategies alone. Every
// percentage a user sees changes with these boxes.
//
// Nothing is published by default — publishing win rates is a promise to users
// and a person has to make it once, deliberately.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Switch from '../Switch'
import { adminApi } from '../../api/client'
import { SkeletonLine } from '../Skeleton'
import type { AdminWinrateSettings, AdminWinrateStrategy } from '../../api/types'
import { VERDICT_COLOR, fmtPct, verdictOf } from '../winrate/shared'

/** 一行的胜率颜色。走全站同一条 verdictOf——这里显示的数字必须和用户端看到的
 *  同色同义，否则管理员按一个口径勾选、用户按另一个口径读。
 *  Row colour via the one shared verdictOf: the number here must mean the same
 *  thing, in the same colour, as the one users see. */
function rateColor(row: AdminWinrateStrategy): string {
  const kind = verdictOf({
    samples: row.resolved,
    resolved: row.resolved,
    winRate: row.winRate,
    wilsonLow: null,
    wilsonHigh: null,
  })
  return VERDICT_COLOR[kind]
}

export default function StrategyWinratePanel() {
  const { t } = useTranslation()
  const [data, setData] = useState<AdminWinrateSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 本地勾选态；保存后由服务端返回值覆盖。
  // Local tick state, overwritten by the server's response on save.
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    let cancelled = false
    adminApi
      .getWinrateSettings()
      .then((res) => {
        if (cancelled) return
        setData(res)
        setPicked(new Set(res.strategies.filter((s) => s.public).map((s) => s.strategy)))
        setDirty(false)
        setError(null)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Load failed')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  const toggle = (name: string) => {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
    setDirty(true)
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await adminApi.updateWinrateSettings([...picked])
      setData(res)
      setPicked(new Set(res.strategies.filter((s) => s.public).map((s) => s.strategy)))
      setDirty(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const days = data?.days ?? 30
  const rows = data?.strategies ?? []

  return (
    <div className="space-y-4">
      <header className="px-1">
        <h3 className="font-display text-lg font-semibold text-neutral-100">{t('admin.winratePublish.title')}</h3>
        <p className="mt-1 max-w-[72ch] text-sm leading-relaxed text-neutral-500">
          {t('admin.winratePublish.hint', { days })}
        </p>
      </header>

      {error && (
        <div className="rounded-lg px-4 py-3 text-sm" role="alert"
             style={{ background: 'var(--down-bg)', color: 'var(--down)' }}>
          {error}
        </div>
      )}

      <div className="glass p-5 md:p-6">
        {loading ? (
          <div className="space-y-3" aria-busy="true">
            <SkeletonLine width="100%" /><SkeletonLine width="90%" /><SkeletonLine width="80%" />
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-neutral-500">
            {t('admin.winratePublish.noStrategies', { days })}
          </p>
        ) : (
          <ul className="divide-y divide-white/5">
            {rows.map((row) => {
              const on = picked.has(row.strategy)
              const named = row.strategy || t('admin.winrate.strategies.unnamed')
              return (
                <li key={row.strategy} className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-neutral-100">{named}</p>
                    <p className="mt-0.5 text-xs tabular-nums text-neutral-500">
                      {row.winRate === null
                        ? t('admin.winratePublish.noSignals', { days })
                        : t('admin.winratePublish.resolved', { count: row.resolved })}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-4">
                    <span className="w-16 text-right text-sm font-semibold tabular-nums"
                          style={{ color: rateColor(row) }}>
                      {row.winRate === null ? '—' : fmtPct(row.winRate)}
                    </span>
                    {/* 空串策略（信号没带名字）不能公开：它在用户端显示成「未命名策略」，
                        公开一个没有名字的策略对用户没有意义。后端也会拒。
                        The empty-name strategy is not publishable: it renders as
                        "unnamed strategy" for users and means nothing. The backend
                        rejects it too. */}
                    <label className={`flex items-center gap-2 text-xs ${row.strategy ? 'cursor-pointer' : 'cursor-not-allowed opacity-40'}`}>
                      <Switch checked={on} disabled={!row.strategy} onChange={() => toggle(row.strategy)} />
                      <span className={on ? 'text-prism-200' : 'text-neutral-500'}>
                        {t('admin.winratePublish.publicLabel')}
                      </span>
                    </label>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 px-1">
        <button type="button" className="btn-primary px-5 py-2 text-sm disabled:opacity-40"
                disabled={saving || loading || !dirty} onClick={save}>
          {saving ? t('common.loading') : t('common.save')}
        </button>
        <span className="text-xs text-neutral-500">
          {picked.size === 0
            ? t('admin.winratePublish.nonePublic')
            : t('admin.winratePublish.countPublic', { count: picked.size })}
        </span>
      </div>
    </div>
  )
}
