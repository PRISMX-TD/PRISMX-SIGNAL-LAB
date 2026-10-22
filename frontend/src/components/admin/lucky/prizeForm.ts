// 奖项编辑表的行状态 ⇄ 接口入参。数字字段在输入框里是字符串，保存时才换算。
// 校验与后端 services/lucky/odds.validate 同规则，只为提前提示；保存时仍以后端为准。
// Prize editor row state <-> API payload. Numeric fields are strings while typing and only converted
// on save. Validation mirrors the backend's odds.validate purely as an early hint; the backend
// remains the final authority.
import type { LuckyClaimMode, LuckyPrizeAdmin, LuckyPrizeInput, LuckyPrizeKind, LuckySoldOut } from '../../../api/luckyTypes'

export interface PrizeRow {
  key: string; id?: string; name: string; description: string; imageUrl: string; color: string
  kind: LuckyPrizeKind; proDays: string; probPct: string; stock: string; perUserLimit: string
  onSoldOut: LuckySoldOut; claimMode: LuckyClaimMode | ''; claimHint: string; stockUsed: number
}

let seq = 0
export const blankRow = (kind: LuckyPrizeKind = 'none'): PrizeRow => ({
  key: `new-${++seq}`, name: '', description: '', imageUrl: '', color: '', kind, proDays: '', probPct: '0',
  stock: '', perUserLimit: '', onSoldOut: 'to_fallback', claimMode: '', claimHint: '', stockUsed: 0,
})

export const fromAdmin = (p: LuckyPrizeAdmin): PrizeRow => ({
  key: p.id, id: p.id, name: p.name, description: p.description ?? '', imageUrl: p.imageUrl ?? '',
  color: p.color ?? '', kind: p.kind, proDays: p.proDays ? String(p.proDays) : '', probPct: String(p.probBp / 100),
  stock: p.stock == null ? '' : String(p.stock), perUserLimit: p.perUserLimit == null ? '' : String(p.perUserLimit),
  onSoldOut: p.onSoldOut, claimMode: p.claimMode ?? '', claimHint: p.claimHint ?? '', stockUsed: p.stockUsed,
})

const num = (s: string) => (s.trim() === '' ? null : Number(s))
const bp = (s: string) => Math.round((Number(s) || 0) * 100)
export const totalPct = (rows: PrizeRow[]) => rows.reduce((a, r) => a + bp(r.probPct), 0) / 100

export function problems(rows: PrizeRow[]): string[] {
  const out = new Set<string>()
  if (rows.length < 2 || rows.length > 12) out.add('admin.lucky.err.slots')
  if (rows.reduce((a, r) => a + bp(r.probPct), 0) !== 10000) out.add('admin.lucky.err.total')
  for (const r of rows) {
    if (!r.name.trim()) out.add('admin.lucky.err.name')
    if (r.kind === 'pro_days' && !(Number(r.proDays) >= 1 && Number(r.proDays) <= 3650)) out.add('admin.lucky.err.days')
    if (r.kind === 'custom' && !r.claimMode) out.add('admin.lucky.err.claimMode')
    if (r.kind === 'none' && (r.stock !== '' || r.perUserLimit !== '')) out.add('admin.lucky.err.noneLimited')
    if (r.stock !== '' && Number(r.stock) < r.stockUsed) out.add('admin.lucky.err.stockBelowUsed')
  }
  const needsFallback = rows.some((r) => (r.stock !== '' || r.perUserLimit !== '') && r.onSoldOut === 'to_fallback')
  if (needsFallback && !rows.some((r) => r.kind === 'none')) out.add('admin.lucky.err.fallback')
  return [...out]
}

export const toInput = (rows: PrizeRow[]): LuckyPrizeInput[] => rows.map((r) => ({
  ...(r.id ? { id: r.id } : {}),
  name: r.name.trim(), description: r.description.trim() || null, imageUrl: r.imageUrl || null,
  color: /^#[0-9a-fA-F]{6}$/.test(r.color) ? r.color : null, kind: r.kind,
  proDays: r.kind === 'pro_days' ? num(r.proDays) : null, probPct: bp(r.probPct) / 100,
  stock: num(r.stock), perUserLimit: num(r.perUserLimit), onSoldOut: r.onSoldOut,
  claimMode: r.kind === 'custom' ? (r.claimMode || null) : null,
  claimHint: r.kind === 'custom' ? r.claimHint.trim() || null : null,
}))
