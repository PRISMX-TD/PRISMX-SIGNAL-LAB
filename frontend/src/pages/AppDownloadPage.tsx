// 安卓 App 下载页。左侧：品牌图标 + 标题 + 下载按钮；右侧（仅宽屏）：扫码下载，
// 电脑上看这页的人多半是想装到手机上，直接扫码比把链接发到手机省事。
// 下面三步安装流程 + 注意事项。直链见 api/appDownload.ts。
// Android app download page. Left: brand icon, headline, download button. Right
// (wide screens only): scan-to-download, since a desktop visitor almost always
// wants the app on their phone. Below: the three install steps and notes.
import { QRCodeSVG } from 'qrcode.react'
import { useTranslation } from 'react-i18next'
import { APP_DOWNLOAD_URL, APP_FILENAME } from '../api/appDownload'

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
                className="btn-primary inline-flex items-center gap-2 whitespace-nowrap px-7 py-3.5 text-base transition active:scale-[0.98]"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                {t('appDownload.downloadBtn')}
              </a>
              <span className="text-sm text-neutral-500">{t('appDownload.platform')}</span>
            </div>

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
