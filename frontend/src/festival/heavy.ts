// 节日层的「重」部分 / the heavy half of the festival layer
//
// 插画（art）、挂件（decor）、粒子（particles）、避让（layout）、按钮小饰（charm）和两份
// 样式（festival.css / charm.css）加起来一百多 KB，一年里只有几十天用得上。它们全部经由
// 这一个文件进一个独立 chunk：FestivalProvider 判定今天在节日窗口里，才 import() 它；
// 页面上用的都是同名轻壳（FestivalDecor.tsx、LogoOrnament.tsx 等），不在节日里时连请求都
// 不发。
// The artwork, toppers, particles, avoidance, button charms and both stylesheets
// add up to well over 100 KB and are needed a few dozen days a year. All of it
// reaches the page through this one file, as one separate chunk: FestivalProvider
// imports it only when today falls in a festival window, and pages use the
// same-named light shells (FestivalDecor.tsx, LogoOrnament.tsx…), so outside a
// festival not even a request goes out.
//
// 落地页布景（FestivalStageImpl）不在这里：它只有落地页用，单独一个 chunk。
// The landing set (FestivalStageImpl) is not here: only the landing page uses
// it, so it has its own chunk.
export {
  FestivalAmbient,
  FestivalBurst,
  FestivalCorner,
  FestivalEmptyMini,
  FestivalGarland,
  FestivalGround,
  FestivalTopper,
} from './FestivalDecorImpl'
export { default as LogoOrnament } from './LogoOrnamentImpl'
export { default as FestivalGreeting } from './FestivalGreetingImpl'
export { default as FestivalEmpty } from './FestivalEmptyImpl'
export { default as FestivalRibbon } from './FestivalRibbonImpl'
export { applyCharm, startCharmGuard } from './charm'
