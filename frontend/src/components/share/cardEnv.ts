// 分享卡的数据层：把站内真实数据（平仓、勋章、月度、比赛）整理成模板要的形状。
// 模板（templates/*.ts）是从设计稿原样移植的字符串渲染器，读 env.data 里与设计稿
// 示例数据同构的字段；文案统一走 env.data.L（由 i18n 生成），勋章与二维码由 env.px 提供。
//
// Data layer for share cards: shapes real site data (closed trades, badges, monthly
// results, competitions) into what the templates expect. Templates are string renderers
// ported verbatim from the design mockup; they read fields shaped like the mockup's sample
// data, copy comes from env.data.L (built from i18n), medal and QR from env.px.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QRCodeSVG } from 'qrcode.react'
import type { TFunction } from 'i18next'
import { renderMedalInner } from '../badges/medal'
import { ORIGIN } from '../../seo/meta'
import { esc, type BadgeCard, type CardInput, type MonthCard } from './cardData'
export * from './cardData'

export interface CardEnv {
  data: Record<string, unknown>
  px: { medal(id: string, tier: number, size: number, key: string): string; qr(text: string, size: number, fg: string, bg: string): string }
}

const fmt = (v: number, d = 2, sign = true) =>
  (sign ? (v >= 0 ? '+' : '-') : (v < 0 ? '-' : '')) + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const price = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// 勋章材质色（与 medal.ts 的 inlay / rim 同源）/ medal material colours (same source as medal.ts)
const MATERIALS = {
  bronze: { inlay: '#DBA574', rim: ['#F3CBA3', '#C18A55', '#6B4322'] },
  silver: { inlay: '#D5D9E2', rim: ['#FFFFFF', '#BCC1CC', '#6C7282'] },
  gold: { inlay: '#F3D68F', rim: ['#FFF0B8', '#E4BE6A', '#8E6626'] },
  legend: { inlay: '#F3D68F', rim: ['#FFF0B8', '#E4BE6A', '#8E6626'] },
  limited: { inlay: '#D89A66', rim: ['#F0BE8C', '#B8763F', '#5E3419'] },
}

export const SHARE_LINK = `${ORIGIN}/`

function labels(t: TFunction, month?: MonthCard) {
  const k = (s: string) => t(`share.card.${s}`)
  // 月份标题直接用 Intl 按界面语言排（2026年9月 / September 2026 / tháng 9 năm 2026）；泰语强制公历。
  // Month title formatted by Intl in the UI language; Thai is forced to the Gregorian calendar.
  const monthLabel = month ? new Intl.DateTimeFormat(t('share.card.locale'), { year: 'numeric', month: 'long' }).format(new Date(month.year, month.month - 1, 1)) : ''
  return {
    ctaJoin: k('ctaJoin'), ctaComp: k('ctaComp'), invite: '', pips: k('pips'), hold: k('hold'), stopTag: k('stopTag'),
    winRate: k('winRate'), tradesUnit: k('tradesUnit'), ret: k('ret'), participantsUnit: k('participantsUnit'),
    rareBefore: k('rareBefore'), commonBefore: k('commonBefore'), rarityAfter: k('rarityAfter'),
    monthLabel,
  }
}

// 组装模板读取的数据对象：结构与设计稿 v3-data.js 一致，只放这一张卡用得到的部分。
// Build the object templates read: same shape as the mockup's v3-data.js, holding only this card's part.
export function buildEnvData(input: CardInput, t: TFunction, nickname: string) {
  const one = <T,>(v: T | undefined) => ({ win: v, loss: v })
  const L = labels(t, input.month)
  const comp = input.comp ? { ...input.comp, name: esc(input.comp.name) } : undefined
  const medals: Record<string, BadgeCard> = {}
  if (input.badge) medals[input.badge.id] = input.badge
  return {
    user: { name: esc(nickname), code: '', link: input.comp?.link ?? SHARE_LINK },
    trades: one(input.trade),
    month: () => input.month,
    medals, materials: MATERIALS, comp, fmt, price, L,
  }
}

export const px: CardEnv['px'] = {
  medal: (id, tier, size, key) => `<svg width="${size}" height="${size}" viewBox="0 0 64 64">${renderMedalInner(id, tier, size, key, { earned: true })}</svg>`,
  qr: (text, size, fg, bg) => renderToStaticMarkup(createElement(QRCodeSVG, { value: text, size, fgColor: fg, bgColor: bg, level: 'M', marginSize: 0 })),
}

