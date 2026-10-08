// 比赛编辑页「公开推广」区的下半部分（设计 §4 管理端）：预览公开页、完整性报告入口、
// 本场推广链接（新建：标记 + 渠道；复制；启停）、转化漏斗。上半部分（public_view 开关、
// 开户链接）是表单字段，跟「保存」一起提交，在 CompetitionsPanel 里。
// 父组件以 key={comp.id} 挂载：换一场比赛整块重建，不会把上一场的链接 / 漏斗串过来。
// 写操作同邀请链接页签：单个 busyId 闸门，所有写按钮按 busyId !== null 禁用。
// The lower half of the competition editor's promotion section (design §4): preview,
// integrity entry, this competition's promo links (create with label + channel, copy,
// toggle) and the funnel. The public switch and account link are form fields saved with
// the form, in CompetitionsPanel. Mounted with key={comp.id}, so switching competitions
// rebuilds it. Writes share the invite tab's single busyId gate.
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { SkeletonLine } from '../../Skeleton'
import Switch from '../../Switch'
import { adminApi } from '../../../api/client'
import { localizeApiError } from '../../../api/utils'
import { promoLinkUrl } from '../../../utils/promoLinkUrl'
import type { CompetitionAdminRow, CompetitionFunnel, InviteLink } from '../../../api/types'
import ChannelField from '../invite/ChannelField'
import CopyLinkButton from '../invite/CopyLinkButton'
import { normalizeChannel } from '../invite/inviteLinkLogic'
import IntegrityModal from './IntegrityModal'
import PublicPreviewModal from './PublicPreviewModal'
import { FUNNEL_STEPS, convRate, funnelTotals } from './promoLogic'

export default function CompetitionPromoSection({
  comp,
  onToast,
}: {
  comp: CompetitionAdminRow
  onToast: (kind: 'ok' | 'err', text: string) => void
}) {
  const { t } = useTranslation()
  const [links, setLinks] = useState<InviteLink[] | null>(null)
  const [linksError, setLinksError] = useState<string | null>(null)
  const [funnel, setFunnel] = useState<CompetitionFunnel | null>(null)
  const [funnelError, setFunnelError] = useState<string | null>(null)
  const [funnelLoading, setFunnelLoading] = useState(false)
  // 'create' 或正在保存的链接 id / 'create' or the link id being saved
  const [busyId, setBusyId] = useState<string | null>(null)
  const [label, setLabel] = useState('')
  const [channel, setChannel] = useState('')
  const [modal, setModal] = useState<'preview' | 'integrity' | null>(null)

  const errText = (err: unknown, fallbackKey: string) =>
    err instanceof Error ? localizeApiError(err.message) : t(fallbackKey)

  const loadFunnel = () => {
    setFunnelLoading(true)
    setFunnelError(null)
    adminApi
      .competitionFunnel(comp.id)
      .then(setFunnel)
      .catch((err: unknown) => setFunnelError(errText(err, 'admin.loadError')))
      .finally(() => setFunnelLoading(false))
  }

  useEffect(() => {
    adminApi
      .listInviteLinks({ competitionId: comp.id })
      .then((res) => setLinks(res.links))
      .catch((err: unknown) => {
        setLinks([])
        setLinksError(errText(err, 'admin.loadError'))
      })
    loadFunnel()
    // 父组件按 comp.id 加 key 重挂载，这里只需要首次加载。
    // The parent remounts per comp.id via key; first load only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const create = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = label.trim()
    if (!trimmed || busyId) return
    setBusyId('create')
    try {
      const link = await adminApi.createInviteLink({
        label: trimmed,
        channel: normalizeChannel(channel),
        competitionId: comp.id,
      })
      setLinks((prev) => [link, ...(prev ?? [])])
      setLabel('')
      setChannel('')
      onToast('ok', t('admin.saved'))
    } catch (err) {
      onToast('err', errText(err, 'admin.saveError'))
    } finally {
      setBusyId(null)
    }
  }

  const toggleActive = async (l: InviteLink) => {
    if (busyId) return
    setBusyId(l.id)
    try {
      const updated = await adminApi.updateInviteLink(l.id, { isActive: !l.isActive })
      setLinks((prev) => (prev ?? []).map((x) => (x.id === l.id ? updated : x)))
      onToast('ok', t('admin.saved'))
    } catch (err) {
      onToast('err', errText(err, 'admin.saveError'))
    } finally {
      setBusyId(null)
    }
  }

  const copyFailed = () => onToast('err', t('admin.invite.copyFailed'))
  const totals = funnel ? funnelTotals(funnel) : null

  return (
    <div className="glass p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-display text-lg font-semibold text-neutral-100">
          {t('admin.competitionPromo.title')} · <span className="text-neutral-400">{comp.name}</span>
        </h3>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setModal('preview')}>
            {t('admin.competitionPromo.preview')}
          </button>
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setModal('integrity')}>
            {t('admin.competitionPromo.integrity')}
          </button>
        </div>
      </div>

      {/* 本场推广链接 / this competition's promo links */}
      <h4 className="mt-5 text-sm font-semibold text-neutral-200">{t('admin.competitionPromo.links')}</h4>
      <p className="mt-1 text-xs text-neutral-500">{t('admin.competitionPromo.linksHint')}</p>
      <form onSubmit={create} className="mt-3 grid gap-3 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto] md:items-start">
        <input
          className="input w-full"
          placeholder={t('admin.competitionPromo.labelPlaceholder')}
          value={label}
          maxLength={64}
          onChange={(e) => setLabel(e.target.value)}
        />
        <ChannelField value={channel} onChange={setChannel} disabled={busyId !== null} />
        <button
          type="submit"
          className="btn-primary px-4 py-2 text-xs disabled:opacity-40"
          disabled={!label.trim() || busyId !== null}
        >
          {t('admin.competitionPromo.createLink')}
        </button>
      </form>
      {linksError && <p className="mt-2 text-sm text-down">{linksError}</p>}
      {links == null ? (
        <div className="mt-3 space-y-2">
          <SkeletonLine width="100%" />
          <SkeletonLine width="80%" />
        </div>
      ) : links.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-400">{t('admin.competitionPromo.linksEmpty')}</p>
      ) : (
        <div className="mt-3">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-neutral-500">
                <th className="py-1.5 pr-4 font-medium">{t('admin.competitionPromo.colLink')}</th>
                <th className="py-1.5 pr-4 font-medium">{t('admin.competitionPromo.step.clicks')}</th>
                <th className="py-1.5 pr-4 font-medium">{t('admin.competitionPromo.step.registrations')}</th>
                <th className="py-1.5 pr-4 font-medium">{t('admin.competitionPromo.step.entries')}</th>
                <th className="py-1.5 pr-4 font-medium">{t('admin.competitionPromo.colActive')}</th>
                <th className="py-1.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {links.map((l) => (
                <tr key={l.id} className="border-t border-white/5 align-top">
                  <td className="max-w-[16rem] py-1.5 pr-4">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold text-neutral-100">{l.label}</span>
                      {l.channel && (
                        <span className="rounded-full border border-white/10 px-1.5 py-0.5 text-[10px] text-neutral-400">
                          {l.channel}
                        </span>
                      )}
                    </div>
                    <div className="num truncate text-[11px] text-neutral-500" title={promoLinkUrl(l)}>
                      {promoLinkUrl(l)}
                    </div>
                  </td>
                  <td className="num py-1.5 pr-4 text-neutral-200">{l.clicks}</td>
                  <td className="num py-1.5 pr-4 text-neutral-200">{l.registrations}</td>
                  <td className="num py-1.5 pr-4 text-neutral-200">{l.entries}</td>
                  <td className="py-1.5 pr-4">
                    <Switch checked={l.isActive} busy={busyId === l.id} disabled={busyId !== null} onChange={() => void toggleActive(l)} />
                  </td>
                  <td className="py-1.5">
                    <CopyLinkButton link={l} onFail={copyFailed} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 转化漏斗 / funnel */}
      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-neutral-200">{t('admin.competitionPromo.funnel')}</h4>
        <button
          type="button"
          className="btn-ghost px-3 py-1 text-xs disabled:opacity-40"
          disabled={funnelLoading}
          onClick={loadFunnel}
        >
          {funnelLoading ? t('common.loading') : t('admin.competitionPromo.refresh')}
        </button>
      </div>
      <p className="mt-1 text-xs text-neutral-500">{t('admin.competitionPromo.funnelNote')}</p>
      {funnelError && <p className="mt-2 text-sm text-down">{funnelError}</p>}
      {funnel == null ? (
        !funnelError && (
          <div className="mt-3 space-y-2">
            <SkeletonLine width="100%" />
            <SkeletonLine width="80%" />
          </div>
        )
      ) : funnel.links.length === 0 && totals && totals.views === 0 ? (
        <p className="mt-3 text-sm text-neutral-400">{t('admin.competitionPromo.funnelEmpty')}</p>
      ) : (
        <>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead>
                <tr className="text-neutral-500">
                  <th className="py-1.5 pr-4 font-medium">{t('admin.competitionPromo.colLink')}</th>
                  {FUNNEL_STEPS.map((s) => (
                    <th key={s} className="py-1.5 pr-4 font-medium">
                      {t(`admin.competitionPromo.step.${s}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {funnel.links.map((row) => (
                  <tr key={row.code} className="border-t border-white/5">
                    <td className="py-1.5 pr-4 text-neutral-200">
                      {row.label}
                      {row.channel && <span className="ml-1.5 text-[10px] text-neutral-500">{row.channel}</span>}
                    </td>
                    {FUNNEL_STEPS.map((s) => (
                      <td key={s} className="num py-1.5 pr-4 text-neutral-300">
                        {row[s]}
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="border-t border-white/5">
                  <td className="py-1.5 pr-4 italic text-neutral-500">{t('admin.competitionPromo.noRef')}</td>
                  {FUNNEL_STEPS.map((s) => (
                    <td key={s} className="num py-1.5 pr-4 text-neutral-500">
                      {s === 'views' || s === 'ctas' || s === 'openAccounts' ? funnel.noRef[s] : '—'}
                    </td>
                  ))}
                </tr>
                {totals && (
                  <tr className="border-t border-white/10 font-semibold">
                    <td className="py-1.5 pr-4 text-neutral-200">{t('admin.competitionPromo.total')}</td>
                    {FUNNEL_STEPS.map((s) => (
                      <td key={s} className="num py-1.5 pr-4 text-neutral-100">
                        {totals[s]}
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {totals && (
            <p className="mt-2 text-xs text-prism-300">
              {t('admin.competitionPromo.conv', {
                reg: convRate(totals.registrations, totals.clicks),
                entry: convRate(totals.entries, totals.registrations),
              })}
            </p>
          )}
        </>
      )}

      {modal === 'preview' && <PublicPreviewModal compId={comp.id} onClose={() => setModal(null)} />}
      {modal === 'integrity' && <IntegrityModal compId={comp.id} onClose={() => setModal(null)} />}
    </div>
  )
}
