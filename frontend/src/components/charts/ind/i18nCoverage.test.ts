import { it, expect } from 'vitest'
import zh from '../../../i18n/zh.more.json'
import { IND_DEFS } from './registry'
it('每个指标的名称、说明、参数、图形、选项都有文案', () => {
  const ind = (zh as unknown as { charts: { ind: Record<string, Record<string, string>> } }).charts.ind
  const miss: string[] = []
  for (const d of IND_DEFS.values()) {
    if (!ind.name[d.id]) miss.push('name.' + d.id)
    if (!ind.desc[d.id]) miss.push('desc.' + d.id)
    for (const i of d.inputs) if (!ind.in[i.key]) miss.push('in.' + i.key)
    for (const p of d.plots) if (!ind.plot[p.label]) miss.push('plot.' + p.label)
    for (const f of d.fills ?? []) if (!ind.plot[f.label]) miss.push('plot.' + f.label)
    for (const i of d.inputs) if (i.kind === 'select') for (const o of i.options) if (!ind.opt[o]) miss.push('opt.' + o)
  }
  expect([...new Set(miss)]).toEqual([])
})
