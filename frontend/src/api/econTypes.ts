// 财经日历（管理员第一期）的接口类型，对应 backend/app/routers/admin_econ.py。
// Economic-calendar admin API types, mirroring backend/app/routers/admin_econ.py.

export type EconSettings = {
  enabled: boolean
  previews: boolean
  countries: string[]
  previewMinImportance: number
  dailyLlmCap: number
}

export type EconStatus = {
  settings: EconSettings
  narwhalConfigured: boolean
  deepseekConfigured: boolean
  llmCallsToday: number
  status: {
    lastSyncAt?: string | null
    lastSyncCalls?: number
    lastSyncSeen?: number
    lastCheckAt?: string | null
    balance?: number | string | null
    lastError?: string | null
    lastErrorAt?: string | null
    llmCapHit?: string | null
  }
  releases: number
  previews: number
}

export type EconValue = {
  measure: string
  unit?: string | null
  transformation?: string | null
  actual?: number | string | null
  consensus?: number | string | null
  previous?: number | string | null
}

export type EconImpact = { asset: string; direction: 'bullish' | 'bearish' | 'neutral'; strength: 'strong' | 'medium' | 'weak' }
export type EconScenario = { impacts: EconImpact[]; reason_zh: string; reason_en: string }
export type EconOutcome = 'above' | 'inline' | 'below'

export type EconPreviewContent = {
  title_zh: string
  title_en: string
  why_zh: string
  why_en: string
  focus_zh: string
  focus_en: string
  names_zh: Record<string, string>
  scenarios: Record<EconOutcome, EconScenario>
}

export type EconGroup = {
  key: string
  country: string
  currency: string | null
  at: string | null
  date: string | null
  allDay: boolean
  indicative: boolean
  importance: number
  status: 'scheduled' | 'published' | 'cancelled'
  releases: { id: string; name: string; period: string | null; status: string; actualSeenAt: string | null }[]
  values: EconValue[]
  primaryMeasure: string | null
  outcome: { measure: string; actual: number | string; consensus: number | string; outcome: EconOutcome } | null
  preview: {
    status: 'ok' | 'failed'
    content: EconPreviewContent | null
    error: string | null
    attempts: number
    model: string | null
    generatedAt: string | null
    tokensIn: number | null
    tokensOut: number | null
  } | null
}
