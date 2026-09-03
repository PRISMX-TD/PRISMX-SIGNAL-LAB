// frontend/src/components/badges/BadgeDetailModal.tsx
// 勋章详情层：点开勋章墙任意一枚（已获得/未获得都能点）弹出的玻璃卡——放大
// 的倾斜勋章、家族/材质说明、以及后端按 user_badges 分组计数出的「全站拥有
// N 人」。Portal-to-body + 居中玻璃卡 + Escape/backdrop 关闭，抄的是
// ConfirmModal 的先例（同一份注释里记过原因：调用点在 .glass 卡片内部，不
// portal 会被 backdrop-filter 截断）。
//
// Badge detail layer: opens from any badge-wall tile (earned or not) — an
// enlarged tilting medal, its family/material line, and the backend's
// grouped user_badges count ("N holders sitewide"). Portal-to-body +
// centered glass card + Escape/backdrop close, following ConfirmModal's
// precedent (same reason recorded there: the call site sits inside a
// .glass card, and skipping the portal would get clipped by its
// backdrop-filter).
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import BadgeIcon from './BadgeIcon'
import MedalTilt from './MedalTilt'
import { FAMILY_OF } from './medal'
import { fmtDate } from '../../api/utils'
import type { GamificationBadge } from '../../api/types'

interface Props {
  badge: GamificationBadge
  population: number
  onClose: () => void
}

// population 为 0（数据库为空的边界情况）时不做除零——直接报 0.0%，比 NaN%
// 更能看。population zero (an empty-database edge case) avoids a
// divide-by-zero — reports 0.0% outright rather than NaN%.
function fmtOwnerPct(owners: number, population: number): string {
  if (population <= 0) return '0.0%'
  return `${((owners / population) * 100).toFixed(1)}%`
}

export default function BadgeDetailModal({ badge, population, onClose }: Props) {
  const { t } = useTranslation()

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const family = FAMILY_OF(badge.id)
  const pct = fmtOwnerPct(badge.owners, population)

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div className="glass-card relative w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('gamification.detail.close')}
          className="absolute right-4 top-4 text-2xl leading-none text-neutral-400 transition hover:text-neutral-200"
        >
          ×
        </button>

        <div className="flex flex-col items-center gap-3 text-center">
          <MedalTilt ariaLabel={t(`gamification.badges.${badge.id}.name`)}>
            <BadgeIcon id={badge.id} rarity={badge.rarity} earned={badge.earned} size={240} />
          </MedalTilt>
          <h3 className="font-display text-xl font-bold text-white">
            {t(`gamification.badges.${badge.id}.name`)}
          </h3>
          <span className="tag bg-white/5 text-xs text-neutral-300">
            {t(`gamification.rarity.${badge.rarity}`)} · {t(`gamification.material.${badge.rarity}`)} ·{' '}
            {t(`gamification.family.${family}`)} · {t(`gamification.shape.${family}`)}
          </span>
          <p className="text-sm text-neutral-400">{t(`gamification.badges.${badge.id}.desc`)}</p>
        </div>

        <div className="mt-5 space-y-1.5 border-t border-white/10 pt-4 text-xs text-neutral-400">
          {badge.earned && badge.awardedAt && (
            <div>
              {t('gamification.detail.awardedAt')}{' '}
              <span className="num text-neutral-200">{fmtDate(badge.awardedAt)}</span>
            </div>
          )}
          <div>{t('gamification.detail.owners', { n: badge.owners, pct })}</div>
          <div>{t('gamification.detail.wearHint')}</div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
