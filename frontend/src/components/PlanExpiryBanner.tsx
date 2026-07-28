// PRO 到期提醒条。
//
// 为什么需要它：到期这件事此前是**完全静默**的。plan_expires_at 一到，后端
// （services/plan_expiry.py）立刻把用户降回 FREE，那一刻同时发生三件事——实时
// 信号消失、推送通知全停、超出 FREE 上限的 MT5 账号在下一次桥接轮询里被踢下线
// （见 routers/bridge.py 的 allowed_bound）。而全站唯一能看到到期日的地方是账户页
// 和升级页里的一行小字，用户得主动点进去才看得见。
//
// 结果是客户不会觉得「我该续费了」，只会觉得「这东西坏了」。这是纯粹的自造流失，
// 而且如果他第二、第三个账号上正开着仓，还会在毫无预警的情况下失去网页控制权。
//
// 这个组件只解决「到期前提醒」与「刚到期后解释」两件事，不碰任何权限逻辑。
//
// PRO expiry notice.
//
// Why it exists: expiry used to be entirely silent. The moment plan_expires_at
// passes, the backend (services/plan_expiry.py) drops the user to FREE, and three
// things happen at once — real-time signals stop, push notifications stop, and any
// MT5 account beyond the FREE limit is kicked offline on the bridge's next poll
// (see allowed_bound in routers/bridge.py). Meanwhile the only place the expiry
// date appears is one line of small text on the account and upgrade pages, which
// the user has to go looking for.
//
// The result is that customers don't think "time to renew", they think "this
// broke" — self-inflicted churn, and if they had positions open on a second or
// third account they lose web control of them without warning.
//
// This component only does two things: warn before expiry, and explain just after
// it. It touches no permission logic.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useAuth } from '../store/auth'

// 提前多少天开始提醒。7 天足够让人有时间准备一笔加密货币转账（还要等链上确认），
// 又不至于早到让人看烦然后习惯性忽略。
// How many days ahead to start warning. Seven is enough time to arrange a crypto
// transfer and wait for on-chain confirmation, without being so early that people
// learn to tune it out.
const WARN_DAYS = 7

// 到期后还提醒多少天。过了这段就不再打扰——他已经知道了，再挂着就是纯烦人。
// How long to keep explaining after expiry. Past this we stop nagging: they know.
const AFTER_DAYS = 7

// 记住「上一次看到的 PRO 到期时间」。
//
// 后端在降级时会把 plan_expires_at 清成 null（services/plan_expiry.py 里是有意为之
// ——避免管理员之后重新升级却忘了改到期时间，导致用户被那个过去的时间立刻再判过期）。
// 所以降级之后，前端**再也无法从服务端得知「他刚刚到期了」**：看到的只是一个普通的
// FREE 用户。这个本地记录是唯一能把「刚到期」和「本来就是 FREE」区分开的线索。
//
// 拿不到也无所谓：最坏情况就是不显示到期后的解释条，不会误报。
//
// Remembers the last PRO expiry we saw.
//
// On downgrade the backend clears plan_expires_at to null (deliberately, in
// services/plan_expiry.py — so a stale past date can't immediately re-expire a
// user an admin later re-upgrades without setting a new one). That means after the
// downgrade the frontend can no longer learn from the server that this user *just*
// expired: all it sees is an ordinary FREE user. This local record is the only
// thing that separates "just expired" from "always been FREE".
//
// If it's missing, nothing breaks — we simply don't show the after-the-fact
// explanation. It can never produce a false positive.
const LAST_EXPIRY_KEY = 'prismx.plan.lastExpiry'
const DISMISS_KEY = 'prismx.plan.expiryDismissed'

function daysUntil(iso: string): number {
  // 按天向上取整：还剩 20 小时应该显示「还有 1 天」而不是「还有 0 天」。
  // Ceil to whole days: 20 hours left should read "1 day", not "0 days".
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000)
}

export default function PlanExpiryBanner() {
  const { t } = useTranslation()
  const { user, refreshUser } = useAuth()
  const [dismissed, setDismissed] = useState<string | null>(() => localStorage.getItem(DISMISS_KEY))

  const plan = user?.plan
  const expiresAt = user?.planExpiresAt
  const isTrial = !!user?.planIsTrial

  // 进入应用时刷新一次登录态：plan / planExpiresAt 都可能在服务端被改过（管理员
  // 调整、到期扫描、另一台设备上续费），登录响应本身也不带到期时间。
  // 只在挂载时跑一次，Layout 每个会话只挂载一次，代价是一个很小的请求。
  // Refresh the session once on entry: plan and planExpiresAt can both have
  // changed server-side (an admin edit, the expiry sweep, a renewal on another
  // device), and the login response doesn't carry the expiry at all. Runs once on
  // mount; Layout mounts once per session, so the cost is one small request.
  useEffect(() => {
    refreshUser()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时跑 / mount only
  }, [])

  // 记下当前看到的到期时间，供降级之后回溯用（见 LAST_EXPIRY_KEY 的说明）。
  // Record the expiry we can currently see, for use after a downgrade.
  useEffect(() => {
    if (plan === 'PRO' && expiresAt) localStorage.setItem(LAST_EXPIRY_KEY, expiresAt)
  }, [plan, expiresAt])

  // ---- 判定要不要显示、显示哪一种 ----
  let variant: 'soon' | 'expired' | null = null
  let days = 0
  // key 用到期时间本身：续费后到期时间变了，key 跟着变，横幅可以在下一个周期
  // 重新出现——而不是被上一次的「关闭」永久静音。
  // The key is the expiry timestamp itself: after a renewal it changes, so the
  // banner can appear again next cycle instead of being permanently silenced by
  // one earlier dismissal.
  let key = ''

  if (plan === 'PRO' && expiresAt) {
    days = daysUntil(expiresAt)
    if (days <= WARN_DAYS) {
      variant = 'soon'
      key = expiresAt
    }
  } else if (plan === 'FREE') {
    const last = localStorage.getItem(LAST_EXPIRY_KEY)
    if (last) {
      const since = -daysUntil(last)
      // 只在「确实已经过去了」且还在解释窗口内时显示。since < 0 说明这条记录指向
      // 未来——多半是管理员手动把人改成了 FREE，那不是「到期」，不该这么说。
      // Only when it genuinely has passed and we're still inside the explanation
      // window. A negative `since` means the record points at the future, which
      // almost certainly means an admin manually set them to FREE — that isn't an
      // expiry and shouldn't be described as one.
      if (since >= 0 && since <= AFTER_DAYS) {
        variant = 'expired'
        key = last
      }
    }
  }

  if (!variant || dismissed === key) return null

  const urgent = variant === 'expired' || days <= 2
  const tone = urgent
    ? 'border-amber-400/30 bg-amber-400/10 text-amber-300'
    : 'border-prism-500/25 bg-prism-600/10 text-prism-200'
  const dot = urgent ? 'bg-amber-400' : 'bg-prism-400'
  const btn = urgent
    ? 'bg-amber-400/20 text-amber-100 hover:bg-amber-400/30'
    : 'bg-prism-500/25 text-prism-100 hover:bg-prism-500/35'

  const headline =
    variant === 'expired'
      ? isTrial
        ? t('planExpiry.trialExpired')
        : t('planExpiry.expired')
      : days <= 0
        ? isTrial
          ? t('planExpiry.trialToday')
          : t('planExpiry.today')
        : isTrial
          ? t('planExpiry.trialSoon', { days })
          : t('planExpiry.soon', { days })

  const onDismiss = () => {
    localStorage.setItem(DISMISS_KEY, key)
    setDismissed(key)
  }

  return (
    <div className={`mx-auto w-full max-w-7xl px-4 pt-4 sm:px-6`}>
      <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-2.5 text-xs ${tone}`}>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot} ${urgent ? 'animate-pulse' : ''}`} />
        <span className="font-semibold">{headline}</span>
        <span className="min-w-0 leading-relaxed opacity-80">
          {variant === 'expired' ? t('planExpiry.expiredBody') : t('planExpiry.body')}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Link to="/upgrade" className={`rounded-lg px-2.5 py-1 font-semibold transition ${btn}`}>
            {variant === 'expired' ? t('planExpiry.upgrade') : t('planExpiry.renew')}
          </Link>
          <button
            type="button"
            onClick={onDismiss}
            aria-label={t('planExpiry.dismiss')}
            className="opacity-60 transition hover:opacity-100"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
