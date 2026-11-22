// 交易人格的静态资料：16 个代号、四个家族的颜色、插画路径、画风开关（记在本机）。
// 文案（称号、点评、主轴说明）在 i18n 的 persona.* 下，这里只放与语言无关的东西。
// Static persona data: the 16 codes, family colours, art paths and the remembered style switch.
// Copy (titles, roasts, axis notes) lives under persona.* in i18n.
import type { PersonaAxisKey, PersonaFamily } from '../../api/personaTypes'
import { readStorage, writeStorage } from '../../utils/safeStorage'

export const PERSONA_CODES = [
  'AGLZ', 'AGLM', 'AGQZ', 'AGQM', 'AXLZ', 'AXLM', 'AXQZ', 'AXQM',
  'RGLZ', 'RGLM', 'RGQZ', 'RGQM', 'RXLZ', 'RXLM', 'RXQZ', 'RXQM',
] as const

export const FAMILY_OF: Record<string, PersonaFamily> = { AG: 'strategist', AX: 'maverick', RG: 'executor', RX: 'chaser' }

// 与插画同一套家族色（scripts/persona-art/personas.mjs 的 FAM.main / dark）。
// Same family colours as the art (FAM.main / dark in scripts/persona-art/personas.mjs).
export const FAMILY_COLOR: Record<PersonaFamily, { main: string; dark: string; deep: string }> = {
  strategist: { main: '#4F7BEA', dark: '#2F52B8', deep: '#16224C' },
  maverick: { main: '#EA5D47', dark: '#B5392A', deep: '#3A1410' },
  executor: { main: '#31B592', dark: '#1D856A', deep: '#0C2A22' },
  chaser: { main: '#EDA63C', dark: '#B9781B', deep: '#33230A' },
}

export const familyOf = (code: string): PersonaFamily => FAMILY_OF[code.slice(0, 2)] ?? 'strategist'

// 主轴的两端：值 ≥ 50 → 第二个字母。/ Each axis' poles; at or above 50 → the second letter.
export const AXES: { key: PersonaAxisKey; poles: [string, string] }[] = [
  { key: 'judge', poles: ['A', 'R'] },
  { key: 'risk', poles: ['X', 'G'] },
  { key: 'tempo', poles: ['L', 'Q'] },
  { key: 'manage', poles: ['Z', 'M'] },
]

export type ArtStyle = 'voxel' | 'poster'
const STYLE_KEY = 'prismx.persona.artStyle'

export function readArtStyle(): ArtStyle {
  return readStorage(STYLE_KEY) === 'poster' ? 'poster' : 'voxel'
}
export function writeArtStyle(s: ArtStyle) {
  writeStorage(STYLE_KEY, s)
}

export const artUrl = (code: string, style: ArtStyle) =>
  style === 'poster' ? `/persona-art/poster/${code}.svg` : `/persona-art/voxel/${code}.webp`
