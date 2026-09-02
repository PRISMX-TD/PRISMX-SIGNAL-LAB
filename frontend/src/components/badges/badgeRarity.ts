// 勋章稀有度镜像表：行内展示（排行榜行、比赛榜行）只带 badge id（如
// LeaderboardRow.equippedBadge / CompetitionEntry 所在的榜行），稀有度要另查
// ——勋章注册表本身在后端（services/gamification/badges.py）。与 AchievementsPage
// 不同：那边从 /gamification/me 拿到完整 badge 对象（自带 rarity），这两处没有
// 那趟往返可搭，所以共用这一份镜像表。17 条与后端注册表一一对应，含 Phase 3
// 的比赛类勋章（comp_finisher/comp_podium/comp_winner/comp_back_to_back）。
//
// 原在 LeaderboardPage.tsx 内定义，CompetitionsPage 的比赛榜表格需要同一份镜像
// 表渲染 equippedBadge，遂拆到这个共享模块，两处一起 import。
//
// Badge-rarity mirror: an inline row rendering (a leaderboard row, a
// competition board row) carries only the badge id (see
// LeaderboardRow.equippedBadge / the rows CompetitionEntry sits alongside), so
// the rarity has to be looked up separately — the badge registry itself lives
// server-side (services/gamification/badges.py). Unlike AchievementsPage,
// which gets full badge objects (rarity included) from /gamification/me,
// neither of these has such a round trip to piggyback on, hence one shared
// mirror. These 17 entries mirror the backend registry 1:1, including Phase
// 3's competition badges (comp_finisher/comp_podium/comp_winner/
// comp_back_to_back).
//
// Originally defined inside LeaderboardPage.tsx; CompetitionsPage's
// competition-board table needs the same mirror to render equippedBadge, so
// this was pulled out into a shared module that both import.
import type { GamificationBadgeRarity } from '../../api/types'

export const BADGE_RARITY: Record<string, GamificationBadgeRarity> = {
  profile_complete: 'common',
  first_close: 'common',
  first_real_trade: 'common',
  comp_finisher: 'common',
  evergreen_3m: 'rare',
  discipline_90_7: 'rare',
  hundred_wins: 'rare',
  midas_touch: 'epic',
  profit_factor_2: 'epic',
  evergreen_6m: 'epic',
  discipline_90_30: 'epic',
  no_bad_sl_50: 'epic',
  comp_podium: 'epic',
  evergreen_12m: 'legendary',
  comp_winner: 'legendary',
  comp_back_to_back: 'legendary',
  founder_2026: 'limited',
}
