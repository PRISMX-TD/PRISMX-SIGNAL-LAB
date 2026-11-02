// 品种分类标签 + 自选：仪表盘「实时行情报价」和图表页左栏共用。
// 自选存在云端偏好（prefs 命名空间 markets.favorites），网页和 App 登录同一账号
// 自动同步；未登录（访客预览）不显示自选标签和星标。各处当前选中的标签也存在
// 偏好里（tabKey 区分两处），下次打开还停在原来那个。
// 分类标签只列出当前确实有品种的分类——EA 没推指数时就不出「指数」这个空标签。
//
// Category tabs + favorites, shared by the dashboard quotes card and the charts
// watchlist. Favorites live in the cloud prefs (markets.favorites), so web and app
// stay in sync per account; logged out (guest preview) there is no favorites tab
// and no star. The selected tab is also a pref (tabKey tells the two places apart).
// Only categories that currently have symbols get a tab.
import { useCallback, useMemo, type MouseEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../store/auth'
import { usePrefs } from '../../store/prefs'
import { SYMBOL_CATEGORIES, symbolCategory, type SymbolCategory } from '../../utils/symbolCategory'

export type SymbolTab = 'all' | 'fav' | Exclude<SymbolCategory, 'other'>

const NS = 'markets'

export function useFavoriteSymbols() {
  const { isAuthed } = useAuth()
  const { getPref, setPref } = usePrefs()
  const raw = getPref<unknown>(NS, 'favorites', [])
  const favorites = useMemo(
    () => (Array.isArray(raw) ? raw.filter((s): s is string => typeof s === 'string') : []),
    [raw],
  )
  const favSet = useMemo(() => new Set(favorites), [favorites])
  const toggle = useCallback((sym: string) => {
    setPref(NS, 'favorites', favSet.has(sym) ? favorites.filter((s) => s !== sym) : [...favorites, sym])
  }, [favSet, favorites, setPref])
  return { enabled: isAuthed, favSet, toggle }
}

/** 按当前标签过滤品种；标签存在偏好里 / filter symbols by the current tab, kept in prefs */
export function useSymbolTabs(symbols: string[], tabKey: string) {
  const { getPref, setPref } = usePrefs()
  const { enabled: favEnabled, favSet, toggle } = useFavoriteSymbols()

  const tabs = useMemo<SymbolTab[]>(() => {
    const present = new Set(symbols.map(symbolCategory))
    return [
      'all',
      ...(favEnabled ? (['fav'] as const) : []),
      ...SYMBOL_CATEGORIES.filter((c) => present.has(c)),
    ]
  }, [symbols, favEnabled])

  // 存着的标签这次没了（EA 不再推那类品种 / 退出登录）就回到「全部」
  // A stored tab that no longer exists (category gone / logged out) falls back to "all"
  const stored = getPref<string>(NS, tabKey, 'all') as SymbolTab
  const tab: SymbolTab = tabs.includes(stored) ? stored : 'all'
  const setTab = useCallback((t: SymbolTab) => setPref(NS, tabKey, t), [setPref, tabKey])

  const visible = useMemo(() => {
    if (tab === 'all') return symbols
    if (tab === 'fav') return symbols.filter((s) => favSet.has(s))
    return symbols.filter((s) => symbolCategory(s) === tab)
  }, [symbols, tab, favSet])

  return { tabs, tab, setTab, visible, favEnabled, favSet, toggleFavorite: toggle }
}

export function SymbolTabBar({ tabs, tab, onChange, className = '' }: {
  tabs: SymbolTab[]
  tab: SymbolTab
  onChange: (t: SymbolTab) => void
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <div className={`sym-tabs no-sb ${className}`} role="tablist">
      {tabs.map((k) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={k === tab}
          className={k === tab ? 'on' : undefined}
          onClick={() => onChange(k)}
        >
          {k === 'fav' && <StarIcon filled={k === tab} size={11} />}
          {t(`signals.symbolTabs.${k}`)}
        </button>
      ))}
    </div>
  )
}

export function FavoriteStar({ on, onToggle, symbol }: { on: boolean; onToggle: () => void; symbol: string }) {
  const { t } = useTranslation()
  // 星标常放在可点击的行里：拦住冒泡，点星不会顺带切换品种。
  // The star usually sits inside a clickable row: stop propagation so it doesn't also pick the symbol.
  const onClick = (e: MouseEvent) => { e.stopPropagation(); onToggle() }
  return (
    <button
      type="button"
      className={`fav-star ${on ? 'on' : ''}`}
      onClick={onClick}
      aria-pressed={on}
      aria-label={String(t(on ? 'signals.symbolTabs.removeFav' : 'signals.symbolTabs.addFav', { symbol }))}
      title={String(t(on ? 'signals.symbolTabs.removeFav' : 'signals.symbolTabs.addFav', { symbol }))}
    >
      <StarIcon filled={on} size={14} />
    </button>
  )
}

function StarIcon({ filled, size }: { filled: boolean; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9z" />
    </svg>
  )
}
