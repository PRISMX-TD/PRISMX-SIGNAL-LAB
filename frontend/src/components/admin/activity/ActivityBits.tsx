// 操作日志列表的小零件：一句话（盈亏染红绿）、文字小标签、分类色点、用户 / 账户 / 谁操作三格，
// 以及电脑端的一行和手机端的一张卡。列表与详情抽屉（时间轴、明细）共用同一套，免得同一条记录
// 在两处长得不一样。
// Small pieces of the activity list: the sentence (P/L coloured), text chips, the category
// dot, the user / account / actor cells, plus the desktop row and the phone card. Shared by
// the list and the drawer (timeline, breakdown) so one record never looks two ways.
import type { MouseEvent, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ActivityCat, ActivityItem, ActivityPerson } from '../../../api/types'
import { actorLabel, chipsFor, fmtPnl, renderEvent, type Chip, type Part } from './renderEvent'
import { bjClock, bjFull } from './time'

// 分类色点：四个分类各一色，与涨跌红绿错开（红绿只留给盈亏和异常）。
// One colour per category, kept clear of red / green, which belong to P/L and problems.
export const CAT_DOT: Record<ActivityCat, string> = {
  account: 'bg-sky-400',
  mt5: 'bg-amber-300',
  trade: 'bg-prism-400',
  admin: 'bg-neutral-400',
}

const CHIP_CLS: Record<Chip['tone'], string> = {
  bad: 'bg-down/15 text-down',
  warn: 'bg-amber-400/15 text-amber-300',
  info: 'bg-sky-400/15 text-sky-300',
  muted: 'bg-white/5 text-neutral-400',
}

export function pnlClass(v: number): string {
  const r = Math.round(v * 100)
  return r > 0 ? 'text-up' : r < 0 ? 'text-down' : 'text-neutral-300'
}

/** 一句话：字符串原样，{pnl} 段按正负染色。/ The sentence; {pnl} parts are coloured by sign. */
export function Sentence({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((p, i) =>
        typeof p === 'string' ? (
          <span key={i}>{p}</span>
        ) : (
          <span key={i} className={`num font-medium ${pnlClass(p.pnl)}`}>
            {fmtPnl(p.pnl)}
          </span>
        ),
      )}
    </>
  )
}

export function ChipList({ chips, className = '' }: { chips: Chip[]; className?: string }) {
  if (!chips.length) return null
  return (
    <span className={`inline-flex flex-wrap gap-1 align-middle ${className}`}>
      {chips.map((c) => (
        <span key={c.key} className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ${CHIP_CLS[c.tone]}`}>
          {c.label}
        </span>
      ))}
    </span>
  )
}

export function CatDot({ cat, className = '' }: { cat: ActivityCat; className?: string }) {
  return <span aria-hidden className={`inline-block h-2 w-2 shrink-0 rounded-full ${CAT_DOT[cat] ?? 'bg-neutral-500'} ${className}`} />
}

/** 时间格的悬停说明：完整记录时间；MT5 成交另带成交时间。/ Hover text: full record time, plus the fill time for MT5 deals. */
export function timeTitle(item: ActivityItem, t: (k: string) => string): string {
  const rec = `${t('admin.log.detail.recordedAt')} ${bjFull(item.ts)}`
  return item.at ? `${t('admin.log.detail.dealAt')} ${bjFull(item.at)}\n${rec}` : rec
}

const stop = (fn: () => void) => (e: MouseEvent) => {
  e.stopPropagation()
  fn()
}

/** 用户格：昵称加粗，下一行邮箱（老板点名要邮箱，完整显示、长了就折行，不截断）。
 *  User cell: bold nickname, email on the next line — shown in full (wrapping, never
 *  truncated), as the owner asked for the email specifically. */
export function UserCell({ item, onUser }: { item: ActivityItem; onUser?: (u: ActivityPerson) => void }) {
  const { t } = useTranslation()
  const u = item.user
  if (!u) {
    if (item.users_count != null) return <span className="text-xs text-neutral-300">{t('admin.log.user.count', { count: item.users_count })}</span>
    return <span className="text-xs text-neutral-500">{t('admin.log.user.platform')}</span>
  }
  const body = (
    <>
      {u.nickname && <span className="block break-words text-xs font-semibold text-neutral-100">{u.nickname}</span>}
      <span className="block break-all font-mono text-[11px] leading-snug text-neutral-400">{u.email ?? t('admin.log.user.noEmail')}</span>
    </>
  )
  if (!onUser) return <span className="block min-w-0">{body}</span>
  return (
    <button
      type="button"
      onClick={stop(() => onUser(u))}
      title={t('admin.log.user.filterHint')}
      className="block min-w-0 max-w-full rounded text-left transition hover:bg-white/5"
    >
      {body}
    </button>
  )
}

/** 账号旁的小标签：直连 / 桥接、模拟、已解绑（账号本身也灰掉）、授权失效（琥珀色）。光靠灰字
 *  管理员看不出这个账号已经解绑了，所以和直连 / 桥接一样写成文字小标签。
 *  Tags beside the login: direct / bridge, demo, unlinked (the login is greyed too) and
 *  revoked (amber). Grey text alone does not tell an admin the account was unlinked, so it
 *  gets a text tag like direct / bridge. */
export function AccountTags({ item }: { item: ActivityItem }) {
  const { t } = useTranslation()
  const a = item.account
  if (!a) return null
  return (
    <>
      {a.channel && (
        <span className="rounded bg-white/5 px-1 py-px text-[10px] text-neutral-400">{t(`admin.log.acct.${a.channel}`)}</span>
      )}
      {a.demo === true && <span className="rounded bg-white/5 px-1 py-px text-[10px] text-neutral-500">{t('admin.log.acct.demo')}</span>}
      {a.removed === true && (
        <span className="rounded bg-white/10 px-1 py-px text-[10px] text-neutral-300">{t('admin.log.acct.removed')}</span>
      )}
      {a.revoked === true && <span className="rounded bg-amber-400/15 px-1 py-px text-[10px] text-amber-300">{t('admin.log.acct.revoked')}</span>}
    </>
  )
}

export function AccountCell({ item, onLogin }: { item: ActivityItem; onLogin?: (login: string) => void }) {
  const { t } = useTranslation()
  const login = item.login
  if (!login) return <span className="text-xs text-neutral-600">—</span>
  const removed = item.account?.removed === true
  const body = (
    <span className="flex flex-wrap items-center gap-1">
      <span
        className={`num font-mono text-xs ${removed ? 'text-neutral-500' : 'text-neutral-200'}`}
        title={removed ? t('admin.log.acct.removed') : undefined}
      >
        {login}
      </span>
      <AccountTags item={item} />
    </span>
  )
  if (!onLogin) return body
  return (
    <button
      type="button"
      onClick={stop(() => onLogin(login))}
      title={t('admin.log.acct.filterHint')}
      className="block max-w-full rounded text-left transition hover:bg-white/5"
    >
      {body}
    </button>
  )
}

export interface RowHandlers {
  onOpen: (item: ActivityItem) => void
  onUser?: (u: ActivityPerson) => void
  onLogin?: (login: string) => void
}

/** 合并行的「展开 ▾ / 收起 ▴」。/ The expand / collapse toggle of a merged row. */
function ExpandToggle({ item, expanded, onToggle }: { item: ActivityItem; expanded: boolean; onToggle: () => void }) {
  const { t } = useTranslation()
  if (!item.children?.length) return null
  return (
    <button
      type="button"
      onClick={stop(onToggle)}
      aria-expanded={expanded}
      className="mt-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-prism-200 transition hover:bg-white/5"
    >
      {expanded ? t('admin.log.collapse') : t('admin.log.expand', { n: item.children.length })}
    </button>
  )
}

export const DESKTOP_GRID = 'grid grid-cols-[76px_minmax(0,1.15fr)_minmax(0,0.85fr)_minmax(0,0.75fr)_minmax(0,3fr)] gap-x-3'

/** 电脑端一行（五列）。child 行缩进、底色更浅，没有自己的展开按钮。
 *  A desktop row (five columns). Child rows are indented and lighter, with no toggle. */
export function DesktopRow({
  item,
  child = false,
  expanded = false,
  onToggle,
  handlers,
}: {
  item: ActivityItem
  child?: boolean
  expanded?: boolean
  onToggle?: () => void
  handlers: RowHandlers
}) {
  const { t } = useTranslation()
  const r = renderEvent(item, t)
  return (
    <div
      onClick={() => handlers.onOpen(item)}
      className={`${DESKTOP_GRID} cursor-pointer border-b border-white/5 px-4 py-2.5 text-sm transition hover:bg-white/[0.03] ${
        child ? 'bg-white/[0.015]' : ''
      } ${item.abnormal ? 'shadow-[inset_2px_0_0_rgb(var(--down-rgb)/0.7)]' : ''}`}
    >
      <div className="num pt-0.5 text-xs text-neutral-400" title={timeTitle(item, t)}>
        {bjClock(item.ts)}
      </div>
      <div className="min-w-0">
        <UserCell item={item} onUser={handlers.onUser} />
      </div>
      <div className="min-w-0">
        <AccountCell item={item} onLogin={handlers.onLogin} />
      </div>
      <div className="min-w-0 break-words text-xs text-neutral-300">{actorLabel(item, t)}</div>
      <div className={`min-w-0 ${child ? 'border-l border-white/10 pl-3' : ''}`}>
        <div className="flex items-start gap-2">
          <CatDot cat={item.cat} className="mt-1.5" />
          <div className="min-w-0 flex-1">
            {/* 句子本身是个按钮：整行可点是给鼠标的，键盘用户要有一个能聚焦的东西。
                The sentence is the button: the whole row is clickable for the mouse,
                keyboard users need something focusable. */}
            <button type="button" onClick={stop(() => handlers.onOpen(item))} className="text-left leading-relaxed text-neutral-100">
              <Sentence parts={r.parts} />
            </button>{' '}
            <ChipList chips={chipsFor(item, t)} />
            {!child && onToggle && <ExpandToggle item={item} expanded={expanded} onToggle={onToggle} />}
          </div>
        </div>
      </div>
    </div>
  )
}

/** 手机端一张卡，三行：「14:03:21 · 交易」+ 标签 / 句子 / 「昵称 · 邮箱 · 账号 直连 · 本人」。
 *  A phone card in three lines: time · category + chips / sentence / who and where. */
export function PhoneCard({
  item,
  child = false,
  expanded = false,
  onToggle,
  handlers,
}: {
  item: ActivityItem
  child?: boolean
  expanded?: boolean
  onToggle?: () => void
  handlers: RowHandlers
}) {
  const { t } = useTranslation()
  const r = renderEvent(item, t)
  const u = item.user
  const who: ReactNode[] = []
  if (u) {
    if (u.nickname) who.push(<span key="n" className="font-semibold text-neutral-300">{u.nickname}</span>)
    who.push(<span key="e" className="break-all font-mono">{u.email ?? t('admin.log.user.noEmail')}</span>)
  } else {
    who.push(<span key="p">{item.users_count != null ? t('admin.log.user.count', { count: item.users_count }) : t('admin.log.user.platform')}</span>)
  }
  if (item.login) {
    who.push(
      <span key="l" className="inline-flex flex-wrap items-center gap-1">
        <span className={`num font-mono ${item.account?.removed ? 'text-neutral-600' : ''}`}>{item.login}</span>
        <AccountTags item={item} />
      </span>,
    )
  }
  who.push(<span key="a">{actorLabel(item, t)}</span>)
  return (
    <div
      onClick={() => handlers.onOpen(item)}
      className={`cursor-pointer border-b border-white/5 py-3 ${child ? 'ml-3 border-l border-l-white/10 pl-3 pr-3' : 'px-3'} ${
        item.abnormal ? 'shadow-[inset_2px_0_0_rgb(var(--down-rgb)/0.7)]' : ''
      }`}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
        <CatDot cat={item.cat} />
        <span className="num" title={timeTitle(item, t)}>{bjClock(item.ts)}</span>
        <span>·</span>
        <span>{t(`admin.log.cat.${item.cat}`)}</span>
        <ChipList chips={chipsFor(item, t)} />
      </div>
      <button type="button" onClick={stop(() => handlers.onOpen(item))} className="mt-1 block w-full text-left text-sm leading-relaxed text-neutral-100">
        <Sentence parts={r.parts} />
      </button>
      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-neutral-500">
        {who.map((node, i) => (
          <span key={i} className="inline-flex items-center gap-1.5">
            {i > 0 && <span aria-hidden>·</span>}
            {node}
          </span>
        ))}
      </div>
      {!child && onToggle && <ExpandToggle item={item} expanded={expanded} onToggle={onToggle} />}
    </div>
  )
}

/**
 * 列表为空时的那一块。搜的是 5–12 位纯数字时，后端是按 MT5 账号查的——管理员多半是在查手机号
 * （13800138000、0123456789 这类不带「+」的写法），所以明说「按 MT5 账号查过了」，再把手机号
 * 对得上的用户列出来，点一下就换成看这位用户；一个都没有就提示带上「+」和区号。
 * The empty-list block. A 5–12 digit search was run as an MT5 login, while the admin was most
 * likely after a phone number typed without the "+", so it says the login search found
 * nothing, then lists users whose phone matches (one tap switches to that user), or tells
 * them to add the "+" and country code when none does.
 */
export function EmptyState({
  loginQuery,
  phoneUsers,
  onPickUser,
}: {
  /** 按 MT5 账号查的那串数字；不是这种搜索为 null / the digits searched as a login, else null */
  loginQuery: string | null
  /** 手机号对得上的用户；还没查完为 null / users whose phone matches; null while unknown */
  phoneUsers: ActivityPerson[] | null
  onPickUser: (u: ActivityPerson) => void
}) {
  const { t } = useTranslation()
  if (!loginQuery) {
    return (
      <div className="glass p-8 text-center">
        <p className="text-sm text-neutral-400">{t('admin.log.empty')}</p>
        <p className="mt-1 text-xs text-neutral-500">{t('admin.log.emptyHint')}</p>
      </div>
    )
  }
  return (
    <div className="glass p-8 text-center">
      <p className="text-sm text-neutral-400">{t('admin.log.emptyLogin', { q: loginQuery })}</p>
      {phoneUsers && phoneUsers.length > 0 ? (
        <>
          <p className="mt-2 text-xs text-neutral-500">{t('admin.log.phoneHits')}</p>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {phoneUsers.map((u) => (
              <button key={u.id} type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => onPickUser(u)}>
                {[u.nickname, u.email].filter(Boolean).join(' · ') || u.id.slice(0, 8)}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="mt-1 text-xs text-neutral-500">{t('admin.log.phoneTip')}</p>
      )}
    </div>
  )
}
