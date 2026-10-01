// 四套分享卡风格的注册表。每次渲染用当次的数据新建一个模板实例（模板是纯函数，开销很小）。
// Registry of the four share-card styles. A template instance is created per render with that render's data.
import type { CardStyle, CardTemplate } from '../cardEnv'
import { px } from '../cardEnv'
import scope from './scope'
import eldark from './eldark'
import tidark from './tidark'
import lpdark from './lpdark'

const FACTORIES = { scope, eldark, tidark, lpdark }

export function createCard(style: CardStyle, data: Record<string, unknown>): CardTemplate {
  return (FACTORIES[style] ?? scope)({ data, px })
}
