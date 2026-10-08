// 社交 App 内置浏览器识别：这些 WebView 里 Google 登录（GIS / FedCM）会被 Google 拒绝，
// 登录页要藏掉按钮并提示「在浏览器中打开」。我们自己的 Capacitor App 也是带 `; wv)`
// 的 WebView，但它有原生 Google 桥，绝不能被算进去。jsdom 未安装，window/navigator 用桩。
// Social in-app browser detection: Google sign-in is refused inside these WebViews, so the
// login page hides the button and says "open in browser". Our own Capacitor app is also a
// `; wv)` WebView but has a native Google bridge and must never match. No jsdom.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isInAppBrowser, isInAppBrowserUA, isNativeApp } from './inAppBrowser'

const UA = {
  fbIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBDV/iPhone14,2;FBMD/iPhone;FBSN/iOS;FBSV/17.0;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]',
  fbAndroid: 'Mozilla/5.0 (Linux; Android 13; SM-S911B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.5993.80 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/437.0.0.33.118;]',
  messenger: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 FBAV/430.0.0.30.110',
  instagram: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 305.0.0.34.110 (iPhone14,5; iOS 17_1; en_US; en)',
  wechat: 'Mozilla/5.0 (Linux; Android 12; V2134A Build/SP1A.210812.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/107.0.5304.141 Mobile Safari/537.36 XWEB/5023 MMWEBSDK/20230701 MMWEBID/1234 MicroMessenger/8.0.40.2420(0x28002837) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64',
  wechatIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.42(0x18002a2c) NetType/WIFI Language/zh_CN',
  line: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/13.18.0',
  androidWebView: 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.0.0 Mobile Safari/537.36',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Mobile Safari/537.36',
  safariIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  chromeDesktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  edgeDesktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  lowercaseLine: 'SomeBot/1.0 (+https://example.com) Online/2.0 Pipeline/3.1',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isInAppBrowserUA', () => {
  it.each([
    ['fbIos', UA.fbIos],
    ['fbAndroid', UA.fbAndroid],
    ['messenger', UA.messenger],
    ['instagram', UA.instagram],
    ['wechat', UA.wechat],
    ['wechatIos', UA.wechatIos],
    ['line', UA.line],
    ['androidWebView', UA.androidWebView],
  ])('flags %s', (_name, ua) => {
    expect(isInAppBrowserUA(ua)).toBe(true)
  })

  it.each([
    ['chromeAndroid', UA.chromeAndroid],
    ['safariIos', UA.safariIos],
    ['chromeDesktop', UA.chromeDesktop],
    ['edgeDesktop', UA.edgeDesktop],
    ['lowercaseLine', UA.lowercaseLine],
    ['empty', ''],
  ])('does not flag %s', (_name, ua) => {
    expect(isInAppBrowserUA(ua)).toBe(false)
  })

  it('handles null / undefined', () => {
    expect(isInAppBrowserUA(null)).toBe(false)
    expect(isInAppBrowserUA(undefined)).toBe(false)
  })
})

describe('isNativeApp / isInAppBrowser', () => {
  it('our Capacitor app is never an in-app browser even with a ; wv) UA', () => {
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } })
    vi.stubGlobal('navigator', { userAgent: UA.androidWebView })
    expect(isNativeApp()).toBe(true)
    expect(isInAppBrowser()).toBe(false)
  })

  it('a Facebook WebView without Capacitor is', () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { userAgent: UA.fbAndroid })
    expect(isNativeApp()).toBe(false)
    expect(isInAppBrowser()).toBe(true)
  })

  it('Capacitor web build (isNativePlatform false) is treated as web', () => {
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => false } })
    vi.stubGlobal('navigator', { userAgent: UA.chromeAndroid })
    expect(isNativeApp()).toBe(false)
    expect(isInAppBrowser()).toBe(false)
  })

  it('a throwing Capacitor probe counts as not native', () => {
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => { throw new Error('x') } } })
    expect(isNativeApp()).toBe(false)
  })
})
