// 分享卡弹层：选风格（默认「信号」，记住上次的选择）、可选隐藏金额、预览，然后导出 PNG
// 分享或保存。预览放在 Shadow DOM 里，和导出走同一份底样式，所见即所得。
// 这个文件连同四套模板是按需加载的（调用点用 React.lazy），不进入口包。
//
// Share-card sheet: pick a style (default 信号 / Signal, remembers the last choice), optionally
// hide amounts, preview, then export a PNG to share or save. The preview lives in a Shadow DOM
// with the same base CSS as the export, so what you see is what you get. This file and the
// four templates are lazy-loaded (callers use React.lazy) and stay out of the entry bundle.
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useDialogA11y } from '../../utils/useDialogA11y'
import { userApi } from '../../api/client'
import { CARD_STYLES, DEFAULT_STYLE, buildEnvData, type CardInput, type CardStyle, type CardType } from './cardEnv'
import { BASE_CSS, CARD_H, CARD_W, exportCardPng, renderCardHtml } from './exportCard'

export interface ShareVariant { key: string; label: string; input: CardInput }

interface Props {
  type: CardType
  variants: ShareVariant[]
  // 可选：异步补全数据（例如拉 K 线画单笔的信号曲线），拿到前先用 variants 里的数据预览。
  // Optional async enrichment (e.g. candles for the trade's signal line); the preview uses variants until it lands.
  enhance?: (input: CardInput) => Promise<CardInput>
  onClose: () => void
}

const STYLE_KEY = 'prismx.share.style'
function readStyle(): CardStyle {
  try {
    const v = localStorage.getItem(STYLE_KEY) as CardStyle | null
    return v && CARD_STYLES.includes(v) ? v : DEFAULT_STYLE
  } catch { return DEFAULT_STYLE }
}

// 昵称一次会话只取一次 / the nickname is fetched once per session
let nicknameP: Promise<string> | null = null
function loadNickname(): Promise<string> {
  nicknameP ??= userApi.me().then((u) => u.nickname || u.email.split('@')[0]).catch(() => { nicknameP = null; return '' })
  return nicknameP
}

function CardPreview({ css, html, scale }: { css: string; html: string; scale: number }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const root = el.shadowRoot ?? el.attachShadow({ mode: 'open' })
    root.innerHTML = `<style>${BASE_CSS}${css}</style>${html}`
  }, [css, html])
  return (
    <div style={{ width: CARD_W * scale, height: CARD_H * scale }} className="mx-auto">
      <div ref={ref} style={{ width: CARD_W, height: CARD_H, transform: `scale(${scale})`, transformOrigin: '0 0' }} />
    </div>
  )
}

export default function ShareCardModal({ type, variants, enhance, onClose }: Props) {
  const { t } = useTranslation()
  const sheetRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const keyId = useId().replace(/[^a-zA-Z0-9]/g, '')
  useDialogA11y(sheetRef, onClose)

  const [style, setStyle] = useState<CardStyle>(readStyle)
  const [variantKey, setVariantKey] = useState(variants[0]?.key)
  const [privacy, setPrivacy] = useState(false)
  const [nickname, setNickname] = useState('')
  const [enhanced, setEnhanced] = useState<Record<string, CardInput>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [result, setResult] = useState<{ url: string; blob: Blob } | null>(null)

  useEffect(() => { loadNickname().then(setNickname) }, [])
  const variant = variants.find((v) => v.key === variantKey) ?? variants[0]
  useEffect(() => {
    if (!enhance || !variant || enhanced[variant.key]) return
    let live = true
    enhance(variant.input).then((inp) => { if (live) setEnhanced((m) => ({ ...m, [variant.key]: inp })) }).catch(() => {})
    return () => { live = false }
  }, [enhance, variant, enhanced])
  useEffect(() => () => { if (result) URL.revokeObjectURL(result.url) }, [result])

  const input = (variant && enhanced[variant.key]) || variant?.input || {}
  const value = type === 'A' ? input.trade?.pnl : type === 'C' ? input.month?.total : 1
  const privacyAvailable = type === 'A' ? input.trade?.pct != null : type === 'C' ? input.month?.pct != null : false

  const card = useMemo(() => {
    const data = buildEnvData(input, t, nickname)
    return renderCardHtml(style, type, data, {
      mode: (value ?? 0) >= 0 ? 'win' : 'loss',
      privacy: privacy && privacyAvailable,
      medal: input.badge?.id ?? '',
      key: `sc${keyId}`,
    })
  }, [input, t, nickname, style, type, value, privacy, privacyAvailable, keyId])

  // 换了任何东西，之前生成的图就作废 / any change invalidates the exported image
  useEffect(() => { setResult(null); setError(false) }, [card])

  const pickStyle = (s: CardStyle) => {
    setStyle(s)
    try { localStorage.setItem(STYLE_KEY, s) } catch { /* 隐私模式下写不进去，忽略 / ignore in private mode */ }
  }

  const fileName = `signal-lab-${type.toLowerCase()}-${Date.now()}.png`
  const generate = async () => {
    if (result) return result
    setBusy(true); setError(false)
    try {
      const blob = await exportCardPng(card.css, card.html)
      const r = { url: URL.createObjectURL(blob), blob }
      setResult(r)
      return r
    } catch (e) {
      console.error('share card export failed', e)
      setError(true)
      return null
    } finally { setBusy(false) }
  }
  const file = (b: Blob) => new File([b], fileName, { type: 'image/png' })
  const canShareFiles = typeof navigator !== 'undefined' && !!navigator.canShare &&
    (() => { try { return navigator.canShare({ files: [new File([], 'x.png', { type: 'image/png' })] }) } catch { return false } })()

  const onShare = async () => {
    const r = await generate()
    if (!r) return
    try { await navigator.share({ files: [file(r.blob)] }) } catch { /* 用户取消 / user cancelled */ }
  }
  const onSave = async () => {
    const r = await generate()
    if (!r) return
    const a = document.createElement('a')
    a.href = r.url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const scale = Math.min(1, (Math.min(window.innerWidth, 480) - 64) / CARD_W)

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center overflow-y-auto bg-black/70 p-4 backdrop-blur-sm"
      // 弹层可能叠在别的弹层里（勋章详情）：React 事件会沿组件树冒泡穿过 portal，这里截住，免得连底下那层一起关掉。
      // May be stacked inside another modal (badge detail): React events bubble through portals, so stop here.
      onClick={(e) => { e.stopPropagation(); onClose() }}>
      <div
        ref={sheetRef}
        className="glass-card relative my-auto w-full max-w-md p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <button type="button" onClick={onClose} aria-label={t('share.close')}
          className="absolute right-4 top-3 text-2xl leading-none text-neutral-400 transition hover:text-neutral-200">×</button>
        <h3 id={titleId} className="mb-4 pr-8 font-display text-lg font-bold text-white">{t(`share.title.${type}`)}</h3>

        {variants.length > 1 && (
          <div className="mb-3 flex gap-2" role="group">
            {variants.map((v) => (
              <button key={v.key} type="button" aria-pressed={v.key === variant?.key} onClick={() => setVariantKey(v.key)}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold transition ${v.key === variant?.key ? 'bg-prism-600 text-white' : 'bg-white/5 text-neutral-300 hover:bg-white/10'}`}>
                {v.label}
              </button>
            ))}
          </div>
        )}

        <div className="relative">
          {result
            ? <img src={result.url} alt={t(`share.title.${type}`)} className="mx-auto block rounded-[22px]" style={{ width: CARD_W * scale, height: CARD_H * scale }} />
            : <CardPreview css={card.css} html={card.html} scale={scale} />}
        </div>
        {result && <p className="mt-2 text-center text-xs text-neutral-400">{t('share.longPress')}</p>}

        <div className="mt-4">
          <div className="mb-2 text-xs text-neutral-400">{t('share.style')}</div>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('share.style')}>
            {CARD_STYLES.map((s) => (
              <button key={s} type="button" aria-pressed={s === style} onClick={() => pickStyle(s)}
                className={`rounded-full px-3.5 py-1.5 text-xs font-semibold transition ${s === style ? 'bg-prism-600 text-white' : 'bg-white/5 text-neutral-300 hover:bg-white/10'}`}>
                {t(`share.styles.${s}`)}
              </button>
            ))}
          </div>
        </div>

        {privacyAvailable && (
          <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
            <input type="checkbox" checked={privacy} onChange={(e) => setPrivacy(e.target.checked)} className="h-4 w-4 accent-[rgb(var(--purple-rgb))]" />
            {t('share.privacy')}
          </label>
        )}

        {error && <p className="mt-3 text-sm text-down" role="alert">{t('share.failed')}</p>}

        <div className="mt-5 flex gap-3">
          {canShareFiles && (
            <button type="button" onClick={onShare} disabled={busy} className="btn-primary flex-1 disabled:opacity-60">
              {busy ? t('share.generating') : t('share.share')}
            </button>
          )}
          <button type="button" onClick={onSave} disabled={busy} className={`${canShareFiles ? 'btn-ghost' : 'btn-primary'} flex-1 disabled:opacity-60`}>
            {busy && !canShareFiles ? t('share.generating') : t('share.save')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
