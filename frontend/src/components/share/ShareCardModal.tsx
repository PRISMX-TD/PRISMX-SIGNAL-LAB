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
import { shareApi, userApi } from '../../api/client'
import { API_BASE } from '../../api/apiBase'
import { CARD_STYLES, DEFAULT_STYLE, buildEnvData, type CardInput, type CardStyle, type CardType } from './cardEnv'
import { BASE_CSS, CARD_H, CARD_W, exportCardPng, renderCardHtml } from './exportCard'
import { fitHero } from './fitHero'

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
    // 字体就绪后再量，免得按回退字体的宽度缩放 / measure once fonts are ready, not against fallback metrics
    let live = true
    const fit = () => { if (live) fitHero(root.querySelector('.sl-card')) }
    fit()
    document.fonts?.ready.then(fit)
    return () => { live = false }
  }, [css, html])
  return (
    <div style={{ width: CARD_W * scale, height: CARD_H * scale }} className="mx-auto">
      <div ref={ref} style={{ width: CARD_W, height: CARD_H, transform: `scale(${scale})`, transformOrigin: '0 0' }} />
    </div>
  )
}

const BTN = 'inline-flex h-12 items-center justify-center gap-2 rounded-full px-5 text-[15px] font-semibold tracking-wide transition active:scale-[0.97] disabled:cursor-wait disabled:opacity-70'
const PRIMARY = 'bg-prism-600 text-white shadow-[inset_0_1px_0_rgba(255,255,255,.18)] hover:bg-prism-500'
const SECONDARY = 'border border-white/15 bg-white/[0.04] text-neutral-100 hover:border-white/25 hover:bg-white/[0.08]'
const ico = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
const ShareIcon = () => <svg {...ico}><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" /><path d="M16 6l-4-4-4 4" /><path d="M12 2v13" /></svg>
const SaveIcon = () => <svg {...ico}><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M5 21h14" /></svg>
const Spinner = () => <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />

export default function ShareCardModal({ type, variants, enhance, onClose }: Props) {
  const { t, i18n } = useTranslation()
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
  // 生成好的图是否替换预览显示（点了保存之后才显示，便于长按保存）/ show the PNG in place of the preview after Save
  const [showImage, setShowImage] = useState(false)

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

  // 换了任何东西，之前生成的图就作废；随后在后台提前生成新图。iOS 的分享 / 下载要求「刚点过」的用户手势，
  // 点按钮时再花一秒生成，手势就过期了、按钮看起来没反应——所以预览一稳定就先生成好。
  // Any change invalidates the PNG, then a fresh one is pre-generated in the background: iOS share/download
  // need a fresh user gesture, and spending a second exporting after the tap expired it (the "nothing happens" bug).
  useEffect(() => {
    setResult(null); setError(false); setShowImage(false)
    let live = true
    const id = setTimeout(() => {
      exportCardPng(card.css, card.html)
        .then((blob) => { if (live) setResult({ url: URL.createObjectURL(blob), blob }) })
        .catch((e) => { console.error('share card pre-export failed', e) })
    }, 350)
    return () => { live = false; clearTimeout(id) }
  }, [card])

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

  // App 外壳（Capacitor WebView）没有下载与系统分享能力，需要原生插件，要等新安装包；这里先给出明确提示。
  // iOS 主屏幕 PWA 不支持 <a download>，保存走系统分享面板（面板里有「存储图像」），并把图显示出来可长按保存。
  // The App shell (Capacitor WebView) has neither downloads nor Web Share — that needs a native plugin and a new
  // APK; show a clear hint meanwhile. iOS home-screen PWAs ignore <a download>, so Save goes through the share
  // sheet (which offers "Save Image") and the PNG is shown so it can be long-pressed.
  const isNativeApp = !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.()
  // App 里两个按钮都走保存页（那里能下载也能分享）/ in the App both buttons go to the save page
  const showShare = canShareFiles || isNativeApp
  const isIos = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  const shareFile = async (r: { blob: Blob }) => {
    try { await navigator.share({ files: [file(r.blob)] }); return true } catch (e) { return (e as DOMException)?.name === 'AbortError' }
  }
  // App 里：图传到后端，换一个保存 / 分享页，用系统浏览器（Capacitor Browser，Chrome Custom Tab）打开，
  // 那里能直接下载到手机，也能调起系统分享。同一张图只传一次。
  // In the App: upload the PNG, get a save/share page and open it in the system browser (Capacitor Browser =
  // Chrome Custom Tab), which can download to the phone and open the system share sheet. One upload per image.
  const relayRef = useRef<{ blob: Blob; url: string } | null>(null)
  const openInBrowser = async (r: { blob: Blob }, mode: 'save' | 'share') => {
    setBusy(true); setError(false)
    try {
      if (relayRef.current?.blob !== r.blob) {
        const { path } = await shareApi.uploadImage(r.blob)
        const lang = (i18n.language || 'zh').slice(0, 2)
        relayRef.current = { blob: r.blob, url: `${API_BASE || location.origin}/api${path}?lang=${['zh', 'en', 'ja', 'th', 'vi'].includes(lang) ? lang : 'en'}` }
      }
      // 保存：直接打开图片附件地址，系统浏览器交给下载管理器存到手机，随后把这个空白标签关掉；
      // 分享：打开保存页（Web Share 需要一个页面）。
      // Save: open the image's attachment URL so the system browser hands it to the download manager, then close
      // the blank tab. Share: open the page (Web Share needs one).
      const page = relayRef.current.url
      const url = mode === 'save' ? page.replace(/\?lang=.*$/, '') + '.png?dl=1' : page
      const cap = (window as unknown as { Capacitor?: { Plugins?: { Browser?: { open(o: { url: string }): Promise<void>; close(): Promise<void> } } } }).Capacitor
      const browser = cap?.Plugins?.Browser
      if (browser) {
        await browser.open({ url })
        if (mode === 'save') setTimeout(() => { browser.close().catch(() => {}) }, 2500)
      } else window.open(url, '_blank')
    } catch (e) {
      console.error('share relay failed', e)
      setError(true)
    } finally { setBusy(false) }
  }
  // 新安装包自带原生 SignalImage 插件（APP Pack native/imageShare.ts）：直接存进相册 / 调起系统分享，
  // 不跳出 App。旧安装包没有这个插件，Android 9 及以下 save 会 reject UNSUPPORTED，都退回浏览器那条路。
  // New APKs ship the native SignalImage plugin: save straight to the gallery / open the system share sheet
  // without leaving the App. Older APKs lack it, and Android 9- rejects save with UNSUPPORTED; both fall back.
  type NativeImage = { save(o: { base64: string; fileName?: string }): Promise<unknown>; share(o: { base64: string; fileName?: string }): Promise<unknown> }
  const nativeImage = (window as unknown as { Capacitor?: { Plugins?: { SignalImage?: NativeImage } } }).Capacitor?.Plugins?.SignalImage
  const [notice, setNotice] = useState<string | null>(null)
  useEffect(() => { if (!notice) return; const id = setTimeout(() => setNotice(null), 2500); return () => clearTimeout(id) }, [notice])
  const toBase64 = (b: Blob) => new Promise<string>((res, rej) => {
    const fr = new FileReader(); fr.onload = () => res(String(fr.result)); fr.onerror = () => rej(fr.error); fr.readAsDataURL(b)
  })
  const nativeDo = async (r: { blob: Blob }, op: 'save' | 'share'): Promise<boolean> => {
    if (!nativeImage) return false
    setBusy(true); setError(false)
    try {
      const base64 = await toBase64(r.blob)
      await nativeImage[op]({ base64, fileName: fileName.replace(/.png$/, '') })
      if (op === 'save') setNotice(t('share.saved'))
      return true
    } catch (e) {
      const code = (e as { code?: string })?.code
      if (code === 'UNSUPPORTED') return false
      console.error('native image op failed', e)
      return false
    } finally { setBusy(false) }
  }
  const onShare = async () => {
    const r = await generate()
    if (!r) return
    if (isNativeApp) { if (!(await nativeDo(r, 'share'))) await openInBrowser(r, 'share'); return }
    await shareFile(r)
  }
  const onSave = async () => {
    const r = await generate()
    if (!r) return
    if (isNativeApp) { if (!(await nativeDo(r, 'save'))) await openInBrowser(r, 'save'); return }
    setShowImage(true)
    if (canShareFiles && isIos) { await shareFile(r); return }
    const a = document.createElement('a')
    a.href = r.url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  // 挂载瞬间 innerWidth 可能读到 0（WebView 冷启动、隐藏标签），夹在 0.6 到 1 之间，免得算出负缩放。
  // innerWidth can read 0 at mount (WebView cold start, hidden tab); clamp so the scale never goes negative.
  const scale = Math.max(0.6, Math.min(1, (Math.min(window.innerWidth || 480, 480) - 64) / CARD_W))

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
          {result && showImage
            ? <img src={result.url} alt={t(`share.title.${type}`)} className="mx-auto block rounded-[22px]" style={{ width: CARD_W * scale, height: CARD_H * scale }} />
            : <CardPreview css={card.css} html={card.html} scale={scale} />}
        </div>
        {result && showImage && <p className="mt-2 text-center text-xs text-neutral-400">{t('share.longPress')}</p>}

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
        {notice && <p className="mt-3 text-center text-sm text-up" role="status">{notice}</p>}

        {/* 操作区：两个等高胶囊按钮。能系统分享时「分享」是主按钮（品牌紫实底），「保存」是描边次按钮；
            不能分享（桌面、部分 WebView）时只剩「保存」，升为主按钮。生成中按钮内转圈，按下有回弹。
            Actions: two equal-height pills. With system share available, Share is primary (solid violet)
            and Save is an outlined secondary; without it Save alone becomes primary. */}
        <div className="mt-5 grid gap-3" style={{ gridTemplateColumns: showShare ? '1fr 1fr' : '1fr' }}>
          {showShare && (
            <button type="button" onClick={onShare} disabled={busy} className={`${BTN} ${PRIMARY}`}>
              {busy ? <Spinner /> : <ShareIcon />}
              {busy ? t('share.generating') : t('share.share')}
            </button>
          )}
          <button type="button" onClick={onSave} disabled={busy} className={`${BTN} ${showShare ? SECONDARY : PRIMARY}`}>
            {busy && !showShare ? <Spinner /> : <SaveIcon />}
            {busy && !showShare ? t('share.generating') : t('share.save')}
          </button>
        </div>

      </div>
    </div>,
    document.body,
  )
}
