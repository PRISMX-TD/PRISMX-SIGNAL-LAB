// frontend/src/components/badges/BadgeDetailModal.tsx
// 勋章详情层：点开勋章墙任意一枚（已获得/未获得都能点）弹出的玻璃卡——放大
// 的倾斜勋章、家族/材质说明、以及后端按 user_badges 分组计数出的「全站拥有
// N 人」。进阶勋章多一段**三档阶梯**：铜 / 银 / 金各自的条件、各档当前持有人数、
// 以及自己到了哪一档。Portal-to-body + 居中玻璃卡 + Escape/backdrop 关闭，抄的是
// ConfirmModal 的先例（同一份注释里记过原因：调用点在 .glass 卡片内部，不
// portal 会被 backdrop-filter 截断）。
//
// Badge detail layer: opens from any badge-wall tile (earned or not) — an
// enlarged tilting medal, its family/material line, and the backend's grouped
// user_badges count. Tiered badges add a **three-tier ladder**: each tier's
// condition, its current holder count, and which tier you are on.
// Portal-to-body + centered glass card + Escape/backdrop close, following
// ConfirmModal's precedent.
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import BadgeIcon from './BadgeIcon'
import LimitedClosesLine from './LimitedClosesLine'
import { BadgeProgressBar } from './BadgeProgressBar'
import MedalTilt from './MedalTilt'
import { FAMILY_OF, materialOf } from './medal'
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

const TIERS = [1, 2, 3] as const

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
  const material = materialOf(badge.id, badge.tier)
  const pct = fmtOwnerPct(badge.owners, population)
  const tiered = badge.maxTier > 0

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
            <BadgeIcon id={badge.id} tier={badge.tier} earned={badge.earned} size={240} />
          </MedalTilt>
          <h3 className="font-display text-xl font-bold text-white">
            {t(`gamification.badges.${badge.id}.name`)}
            {tiered && badge.earned && (
              <span className="ml-2 text-base font-semibold text-neutral-300">· {t(`gamification.tier.${badge.tier}`)}</span>
            )}
          </h3>
          <span className="tag bg-white/5 text-xs text-neutral-300">
            {t(`gamification.material.${material}`)} · {t(`gamification.family.${family}`)} · {t(`gamification.shape.${family}`)}
          </span>
          {!tiered && <p className="text-sm text-neutral-400">{t(`gamification.badges.${badge.id}.desc`)}</p>}
          {badge.shelf === 'limited' && (
            <LimitedClosesLine closesAt={badge.closesAt} as="p" className="text-xs text-neutral-500" />
          )}
        </div>

        {/* 三档阶梯：每档一行——小铸币、档名、条件、当前持有人数；到了的档打钩。
            The tier ladder: one row per tier — a small coin, the tier name, the
            condition, current holders; reached tiers get a check. */}
        {tiered && (
          <ol className="ach-ladder mt-5">
            {TIERS.map((tier) => {
              const reached = badge.tier >= tier
              return (
                <li key={tier} className={reached ? 'on' : ''}>
                  <BadgeIcon id={badge.id} tier={tier} earned size={40} />
                  <div className="min-w-0">
                    <b>
                      {t(`gamification.tier.${tier}`)}
                      {reached && <span className="ach-ladder-check" aria-hidden>✓</span>}
                    </b>
                    <span>{t(`gamification.badges.${badge.id}.tiers.${tier}`)}</span>
                    {!reached && badge.progress && <BadgeProgressBar p={badge.progress[tier - 1]} />}
                  </div>
                  <small className="num">{t('gamification.detail.tierOwners', { n: badge.tierOwners[tier - 1] ?? 0 })}</small>
                </li>
              )
            })}
          </ol>
        )}

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
