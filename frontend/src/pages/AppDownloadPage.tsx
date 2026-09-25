// 安卓 App 下载页：一个下载按钮 + 安装说明。直链见 api/appDownload.ts。
// Android app download page: one download button plus install notes.
import PageHead from '../components/PageHead'
import { useTranslation } from 'react-i18next'
import { APP_DOWNLOAD_URL, APP_FILENAME } from '../api/appDownload'

export default function AppDownloadPage() {
  const { t } = useTranslation()
  const notes = [t('appDownload.n1'), t('appDownload.n2'), t('appDownload.n3')]

  return (
    <div>
      <PageHead as="h1" title={t('appDownload.title')} subtitle={t('appDownload.subtitle')} />
      <div className="glass p-6">
        <div className="flex flex-col items-start gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-neutral-500">{t('appDownload.platform')}</div>
          <a
            href={APP_DOWNLOAD_URL}
            download={APP_FILENAME}
            className="btn-primary flex shrink-0 items-center gap-2 px-6 py-3 text-base"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {t('appDownload.downloadBtn')}
          </a>
        </div>
      </div>

      <div className="glass mt-5 border-l-2 border-amber-400/50 p-6">
        <h3 className="mb-3 font-display text-lg font-semibold text-neutral-100">
          {t('appDownload.notesTitle')}
        </h3>
        <ul className="space-y-2.5">
          {notes.map((n, i) => (
            <li key={i} className="flex gap-2.5 text-sm text-neutral-300">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400/70" />
              <span className="leading-relaxed">{n}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
