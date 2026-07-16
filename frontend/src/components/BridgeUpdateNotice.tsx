// Bridge 更新提示：右下角小卡片，提醒当前登录用户的 Bridge 有新版本可更新。
// "不再提醒"按最新版本号记在本地——出下一个新版本时，记的版本号对不上，
// 提示会自动重新出现，不需要用户手动清掉。
// Bridge update notice: a small bottom-right card reminding the logged-in
// user their Bridge has a newer version available. "Don't remind me" is
// recorded against the specific latest-version string — once a newer
// release ships, the stored value no longer matches and the notice
// reappears automatically, no manual reset needed.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { bridgeVersionApi } from '../api/client'
import { isNewerVersion } from '../api/utils'

const DISMISS_KEY = 'prismx_bridge_update_dismissed_version'
// 距上次检查够久了才复查一次；用户在应用里长开也不用重复调接口。
// Recheck only after enough time has passed; long-running sessions don't
// need to keep hitting the endpoint.
const RECHECK_MS = 30 * 60 * 1000

export default function BridgeUpdateNotice() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<{ current: string | null; latest: string | null } | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let alive = true
    const check = () => {
      bridgeVersionApi.status().then((r) => {
        if (alive) setStatus(r)
      }).catch(() => {})
    }
    check()
    const timer = window.setInterval(check, RECHECK_MS)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])

  const { current, latest } = status ?? { current: null, latest: null }
  // current 为空：这个用户从没连过会上报版本号的 Bridge，没有基准可比，不提示。
  // current empty: this user never connected a version-reporting Bridge, nothing to compare, no notice.
  const shouldShow = !!current && !!latest && isNewerVersion(latest, current)

  useEffect(() => {
    if (!latest) return
    setDismissed(localStorage.getItem(DISMISS_KEY) === latest)
  }, [latest])

  if (!shouldShow || dismissed) return null

  const onDismiss = () => {
    if (latest) localStorage.setItem(DISMISS_KEY, latest)
    setDismissed(true)
  }

  return (
    <div className="fixed bottom-20 right-4 z-40 w-[300px] rounded-xl border border-prism-500/30 bg-ink-900/95 p-4 shadow-prism backdrop-blur-xl sm:bottom-6 sm:right-6">
      <div className="flex items-start gap-2.5">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0 text-prism-400">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-white">{t('bridgeUpdate.title')}</div>
          <p className="mt-1 text-xs leading-relaxed text-slate-400">
            {t('bridgeUpdate.body', { current, latest })}
          </p>
          <div className="mt-3 flex gap-2">
            <Link
              to="/download"
              className="rounded-lg bg-prism-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-prism-500"
            >
              {t('bridgeUpdate.update')}
            </Link>
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-400 transition hover:text-slate-200"
            >
              {t('bridgeUpdate.dismiss')}
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('bridgeUpdate.dismiss')}
          className="shrink-0 text-slate-500 hover:text-slate-300"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
    </div>
  )
}
