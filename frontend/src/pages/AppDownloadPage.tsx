// 安卓 App 下载页。左侧：品牌图标 + 标题 + 下载按钮；右侧（仅宽屏）：扫码下载，
// 电脑上看这页的人多半是想装到手机上，直接扫码比把链接发到手机省事。
// 下面三步安装流程 + 注意事项。直链见 api/appDownload.ts。
// 在 App 里打开、且安装包带原生 SignalUpdate 插件（1.0.5 起）时，按钮改成 App 内下载并安装，
// 不再跳到系统浏览器的下载页；旧安装包与网页照旧走链接。见 utils/nativeApkUpdate.ts。
// Android app download page. Left: brand icon, headline, download button. Right
// (wide screens only): scan-to-download, since a desktop visitor almost always
// wants the app on their phone. Below: the three install steps and notes.
// Inside the App with the native SignalUpdate plugin (1.0.5+), the button downloads and installs
// in-App instead of bouncing to the browser's download page; older APKs and the web keep the link.
import { useEffect, useState } from 'react'
import type { MouseEvent } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { useTranslation } from 'react-i18next'
import { APP_DOWNLOAD_URL, APP_FILENAME } from '../api/appDownload'
import { isNativeApp } from '../utils/inAppBrowser'
import {
  type ApkUpdateState, type ApkUpdater, downloadAndInstall, getApkUpdater, installDownloaded, probeApkUpdater,
} from '../utils/nativeApkUpdate'

// iPhone 用户点下载只会拿到一个装不了的文件，先说清楚。
// iPhone users would only get a file they can't install; say so up front.
const isIOS = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/i.test(navigator.userAgent)

export default function AppDownloadPage() {
  const { t } = useTranslation()
  const steps = [
    { title: t('appDownload.s1Title'), desc: t('appDownload.s1Desc') },
    { title: t('appDownload.s2Title'), desc: t('appDownload.s2Desc') },
    { title: t('appDownload.s3Title'), desc: t('appDownload.s3Desc') },
  ]
  const notes = [t('appDownload.n1'), t('appDownload.n2'), t('appDownload.n3')]

  // 只有探针答上来才切到 App 内下载；探测期间与探测失败都保持原来的链接。
  // Switch to in-App download only once the probe answers; until then (or on failure) keep the link.
  const [updater, setUpdater] = useState<ApkUpdater | null>(null)
  const [currentVersion, setCurrentVersion] = useState<string | null>(null)
  const [update, setUpdate] = useState<ApkUpdateState>({ kind: 'idle' })
  useEffect(() => {
    if (!isNativeApp()) return
    const u = getApkUpdater()
    if (!u) return
    let alive = true
    probeApkUpdater(u).then((info) => {
      if (!alive || !info) return
      setUpdater(u)
      setCurrentVersion(info.versionName)
    })
    return () => { alive = false }
  }, [])
  const busy = update.kind === 'downloading' || update.kind === 'opening'
  // 包已经下好（安装界面被退出、或刚去设置里允许了安装）时，按钮只做「安装」。
  // When the package is already downloaded (installer dismissed, or permission just granted), the button only installs.
  const installOnly = update.kind === 'opened' || update.kind === 'needPermission'
  const onDownload = updater
    ? (e: MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault()
        if (busy) return
        void (installOnly ? installDownloaded(updater, setUpdate) : downloadAndInstall(updater, APP_DOWNLOAD_URL, setUpdate))
      }
    : undefined
  const failed = update.kind === 'failed' ? update.reason : null
  const statusText =
    update.kind === 'downloading'
      ? update.percent === null
        ? t('appDownload.inApp.downloadingNoSize')
        : t('appDownload.inApp.downloading', { percent: update.percent })
      : update.kind === 'opening' ? t('appDownload.inApp.opening')
      : update.kind === 'opened' ? t('appDownload.inApp.opened')
      : update.kind === 'upToDate' ? t('appDownload.inApp.upToDate', { version: update.version })
      : update.kind === 'needPermission' ? t('appDownload.inApp.needPermission')
      : failed === 'network' ? t('appDownload.inApp.failedNetwork')
      : failed === 'package' ? t('appDownload.inApp.failedPackage')
      : failed === 'install' ? t('appDownload.inApp.failedInstall')
      : null

  return (
    <div className="space-y-5">
      <section className="glass relative overflow-hidden p-6 sm:p-10">
        {/* 顶边一条光谱线（全站签名图形），代替发光光晕。
            The site's spectral-rule hairline along the top edge, instead of a glow. */}
        <div aria-hidden className="absolute inset-x-0 top-0 h-px bg-spectral-rule" />
        <div className="relative grid grid-cols-1 items-center gap-10 lg:grid-cols-[1fr_auto]">
          <div className="animate-fade-in-up motion-reduce:animate-none">
            <img
              src="/logo-128.png"
              alt=""
              width={64}
              height={64}
              className="h-16 w-16 rounded-2xl border border-white/10 shadow-prism"
            />
            <h1 className="mt-6 font-display text-3xl font-semibold leading-tight tracking-tight text-neutral-50 sm:text-4xl">
              {t('appDownload.title')}
            </h1>
            <p className="mt-3 max-w-[46ch] text-base leading-relaxed text-neutral-400">
              {t('appDownload.subtitle')}
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
              <a
                href={APP_DOWNLOAD_URL}
                download={APP_FILENAME}
                onClick={onDownload}
                aria-disabled={busy || undefined}
                className={`btn-primary inline-flex items-center gap-2 whitespace-nowrap px-7 py-3.5 text-base transition active:scale-[0.98] ${busy ? 'pointer-events-none opacity-60' : ''}`}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                {updater
                  ? t(installOnly ? 'appDownload.inApp.installOnlyBtn' : 'appDownload.inApp.installBtn')
                  : t('appDownload.downloadBtn')}
              </a>
              <span className="text-sm text-neutral-500">
                {currentVersion ? t('appDownload.inApp.current', { version: currentVersion }) : t('appDownload.platform')}
              </span>
            </div>

            {updater && (
              <div className="mt-4 max-w-[46ch]" aria-live="polite">
                {update.kind === 'downloading' && (
                  <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div
                      className={`h-full rounded-full bg-prism-500 transition-[width] duration-200 ${update.percent === null ? 'w-1/3 animate-pulse' : ''}`}
                      style={update.percent === null ? undefined : { width: `${update.percent}%` }}
                    />
                  </div>
                )}
                {statusText && (
                  <p className={`text-sm leading-relaxed ${failed ? 'text-amber-200' : 'text-neutral-400'}`}>{statusText}</p>
                )}
                {(failed === 'network' || failed === 'install') && (
                  // 不带 onClick：交给系统浏览器下载，与旧安装包同一条路。
                  // No onClick: hands the link to the system browser, same path as older APKs.
                  <a href={APP_DOWNLOAD_URL} download={APP_FILENAME} className="mt-2 inline-block text-sm text-prism-300 underline underline-offset-4">
                    {t('appDownload.inApp.browserFallback')}
                  </a>
                )}
              </div>
            )}

            {isIOS && (
              <p className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 text-sm text-amber-200">
                {t('appDownload.iosNotice')}
              </p>
            )}
          </div>

          <div className="hidden flex-col items-center rounded-2xl border border-white/10 bg-white/[0.03] p-6 lg:flex">
            <div className="rounded-xl bg-white p-3">
              <QRCodeSVG value={APP_DOWNLOAD_URL} size={160} level="M" />
            </div>
            <div className="mt-4 text-sm font-medium text-neutral-200">{t('appDownload.scanTitle')}</div>
            <div className="mt-1 text-xs text-neutral-500">{t('appDownload.scanDesc')}</div>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-3">
        <section className="glass p-6 lg:col-span-2">
          <h2 className="font-display text-lg font-semibold text-neutral-100">{t('appDownload.stepsTitle')}</h2>
          <ol className="mt-5 grid grid-cols-1 gap-6 sm:grid-cols-3">
            {steps.map((s, i) => (
              <li key={i} className="relative">
                <div className="flex h-8 w-8 items-center justify-center rounded-full border border-prism-600/40 bg-prism-600/10 font-mono text-sm text-prism-300">
                  {i + 1}
                </div>
                <div className="mt-3 font-medium text-neutral-100">{s.title}</div>
                <p className="mt-1 text-sm leading-relaxed text-neutral-400">{s.desc}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="glass border-l-2 border-amber-400/50 p-6">
          <h2 className="mb-3 font-display text-lg font-semibold text-neutral-100">{t('appDownload.notesTitle')}</h2>
          <ul className="space-y-2.5">
            {notes.map((n, i) => (
              <li key={i} className="text-sm leading-relaxed text-neutral-300">{n}</li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
