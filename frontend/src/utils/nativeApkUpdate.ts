// App 内下载并安装新版 APK：只在安装包自带原生 SignalUpdate 插件时可用（APP Pack native/apkUpdate.ts，
// 1.0.5 起）。旧安装包里点下载，Capacitor 把 GitHub 链接整个交给系统浏览器，用户先看到 Chrome 的
// 「正在下载…」页再去通知栏点开安装；有了插件就在 App 里下、显示进度、下完直接调起系统安装界面。
// 包名与签名的校验在原生层做，这里只管跟插件对话、把结果折成页面状态。
// 没有插件（网页、旧安装包）一律拿不到 updater / 探针失败，页面照旧用那条链接。
// In-App download + install of a new APK, only when the shell ships the native SignalUpdate plugin
// (1.0.5+). Older shells hand the GitHub link to the system browser. Package and signature checks
// live in the native plugin; this module talks to it and folds the results into page state.
// Without the plugin (web, older APKs) there's no updater or the probe fails, and the page keeps its link.

export const APK_UPDATE_PLUGIN = 'SignalUpdate'

export interface ApkInfo { versionName: string; versionCode: number }
export interface ApkDownloadResult extends ApkInfo { currentVersionName: string; currentVersionCode: number }
type Progress = { loaded: number; total: number }

export interface ApkUpdater {
  info(): Promise<ApkInfo>
  download(o: { url: string }): Promise<ApkDownloadResult>
  install(): Promise<unknown>
  addListener(event: 'progress', cb: (d: Progress) => void): unknown
}

type Cap = {
  Plugins?: Record<string, unknown>
  nativePromise?: (plugin: string, method: string, options?: unknown) => Promise<unknown>
  addListener?: (plugin: string, event: string, cb: (d: unknown) => void) => unknown
}

// 优先用 Capacitor 注入的 Plugins.SignalUpdate；没有就用原生桥原语现造一个（APP Pack boot/plugin.ts
// 记过：有的机型上 Capacitor.Plugins 是空的）。调一个没装的插件会 reject，所以先 info() 探一下再用。
// Prefer the injected Plugins.SignalUpdate, else build one from the bridge primitives (Plugins can be
// empty on device, see APP Pack boot/plugin.ts). Calling a missing plugin rejects, so probe with info().
export function getApkUpdater(win: unknown = typeof window === 'undefined' ? undefined : window): ApkUpdater | null {
  let cap: Cap | undefined
  try {
    cap = (win as { Capacitor?: Cap } | undefined)?.Capacitor
  } catch {
    return null
  }
  if (!cap) return null
  const own = cap.Plugins?.[APK_UPDATE_PLUGIN] as ApkUpdater | undefined
  if (own && typeof own.download === 'function') return own
  if (typeof cap.nativePromise !== 'function' || typeof cap.addListener !== 'function') return null
  const c = cap as Required<Cap>
  return {
    info: () => c.nativePromise(APK_UPDATE_PLUGIN, 'info', {}) as Promise<ApkInfo>,
    download: (o) => c.nativePromise(APK_UPDATE_PLUGIN, 'download', o) as Promise<ApkDownloadResult>,
    install: () => c.nativePromise(APK_UPDATE_PLUGIN, 'install', {}),
    addListener: (event, cb) => c.addListener(APK_UPDATE_PLUGIN, event, cb as (d: unknown) => void),
  }
}

/** 插件真在这个安装包里就返回当前版本，否则 null。/ Current version if the plugin is really there. */
export async function probeApkUpdater(u: ApkUpdater): Promise<ApkInfo | null> {
  try {
    const info = await u.info()
    return info && typeof info.versionName === 'string' ? info : null
  } catch {
    return null
  }
}

export type ApkUpdateState =
  | { kind: 'idle' }
  | { kind: 'downloading'; percent: number | null }
  | { kind: 'opening' }
  | { kind: 'opened' }
  | { kind: 'upToDate'; version: string }
  | { kind: 'needPermission' }
  | { kind: 'failed'; reason: 'network' | 'package' | 'install' }

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code
const isBadPackage = (code: string | undefined) => code === 'BAD_PACKAGE' || code === 'SIGNATURE_MISMATCH'

async function removeListener(handle: unknown) {
  try {
    const h = (await handle) as { remove?: () => unknown } | null
    await h?.remove?.()
  } catch {
    /* 监听没挂上或已失效，忽略 / listener never attached or already gone */
  }
}

/** 已下好的包：调起系统安装界面（没允许「安装未知应用」时插件会先跳设置页）。 */
export async function installDownloaded(u: ApkUpdater, set: (s: ApkUpdateState) => void): Promise<void> {
  set({ kind: 'opening' })
  try {
    await u.install()
    set({ kind: 'opened' })
  } catch (e) {
    const code = codeOf(e)
    if (code === 'PERMISSION_DENIED') set({ kind: 'needPermission' })
    else if (code === 'NO_FILE') set({ kind: 'idle' })
    else set({ kind: 'failed', reason: isBadPackage(code) ? 'package' : 'install' })
  }
}

/** 下载 → 原生校验 → 比版本 → 比现在新才调起安装。/ Download, verify natively, install only if newer. */
export async function downloadAndInstall(u: ApkUpdater, url: string, set: (s: ApkUpdateState) => void): Promise<void> {
  set({ kind: 'downloading', percent: null })
  let settled = false
  let handle: unknown = null
  try {
    handle = await u.addListener('progress', (d) => {
      // 下载已经有结果后迟到的进度事件不能把状态拉回「下载中」。
      // A late progress event must not drag the state back to downloading.
      if (settled) return
      const percent = d && d.total > 0 ? Math.min(100, Math.floor((d.loaded * 100) / d.total)) : null
      set({ kind: 'downloading', percent })
    })
  } catch {
    handle = null
  }
  let res: ApkDownloadResult
  try {
    res = await u.download({ url })
  } catch (e) {
    settled = true
    set({ kind: 'failed', reason: isBadPackage(codeOf(e)) ? 'package' : 'network' })
    return
  } finally {
    settled = true
    void removeListener(handle)
  }
  if (!(res.versionCode > res.currentVersionCode)) {
    set({ kind: 'upToDate', version: res.currentVersionName })
    return
  }
  await installDownloaded(u, set)
}
