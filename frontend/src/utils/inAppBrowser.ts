// 社交 App 内置浏览器（Facebook / Messenger / Instagram / 微信 / LINE / 通用安卓 WebView）。
// Google 对这些 WebView 的登录请求直接拒绝（disallowed_useragent），按钮点了也只会报错；
// 比赛推广流量恰好主要来自这些 App，所以登录页在这里藏掉 Google 按钮、提示去浏览器打开。
// 我们自己的安卓 App（Capacitor）UA 里同样有 `; wv)`，但它有原生 Credential Manager 桥，
// 必须排除——判据与 store/netQuality.ts、utils/clientErrorReport.ts 一致。
// Social in-app browsers (Facebook / Messenger / Instagram / WeChat / LINE / generic Android
// WebView). Google refuses sign-in inside them (disallowed_useragent), and promo traffic comes
// mostly from these apps, so the login page hides the Google button here and points to a real
// browser. Our own Android app (Capacitor) also carries `; wv)` but has a native Credential
// Manager bridge and is excluded — same probe as store/netQuality.ts.
const IN_APP_UA = /FBAN|FBAV|FB_IAB|Instagram|MicroMessenger|\bLine\/|; wv\)/

export function isInAppBrowserUA(ua: string | null | undefined): boolean {
  return !!ua && IN_APP_UA.test(ua)
}

export function isNativeApp(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
    return !!cap?.isNativePlatform?.()
  } catch {
    return false
  }
}

export function isInAppBrowser(): boolean {
  if (typeof navigator === 'undefined' || isNativeApp()) return false
  return isInAppBrowserUA(navigator.userAgent)
}
