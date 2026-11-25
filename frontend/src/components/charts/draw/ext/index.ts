// 第二批画线工具的总表：tools.ts 在第一批的 switch 之外按这里分派。
// Registry of the batch 2 drawing tools: tools.ts dispatches here for anything outside batch 1.
import type { ToolDefs } from './types'
import { CHANNELS } from './channels'
import { FIBS } from './fibs'
import { PATTERNS } from './patterns'
import { SHAPES } from './shapes'
import { NOTES } from './notes'

export const EXT: ToolDefs = { ...CHANNELS, ...FIBS, ...PATTERNS, ...SHAPES, ...NOTES }
export type { ToolDef, ToolDefs } from './types'
