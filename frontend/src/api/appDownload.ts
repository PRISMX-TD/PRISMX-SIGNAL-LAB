// 安卓 APK 直链。与桥接不同，APK 不走 releases/latest（那个位置归桥接），而是固定挂在
// tag 为 APP_RELEASE_TAG 的 Release 下：出新版时把同名资产覆盖上传即可，网页无需改代码：
//   gh release upload app-latest SignalLab.apk --clobber
// Android APK direct link. Unlike the bridge it can't use releases/latest (the bridge
// owns that slot), so it lives under a fixed APP_RELEASE_TAG Release: to ship a new
// build, re-upload the same-named asset with --clobber; no web change needed.
import { GITHUB_REPO } from './bridgeDownload'

export const APP_RELEASE_TAG = 'app-latest'
export const APP_FILENAME = 'SignalLab.apk'
export const APP_DOWNLOAD_URL = `${GITHUB_REPO}/releases/download/${APP_RELEASE_TAG}/${APP_FILENAME}`

// 已在 APK 里运行时不再展示下载入口。/ Hide the entry when already running inside the app.
export function isNativeApp(): boolean {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return !!cap?.isNativePlatform?.()
}
