// 云端偏好里的界面语言与本机的取舍规则，单拎出来便于测试（调用方见 store/prefs.tsx）。
// The rule deciding between the cloud prefs' UI language and the device's, kept pure
// for testing (caller: store/prefs.tsx).
import { isAppLang, type AppLang } from '../i18n'

export interface CloudLang {
  lang: AppLang
  /** 选择发生的时间；旧版本写的没有，记 0 / when chosen; 0 for older builds */
  at: number
}

export function readCloudLang(doc: Record<string, unknown> | null | undefined): CloudLang | null {
  const ns = doc?.lang as Record<string, unknown> | undefined
  const lang = ns?.lang
  if (!isAppLang(lang)) return null
  const at = typeof ns?.at === 'number' && Number.isFinite(ns.at) ? ns.at : 0
  return { lang, at }
}

/** 云端那份是否该覆盖本机：只有比本机新才覆盖；本机没存过语言时云端直接生效。
 *  两边都没时间戳（旧版本）时保留本机——宁可两台设备暂时不一致，也不能在用户没碰
 *  任何东西时换掉界面语言。
 *  Whether the cloud value should override the device: only when newer; with no local
 *  language the cloud wins outright. With no stamps on either side (older builds) the
 *  device wins — better two devices briefly disagreeing than the UI language changing
 *  while the user touched nothing. */
export function cloudLangWins(cloud: CloudLang | null, local: AppLang | null, localAt: number): boolean {
  if (!cloud) return false
  if (local === null) return true
  return cloud.at > localAt
}

/** 本机的选择是否比云端新、需要补存上去 / whether the device's choice is newer and must be pushed up */
export function localLangNewer(cloud: CloudLang | null, local: AppLang | null, localAt: number): boolean {
  return local !== null && localAt > (cloud?.at ?? 0)
}
