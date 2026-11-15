// 画布（lightweight-charts / canvas 2D）用的涨跌色。真源是 tokens.css 的 --up-canvas /
// --down-canvas：它们比卡片上的 --up / --down 饱和度更高，因为这两色画在 K 线上，要压得住
// 密集的实体与影线。canvas 的 fillStyle 解析不了 var()，所以模块加载时用 getComputedStyle
// 读一次 :root 上的值；读不到（vitest 跑在 node 里没有 document、样式表还没加载）或读到的
// 不是 #rrggbb，就退回下面的字面量，字面量必须与 tokens.css 保持一致。
// 这两个值同时是「绿涨红跌」K 线预设的取值，会被存进云端偏好 charts.candleColors：
// 改 tokens.css 里的值，老用户存下的预设会被 candleSchemeOf 认成 custom。
// Canvas up/down colours. The source of truth is --up-canvas / --down-canvas in
// tokens.css, deliberately more saturated than the card tokens because these lines
// sit on top of candles. Canvas fillStyle cannot parse var(), so the value is read
// once from :root with getComputedStyle at module load; with no document (vitest
// runs in node), no stylesheet yet, or anything but #rrggbb, the literal fallback is
// used, and it must match tokens.css. The values double as the green-up candle
// preset stored in the charts.candleColors preference, so changing them turns
// existing users' saved preset into "custom".
const HEX6 = /^#[0-9a-fA-F]{6}$/

export function readCanvasHex(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return HEX6.test(v) ? v : fallback
}

export const UP_COLOR = readCanvasHex('--up-canvas', '#2ee07e')
export const DOWN_COLOR = readCanvasHex('--down-canvas', '#ff4d67')
