// 账号被停用时的全站遮罩 / site-wide overlay for a disabled account
//
// 被管理员停用的人会在每一个需要登录的接口上拿到 403。**没有这一层之前**，他看到
// 的是各个页面自己的降级文案——仪表盘"加载失败"、订单页"加载失败"、图表页空白，
// 全都语焉不详，而且哪一条都没说出真正的原因；更糟的是，如果把 403 也当成"登录
// 过期"处理（这是最容易顺手写出来的那一版），他会被反复踢回登录页，登进来再被
// 踢出去，永远读不到一句解释。
//
// 这里把整块屏幕接管掉，只说三件事：账号被停用了、为什么（管理员填的原因，由后端
// 随 403 一起下发）、怎么联系客服。同时留一个"退出登录"作为唯一出口——不自动登出，
// 因为自动登出会把这句解释一起带走，人还没读完就回到了登录页。
//
// A disabled user gets a 403 from every authenticated endpoint. Without this
// layer they see each page's own degraded copy — "failed to load" on the
// dashboard, on the orders page, a blank chart — none of which says why. Worse,
// if 403 were handled as "session expired" (the easiest version to write by
// accident) they would be bounced to the login page over and over, signing in
// only to be thrown out again, never reading an explanation.
//
// This takes the screen and says three things: the account is disabled, why (the
// admin's reason, delivered by the backend alongside the 403), and how to reach
// support. Sign-out is the single way out, and is a button rather than automatic:
// signing out automatically would take the explanation away mid-sentence.
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { useAuth } from '../store/auth'
import { localizeApiError } from '../api/utils'
import { SUPPORT_EMAIL } from '../config/site'
import SocialLinks from './SocialLinks'

export default function AccountDisabledGate() {
  const { t } = useTranslation()
  const { disabledNotice, logout } = useAuth()

  if (!disabledNotice) return null

  // 后端的 detail 是"中文 / English"双语串（含管理员填的原因），按界面语言取一半。
  // 与全站其它报错展示同一套规则，不额外造第二种处理方式。
  // The backend's detail is a "中文 / English" pair (reason included); take the
  // half matching the UI language, exactly as every other error display does.
  const reason = localizeApiError(disabledNotice).trim()

  // 必须 portal 到 body，理由与 ConfirmModal 相同：调用处的祖先里有
  // backdrop-filter / transform 的卡片与页面转场容器，它们会成为 fixed 定位的
  // 包含块，让 inset-0 只铺满那一小块而不是整个视口。
  // Portal to body for ConfirmModal's reason: ancestors carrying backdrop-filter
  // or a transform (cards, the page-transition wrapper) become the containing
  // block for fixed positioning and would shrink inset-0 to their own box.
  return createPortal(
    // z-[70]：要盖在 ConfirmModal（z-50）与页头之上。被停用时任何操作都已经
    // 没有意义，包括他点开一半的那个确认框。
    // z-[70]: above ConfirmModal (z-50) and the header. Once disabled, nothing
    // underneath can still be acted on — including a half-open confirm dialog.
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-6 backdrop-blur-sm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="account-disabled-title"
    >
      <div className="glass-card w-full max-w-md p-6">
        <h2 id="account-disabled-title" className="text-lg font-bold text-white">
          {t('accountDisabled.title')}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">{t('accountDisabled.body')}</p>

        {/* 原因单独成块并加边框：这是本屏唯一一句因人而异的话，混在正文里会被
            当成模板文案略过。后端没给原因时整块不渲染，不留一个空框。
            The reason gets its own bordered block: it is the only sentence here
            that differs per person, and inline it reads as boilerplate. Nothing
            renders when the backend sent no reason — no empty frame. */}
        {reason && (
          <div className="mt-4 rounded-xl border border-down/30 bg-down/10 px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-neutral-400">
              {t('accountDisabled.reasonLabel')}
            </div>
            <p className="mt-1 break-words text-sm leading-relaxed text-neutral-100">{reason}</p>
          </div>
        )}

        <p className="mt-4 text-sm leading-relaxed text-neutral-300">{t('accountDisabled.contact')}</p>

        {/* 联系方式：邮箱由 config/site.ts 的 SUPPORT_EMAIL 控制，目前留空因而
            不渲染（见那份文件的说明——给一个收不到信的地址比不给更糟）。
            官方社交主页是这一屏唯一还能走通的出路：/support 工单页要登录态，
            而这个人的每个接口都是 403，他进不去。SocialLinks 自己在"一个都没配"
            时返回 null，所以两条都空的时候这里干净地什么也不出。
            Contact routes: the mail address is gated by SUPPORT_EMAIL in
            config/site.ts and is currently empty, so it does not render (see that
            file: publishing an unreachable address is worse than none). The
            official social pages are the only channel that still works from this
            screen — the /support ticket page needs a working session and every
            endpoint 403s for this person. SocialLinks returns null when nothing
            is configured, so with both empty this area simply disappears. */}
        {SUPPORT_EMAIL && (
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="mt-2 inline-block text-sm text-prism-400 underline-offset-2 hover:underline"
          >
            {SUPPORT_EMAIL}
          </a>
        )}
        <SocialLinks className="mt-4" />

        <button onClick={logout} className="btn-primary mt-6 w-full py-2 text-sm">
          {t('accountDisabled.logout')}
        </button>
      </div>
    </div>,
    document.body,
  )
}
