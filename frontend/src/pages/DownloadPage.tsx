// 下载页：提供 PRISMX 桥接程序下载、使用教程与注意事项。
// Download page: PRISMX Bridge download, usage guide and important notes.
import { useTranslation } from 'react-i18next'

// 安装包直链与发布页（托管于 GitHub Releases）。
// 在 GitHub 仓库创建 Release，并按下方文件名上传安装包资产，点击即可直接下载，无需改代码。
// Installer direct link + releases page (hosted on GitHub Releases).
// Create a Release in the repo and upload the installer asset with the
// filename below; clicking downloads it directly with no code change.
const GITHUB_REPO = 'https://github.com/PRISMX-TD/PRISMX-SIGNAL-LAB'
const BRIDGE_FILENAME = 'PRISMX-Bridge-Setup.exe'
const DOWNLOAD_URL = `${GITHUB_REPO}/releases/latest/download/${BRIDGE_FILENAME}`
const APP_VERSION = 'v1.3.14'

export default function DownloadPage() {
  const { t } = useTranslation()

  const guide = [
    { title: t('download.g1Title'), desc: t('download.g1Desc') },
    { title: t('download.g2Title'), desc: t('download.g2Desc') },
    { title: t('download.g3Title'), desc: t('download.g3Desc') },
    { title: t('download.g4Title'), desc: t('download.g4Desc') },
  ]
  const notes = [
    t('download.n1'),
    t('download.n2'),
    t('download.n3'),
    t('download.n4'),
    t('download.n5'),
  ]

  return (
    <div className="mx-auto max-w-4xl">
      {/* PLACEHOLDER_HEADER */}
      {/* 头部 + 下载卡 / header + download card */}
      <div className="glass-neon relative overflow-hidden p-8">
        <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-prism-600/20 blur-3xl" />
        <div className="relative flex flex-col items-start gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-2xl font-bold text-slate-100">
              <span className="neon-text">{t('download.title')}</span>
            </h2>
            <p className="mt-2 max-w-xl text-sm text-slate-400">{t('download.subtitle')}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-500">
              <span className="tag border border-prism-600/40 bg-prism-600/10 text-prism-300">
                {t('download.version')} {APP_VERSION}
              </span>
              <span>{t('download.platform')}</span>
            </div>
          </div>
          <a
            href={DOWNLOAD_URL}
            download={BRIDGE_FILENAME}
            className="btn-primary flex shrink-0 items-center gap-2 px-6 py-3 text-base"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            {t('download.downloadBtn')}
          </a>
        </div>
      </div>

      {/* PLACEHOLDER_BODY */}
      {/* 桥接是什么 / what the bridge does */}
      <div className="glass mt-5 p-6">
        <h3 className="font-display text-lg font-semibold text-slate-100">
          {t('download.whatTitle')}
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">{t('download.whatDesc')}</p>
      </div>

      {/* 使用教程 / usage guide */}
      <div className="glass mt-5 p-6">
        <h3 className="mb-4 font-display text-lg font-semibold text-slate-100">
          {t('download.guideTitle')}
        </h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {guide.map((g, i) => (
            <div
              key={i}
              className="rounded-xl border border-white/10 bg-white/[0.03] p-4 transition hover:border-prism-600/30"
            >
              <div className="font-medium text-prism-300">{g.title}</div>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{g.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* 注意事项 / important notes */}
      <div className="glass mt-5 border-l-2 border-amber-400/50 p-6">
        <h3 className="mb-3 flex items-center gap-2 font-display text-lg font-semibold text-slate-100">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          {t('download.notesTitle')}
        </h3>
        <ul className="space-y-2.5">
          {notes.map((n, i) => (
            <li key={i} className="flex gap-2.5 text-sm text-slate-300">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400/70" />
              <span className="leading-relaxed">{n}</span>
            </li>
          ))}
        </ul>
      </div>

    </div>
  )
}
