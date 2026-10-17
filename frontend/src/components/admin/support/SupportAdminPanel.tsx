// 后台「客服」页签（设计 §7）：成员 / 跟进分配 / 待审批 / 业绩 / 模板 / 设置六个子页，外加去客服台的入口。
// The admin "Support" tab (design §7): members / assign / approvals / performance / templates /
// settings, plus a shortcut into the support desk itself.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { segBtn } from '../../../utils/segBtn'
import { useToast } from '../../../utils/useToast'
import ToastBar from '../invite/ToastBar'
import ApprovalsPanel from './ApprovalsPanel'
import AssignPanel from './AssignPanel'
import PerformancePanel from './PerformancePanel'
import StaffPanel from './StaffPanel'
import TemplatesPanel from './TemplatesPanel'

type Sub = 'staff' | 'assign' | 'approvals' | 'performance' | 'templates'
const SUBS: Sub[] = ['staff', 'assign', 'approvals', 'performance', 'templates']

export default function SupportAdminPanel({
  assignPreset,
  onAssignPresetCleared,
}: {
  // 用户管理批量条「分配跟进」带过来的人 / users carried over by the Users bulk bar
  assignPreset: string[]
  onAssignPresetCleared: () => void
}) {
  const { t } = useTranslation()
  const [sub, setSub] = useState<Sub>(assignPreset.length ? 'assign' : 'staff')
  const { toast, showToast } = useToast()

  return (
    <div>
      <ToastBar toast={toast} className="mb-4" />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="-mx-1 flex flex-1 gap-1.5 overflow-x-auto px-1 no-scrollbar" role="tablist">
          {SUBS.map((s) => (
            <button key={s} type="button" role="tab" aria-selected={sub === s} className={`${segBtn(sub === s)} shrink-0`} onClick={() => setSub(s)}>
              {t(`admin.support.sub.${s}`)}
            </button>
          ))}
        </div>
        <Link to="/support-desk" className="btn-ghost shrink-0 px-3 py-1.5 text-xs">
          {t('admin.support.openDesk')} &rarr;
        </Link>
      </div>
      {sub === 'staff' && <StaffPanel onToast={showToast} />}
      {sub === 'assign' && <AssignPanel presetUserIds={assignPreset} onPresetCleared={onAssignPresetCleared} onToast={showToast} />}
      {sub === 'approvals' && <ApprovalsPanel onToast={showToast} />}
      {sub === 'performance' && <PerformancePanel onToast={showToast} />}
      {sub === 'templates' && <TemplatesPanel onToast={showToast} />}
    </div>
  )
}
