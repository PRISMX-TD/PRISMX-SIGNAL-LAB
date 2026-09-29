// /api/bootstrap 响应里取一段：该段为 null / 缺失 / 列在 failed 里都算失败（返回 null，调用方回退逐个请求）。
// Pick one section of a /api/bootstrap response; null, missing or listed in `failed` counts as failed
// (returns null so the caller falls back to the individual request).
import type { BootstrapResponse } from '../api/client'

export type BootstrapKey = 'signals' | 'accounts' | 'trends' | 'quotes' | 'symbols'

export function pickBootstrapSection<K extends BootstrapKey>(
  b: BootstrapResponse,
  key: K,
): NonNullable<BootstrapResponse[K]> | null {
  if (Array.isArray(b.failed) && b.failed.includes(key)) return null
  const v = b[key]
  return (v ?? null) as NonNullable<BootstrapResponse[K]> | null
}
