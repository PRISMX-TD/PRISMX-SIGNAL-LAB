// 邀请链接编辑抽屉（设计 §5.4）：标记、渠道、链接与二维码、送试用、启停、代理管理、
// 创建时间、只读的关联比赛。所有写操作都交给面板（单一 busyId 闸门在面板里），
// 这里的按钮一律按 busy 禁用——理由见 InviteLinksPanel 里那段「禁用必须如实反映处理
// 函数行为」的注释。
// The invite-link edit drawer (§5.4). Every write goes through the panel (which owns the
// single busyId gate); every button here disables on busy — see the panel's note on why
// the disabled state must mirror what the handlers do.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import AdminSheet from '../AdminSheet'
import Switch from '../../Switch'
import { fmtTime } from '../../../api/utils'
import { promoLinkUrl } from '../../../utils/promoLinkUrl'
import type { Toast } from '../../../utils/useToast'
import type { InviteLink, InviteLinkPatch } from '../../../api/types'
import AgentPicker from './AgentPicker'
import ChannelField from './ChannelField'
import CopyLinkButton from './CopyLinkButton'
import LinkQrCode from './LinkQrCode'
import ToastBar from './ToastBar'
import { kindBadgeClass, labelPatch, linkKind } from './inviteLinkLogic'

export default function InviteLinkEditDrawer({
  link,
  busy,
  globalTrialEnabled,
  toast,
  onSave,
  onToggleActive,
  onToggleTrial,
  onAssign,
  onRequestUnassign,
  onCopyFail,
  onClose,
}: {
  link: InviteLink
  busy: boolean
  globalTrialEnabled: boolean
  toast: Toast | null
  onSave: (patch: InviteLinkPatch) => Promise<boolean>
  onToggleActive: () => void
  onToggleTrial: () => void
  onAssign: (userId: string) => void
  onRequestUnassign: (userId: string) => void
  onCopyFail: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [label, setLabel] = useState(link.label)
  const [channel, setChannel] = useState(link.channel ?? '')

  // 保存成功后后端回来的新值同步回草稿；只在这三个值变化时重置——开关 / 代理的写操作
  // 也会换掉 link 对象，但不该冲掉正在输入的标记。
  // Sync drafts to saved values; keyed on these three only, so a toggle or agent write
  // (which also replaces the link object) doesn't wipe a label being typed.
  useEffect(() => {
    setLabel(link.label)
    setChannel(link.channel ?? '')
  }, [link.id, link.label, link.channel])

  const kind = linkKind(link)
  const patch = labelPatch(link, { label, channel })
  const url = promoLinkUrl(link)
  const agents = link.agents ?? []

  return (
    <AdminSheet
      title={t('admin.invite.editTitle')}
      onClose={onClose}
      badge={
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${kindBadgeClass(kind)}`}>
          {t(`admin.invite.kind.${kind}`)}
        </span>
      }
    >
      <ToastBar toast={toast} className="mt-3" />

      <form
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (patch && !busy) void onSave(patch)
        }}
      >
        <div>
          <label className="label">{t('admin.invite.fieldLabel')}</label>
          <input className="input w-full" value={label} maxLength={64} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div>
          <label className="label">{t('admin.invite.fieldChannel')}</label>
          <ChannelField value={channel} onChange={setChannel} disabled={busy} />
        </div>
        <button type="submit" className="btn-primary px-4 py-1.5 text-xs disabled:opacity-40" disabled={!patch || busy}>
          {t('admin.invite.save')}
        </button>
      </form>

      {kind === 'competition' && (
        <div className="mt-4">
          <p className="label">{t('admin.invite.fieldCompetition')}</p>
          <p className="text-sm text-neutral-200">{link.competitionName ?? link.competitionId}</p>
        </div>
      )}

      <div className="mt-5 border-t border-white/5 pt-4">
        <p className="label">{t('admin.invite.fieldLink')}</p>
        <div className="flex items-start justify-between gap-3">
          <p className="num min-w-0 break-all text-xs text-neutral-300">{url}</p>
          <CopyLinkButton link={link} onFail={onCopyFail} />
        </div>
        <div className="mt-3">
          <LinkQrCode url={url} filename={`prismx-${link.code}`} />
        </div>
      </div>

      <div className="mt-5 space-y-3 border-t border-white/5 pt-4">
        {/* 全局免费试用关闭时给出原因。没有这句提示，管理员打开了开关却一个试用都没
            发出去，页面上没有任何线索指向真正的原因（运营设置里的那个总闸）。开关本身
            仍可点——记录意图是有意义的，全局一开它立刻生效。
            With the global trial off, say why. Without the hint an admin flips this on,
            sees zero trials granted, and nothing points at the master gate in operations
            settings. The toggle still works — the intent takes effect once the global
            switch opens. */}
        <div className="flex items-center justify-between gap-3">
          <span className={`text-sm ${globalTrialEnabled ? 'text-neutral-300' : 'text-neutral-500'}`}>
            {t('admin.invite.fieldGrantsTrial')}
          </span>
          <Switch checked={link.grantsTrial} busy={busy} onChange={() => onToggleTrial()} />
        </div>
        {!globalTrialEnabled && (
          <p className="text-[11px] leading-snug text-neutral-500">{t('admin.invite.grantsTrialBlocked')}</p>
        )}
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm text-neutral-300">{t('admin.invite.fieldActive')}</span>
          <Switch checked={link.isActive} busy={busy} onChange={() => onToggleActive()} />
        </div>
      </div>

      <div className="mt-5 border-t border-white/5 pt-4">
        <p className="label">{t('admin.invite.fieldAgents')}</p>
        {kind === 'competition' ? (
          <p className="text-xs leading-relaxed text-neutral-500">{t('admin.invite.competitionNoAgents')}</p>
        ) : (
          <>
            {/* 代理不是角色，这里不动 role——见后端 InviteLinkAgent 模型注释。
                Agents are not a role — see the backend model's comment. */}
            <p className="text-xs leading-relaxed text-neutral-500">{t('admin.invite.assignHint')}</p>
            {agents.length > 0 ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {agents.map((a) => (
                  <span
                    key={a.userId}
                    className="inline-flex items-center gap-1 rounded-full bg-prism-500/15 px-2 py-0.5 text-xs text-prism-200"
                    title={a.email}
                  >
                    {a.nickname || a.email}
                    <button
                      type="button"
                      className="text-prism-300/70 hover:text-down disabled:opacity-40"
                      aria-label={t('admin.invite.unassign')}
                      disabled={busy}
                      onClick={() => onRequestUnassign(a.userId)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs text-neutral-500">{t('admin.invite.noAgents')}</p>
            )}
            <AgentPicker assignedIds={new Set(agents.map((a) => a.userId))} busy={busy} onAssign={onAssign} />
          </>
        )}
      </div>

      <div className="mt-5 grid grid-cols-3 gap-3 border-t border-white/5 pt-4 text-xs">
        <div>
          <p className="text-neutral-500">{t('admin.invite.colClicks')}</p>
          <p className="num text-lg text-neutral-100">{link.clicks}</p>
        </div>
        <div>
          <p className="text-neutral-500">{t('admin.invite.colRegistrations')}</p>
          <p className="num text-lg text-neutral-100">{link.registrations}</p>
        </div>
        {kind === 'competition' && (
          <div>
            <p className="text-neutral-500">{t('admin.competitionPromo.step.entries')}</p>
            <p className="num text-lg text-neutral-100">{link.entries}</p>
          </div>
        )}
      </div>
      <p className="mt-3 text-xs text-neutral-500">
        {t('admin.invite.fieldCreated')} · {fmtTime(link.createdAt)}
      </p>
    </AdminSheet>
  )
}
