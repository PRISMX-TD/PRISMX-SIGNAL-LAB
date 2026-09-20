// 停用账号的确认弹窗（带原因输入）/ disable-account confirmation, with a reason field
//
// 为什么不直接用 ConfirmModal：停用必须填原因，而那段文字不是内部备注——后端会把
// 它塞进该用户此后每一个 403 的说明里，由他本人在全站遮罩上读到。一个"确定吗？"
// 式的空确认框在这里既拿不到原因，也没法把"所有会话立刻失效"这句话摆在按钮旁边。
//
// 版式、遮罩、portal、按钮组全部照抄 ConfirmModal（见该文件里关于 portal 与
// .slide-sheet 内联宽度的两条注释），只多了中间那个输入区——目的是让它看上去就是
// 同一个东西，而不是后台里冒出来的第二种弹窗风格。
//
// Not plain ConfirmModal because a disable needs a reason, and that text is not
// an internal note: the backend embeds it in the detail of every subsequent 403
// and the user reads it on the site-wide overlay. A content-free "are you sure?"
// can neither collect it nor put "every session ends immediately" next to the
// button.
//
// Layout, overlay, portal and button row are copied from ConfirmModal (see its
// comments on portalling and on never setting .slide-sheet's width inline), with
// only the input area added, so this reads as the same component rather than a
// second dialog style appearing in the admin area.
import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { DISABLE_REASON_MAX, normalizeDisableReason } from './userStatus'
import { useDialogA11y } from '../../utils/useDialogA11y'

interface Props {
  /** 被停用者的邮箱，写进确认文案——按下去之前要能确认"是这个人"。
   *  The target's email, shown in the copy: confirm *who* before confirming. */
  email: string
  busy?: boolean
  /** 收到的是规范化之后、真正会发给后端的那一份原因（见 userStatus.ts）。
   *  Receives the normalised reason — the exact value sent on (see userStatus.ts). */
  onConfirm: (reason: string) => void
  onCancel: () => void
}

export default function DisableUserModal({ email, busy, onConfirm, onCancel }: Props) {
  const { t } = useTranslation()
  const [raw, setRaw] = useState('')
  // 与 ConfirmModal 同款的键盘/读屏处理（见 utils/useDialogA11y）。
  // Same keyboard/screen-reader handling as ConfirmModal (see utils/useDialogA11y).
  const sheetRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useDialogA11y(sheetRef, () => { if (!busy) onCancel() })

  // 规范化只做一次，确认框显示的字数、按钮的可用性、真正发出去的值都来自它。
  // 两处各算一遍迟早会对不上（AdminPage 的 bulkPayload 注释里记过同一条教训）。
  // Normalised once: the counter, the button's enabled state and the value
  // actually sent all come from this. Computing it twice eventually disagrees
  // (same lesson recorded in AdminPage's bulkPayload comment).
  const reason = normalizeDisableReason(raw)

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6 backdrop-blur-sm" onClick={onCancel}>
      <div
        ref={sheetRef}
        className="glass-card w-full max-w-sm p-6"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h3 id={titleId} className="text-lg font-bold text-white">{t('admin.disableTitle')}</h3>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          {t('admin.disableBody', { email })}
        </p>
        {/* 会话失效那句单独成行并加色：它是本次操作里最容易被忽略、后果最即时的
            一条——管理员多半以为"下次登录才生效"。
            The session line stands alone and coloured: it is the most overlooked
            and most immediate consequence here — admins tend to assume it only
            takes effect at the next login. */}
        <p className="mt-2 text-sm font-semibold leading-relaxed text-down">
          {t('admin.disableSessionWarn')}
        </p>

        <label className="mt-4 block text-xs font-medium text-neutral-400" htmlFor="disable-reason">
          {t('admin.disableReasonLabel')}
        </label>
        <textarea
          id="disable-reason"
          autoFocus
          rows={3}
          className="input mt-1.5 w-full resize-none py-2 text-sm"
          placeholder={t('admin.disableReasonPlaceholder')}
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          // maxLength 与 normalizeDisableReason 的截断是两道同向的闸：输入框先挡住
          // 继续打字，规范化再兜住粘贴进来的长文本（折叠空白后仍可能超）。
          // maxLength and normalizeDisableReason's truncation guard the same
          // direction: the field stops further typing, the normaliser catches
          // pasted text that is still too long once whitespace is collapsed.
          maxLength={DISABLE_REASON_MAX}
        />
        <div className="mt-1 text-right text-[11px] text-neutral-500">
          {(reason?.length ?? 0)}/{DISABLE_REASON_MAX}
        </div>
        {/* 这句话解释的是"为什么必填"，不是"你忘了填"——写完原因的人不该再看到
            一行提示，所以只在空的时候出现。
            This explains *why* it is required rather than scolding a blank field,
            so it disappears once something is typed. */}
        {!reason && (
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">{t('admin.disableReasonHint')}</p>
        )}

        <div className="mt-5 flex gap-3">
          <button onClick={onCancel} disabled={busy} className="btn-ghost flex-1 py-2 text-sm">
            {t('common.cancel')}
          </button>
          <button
            onClick={() => reason && onConfirm(reason)}
            disabled={busy || !reason}
            className="flex-1 rounded-xl border border-down/40 bg-down/15 py-2 text-sm font-semibold text-down transition hover:bg-down/25 disabled:opacity-50"
          >
            {t('admin.disableConfirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
