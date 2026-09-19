// 官方社交主页入口：一排图标，只渲染管理员在后台填了的平台。
// Official social links: a row of icons, rendering only the platforms an admin
// has actually filled in (admin → 运营设置 → 官方社交主页).
import { useEffect, useState } from 'react'

import { siteApi } from '../api/client'
import { SOCIAL_PLATFORMS, type SocialLinks as SocialLinksMap, type SocialPlatform } from '../api/types'

// 四个展示点（落地页页脚、全站页脚、客服页、下载页）里有两处会同屏出现
// （客服页/下载页的正文块 + 它们自己的页脚），各自 fetch 一次就是同一份数据
// 请求两遍。这份模块级 promise 让一次页面加载只打一次接口，后挂载的组件直接
// 复用同一个 promise。
//
// 不做失效：这是管理员偶尔改一次的配置，用户这次会话里拿到的是进页面那一刻的
// 值，刷新就更新——为它加订阅或轮询是拿复杂度换一个没人察觉的时效。
//
// Two of the four placements can appear on one screen (the Support/Download
// page body block plus that page's own footer), so a per-component fetch would
// request the same data twice. This module-level promise makes it one call per
// page load, shared by whichever components mount.
//
// Deliberately never invalidated: this is config an admin edits occasionally,
// so a session sees the value as of page load and a refresh picks up changes.
// A subscription or poll would buy freshness nobody would notice.
let pending: Promise<SocialLinksMap> | null = null

function loadSocialLinks(): Promise<SocialLinksMap> {
  // 取不到就当作「一个都没配」——社交入口是锦上添花，接口挂了不该让页脚报错
  // 或留一块空占位。
  // A failed fetch is treated as "nothing configured": these links are a bonus,
  // and an outage must not make the footer throw or leave a gap.
  if (!pending) pending = siteApi.getSocial().catch(() => ({}) as SocialLinksMap)
  return pending
}

// 品牌图标用实心字形（fill），与站内其余线性图标（Layout 的 TabIcon）不同族是
// 有意的：品牌 mark 靠轮廓辨认，描边化之后 Facebook 的 f 和 Telegram 的纸飞机
// 在 18px 上就认不出来了。
// Brand glyphs are solid fills, deliberately a different family from the app's
// line icons (Layout's TabIcon): a brand mark is recognised by its silhouette,
// and a stroked Facebook "f" or Telegram plane is unreadable at 18px.
const PATHS: Record<SocialPlatform, string> = {
  facebook:
    'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z',
  instagram:
    'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z',
  x: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932 6.064-6.933zm-1.291 19.49h2.039L6.486 3.24H4.298l13.312 17.403z',
  discord:
    'M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127c-.598.35-1.22.644-1.873.891a.077.077 0 0 0-.041.107c.36.698.772 1.363 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z',
  telegram:
    'M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212-.07-.062-.174-.041-.249-.024-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z',
}

// 品牌名不进 i18n（品牌名不翻译），但必须出现在 aria-label 上：图标本身对读屏
// 软件是空的，没有 label 的链接会被读成"链接"。
// Brand names stay out of i18n (brands aren't translated) but must reach
// aria-label: the icon is empty to a screen reader, and an unlabelled link is
// announced as just "link".
const LABELS: Record<SocialPlatform, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  x: 'X',
  discord: 'Discord',
  telegram: 'Telegram',
}

// 已配置的平台列表（按 SOCIAL_PLATFORMS 的顺序）。组件自己用它，需要连标题一起
// 隐藏的调用方（下载页那张带文案的卡）也用它——否则一个平台都没配时会留下一个
// 「加入社群」标题底下空无一物的卡。
// The configured platforms, in SOCIAL_PLATFORMS order. Used by the component
// itself and by callers that must hide surrounding copy too (the Download page's
// card), which would otherwise leave a "Join the community" heading over nothing.
/* 只放行 http/https。
   这些地址来自后台运营设置页，写入者只有管理员，所以风险低——但把一个外部可写的
   字符串直接塞进 href 是没必要的：`javascript:` 开头的值点下去就是在本站上下文里
   执行脚本，`data:` 同理。校验的成本是一行，不值得为「写的人是可信的」省掉。
   用 new URL() 而不是正则前缀匹配：URL 解析会先做去空白与大小写归一，
   `  JaVaScRiPt:alert(1)` 这类绕过在 startsWith 面前能过，在这里过不了。
   解析失败（相对路径、纯手误）一并丢弃——社交主页一定是绝对地址。

   Only http/https pass. These come from the admin operations settings page, so
   only an administrator can write them and the risk is low — but there is no
   reason to drop an externally writable string straight into an href: a
   `javascript:` value executes in this site's origin the moment it is clicked,
   and `data:` likewise. The check costs one line, which is cheaper than relying
   on the author being trusted.
   new URL() rather than a prefix match, because URL parsing strips whitespace and
   normalises case first: `  JaVaScRiPt:alert(1)` slips past startsWith and does
   not slip past this. Anything unparseable (a relative path, a typo) is dropped
   too — a social profile is always an absolute URL. */
function isSafeHttpUrl(v: string | undefined): boolean {
  if (!v) return false
  try {
    const p = new URL(v).protocol
    return p === 'http:' || p === 'https:'
  } catch {
    return false
  }
}

function useSocialPlatforms(): { links: SocialLinksMap; items: SocialPlatform[] } {
  const [links, setLinks] = useState<SocialLinksMap>({})

  useEffect(() => {
    let alive = true
    loadSocialLinks().then((l) => {
      if (alive) setLinks(l)
    })
    return () => {
      alive = false
    }
  }, [])

  // 过滤发生在**这一处**，所以 items 为空时「加入社群」整张卡也跟着不渲染——
  // 被丢弃的链接不会留下一个点不动的图标。
  // Filtering happens here, so a dropped link also removes the surrounding
  // "join the community" card instead of leaving a dead icon behind.
  return { links, items: SOCIAL_PLATFORMS.filter((p) => isSafeHttpUrl(links[p])) }
}

/** 是否有任何一个平台配置了链接。 / Whether any platform has a link configured. */
export function useHasSocialLinks(): boolean {
  return useSocialPlatforms().items.length > 0
}

export default function SocialLinks({
  className = '',
  size = 18,
}: {
  className?: string
  size?: number
}) {
  // 加载中不占位、没配置也不占位：这一排是可有可无的补充，留一个空壳或骨架屏
  // 反而会让页脚在加载完成的那一刻跳一下。
  // No placeholder while loading and none when nothing is configured: this row
  // is supplementary, and a shell or skeleton would just make the footer jump
  // when it resolves.
  const { links, items } = useSocialPlatforms()
  if (items.length === 0) return null

  return (
    <div className={`flex flex-wrap items-center gap-3.5 ${className}`}>
      {items.map((p) => (
        <a
          key={p}
          href={links[p]}
          target="_blank"
          // noopener 是必须的：target="_blank" 打开的页面能通过 window.opener
          // 操纵本站这个标签页。noreferrer 顺带不把站内路径带给第三方。
          // noopener is required: a target="_blank" page can drive this tab via
          // window.opener. noreferrer also keeps our paths off the third party.
          rel="noopener noreferrer"
          aria-label={LABELS[p]}
          title={LABELS[p]}
          className="inline-flex text-neutral-500 transition-colors hover:text-neutral-200"
        >
          <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d={PATHS[p]} />
          </svg>
        </a>
      ))}
    </div>
  )
}
