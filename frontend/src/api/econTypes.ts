// 财经日历（管理员第一期）的接口类型，对应 backend/app/routers/admin_econ.py。
// Economic-calendar admin API types, mirroring backend/app/routers/admin_econ.py.

export type EconSettings = {
  enabled: boolean
  previews: boolean
  countries: string[]
  previewMinImportance: number
  dailyLlmCap: number
  /** 对用户开放 / open to users */
  public: boolean
  /** 红色数据公布前 30 分钟推送（rev 54）/ push 30 min before red releases */
  alerts: boolean
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
    /** 管理员手动生成整周预案的进度 / progress of the admin week generation */
    weekJob?: {
      running: boolean
      total?: number
      done?: number
      failed?: number
      capHit?: boolean
      error?: string
    } | null
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
  /** 这一项自己的重要度（0–3）/ this figure's own importance */
  importance?: number
}

export type EconImpact = {
  asset: string
  direction: 'bullish' | 'bearish' | 'neutral'
  strength: 'strong' | 'medium' | 'weak'
}
export type EconScenario = {
  impacts: EconImpact[]
  reason_zh: string
  reason_en: string
}
export type EconOutcome = 'above' | 'inline' | 'below'

export type EconPreviewContent = {
  title_zh: string
  title_en: string
  why_zh: string
  why_en: string
  focus_zh: string
  focus_en: string
  background_zh?: string
  background_en?: string
  watch_zh?: string
  watch_en?: string
  names_zh: Record<string, string>
  scenarios: Record<EconOutcome, EconScenario>
  /** 情景比较对象：预期值 / 前值 / 无数值（鹰鸽）/ what the scenarios compare against */
  basis?: 'consensus' | 'previous' | 'none'
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
  releases: {
    name: string
    period: string | null
    /** 以下只有管理接口带 / admin endpoint only */
    id?: string
    status?: string
    actualSeenAt?: string | null
  }[]
  values: EconValue[]
  primaryMeasure: string | null
  outcome: {
    measure: string
    actual: number | string
    consensus: number | string
    outcome: EconOutcome
    basis?: 'consensus' | 'previous'
  } | null
  preview: {
    status: 'ok' | 'failed'
    content: EconPreviewContent | null
    /** 以下只有管理接口带 / admin endpoint only */
    error?: string | null
    attempts?: number
    model?: string | null
    generatedAt?: string | null
    tokensIn?: number | null
    tokensOut?: number | null
  } | null
}
