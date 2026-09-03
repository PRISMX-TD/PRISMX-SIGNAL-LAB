// 管理后台「游戏化」页签：设置卡（三开关 + 下限）+ 榜单预览 + 用户检查器。
//
// 两个可翻开关（等级勋章 / 排行榜）走「只升不降、发出不收回」的铁律（见
// client.ts 的 setGamificationVisibility / updateGamificationSettings 注释）
// ——后端接口本身仍接受传 false，真正的闸门只有一处：翻到「开」之前必须
// window.confirm 一次。翻回「关」不设二次确认，与任务书口径一致（这不是
// 后端强制的单向锁，是前端刻意做的最后一道人工关卡）。比赛开关是 Phase 3
// 占位，永久禁用态展示，没有可翻的动作也就没有 confirm。
//
// 榜单预览卡不受任何开关限制——管理员打 /admin/gamification/leaderboard
// 本身就不看 leaderboardVisible，专为内测期核对数字用。
//
// 用户检查器复用成就页（AchievementsPage）的数据形状（GamificationMe），
// 但渲染成管理员要的"紧凑排查视图"：称号/等级一行、五组条件缩成勾/状态标签、
// 勋章墙缩成 40px 缩略图、胜率表不带折叠。没有抽取 AchievementsPage 的
// TaskRow/CheckIcon 复用——两边字号、有无进度条的诉求都不同，抽出来的公共
// 组件反而要塞一堆 variant props，不如各自维护一份简单的。
//
// The admin "gamification" tab: a settings card (three switches + baseline),
// a leaderboard preview, and a user inspector.
//
// The two flippable switches (badges/levels, leaderboard) follow the "up
// only, never revoked" rule (see the comments on setGamificationVisibility /
// updateGamificationSettings in client.ts) — the backend endpoint itself
// still accepts false; the one real gate is the confirm() before flipping to
// true. Flipping back to false needs no second confirmation, per the task
// brief (this is a deliberate front-end-only last check, not a
// backend-enforced one-way lock). The competitions switch is a Phase 3
// placeholder, permanently disabled — no action to flip, so no confirm.
//
// The leaderboard preview card isn't gated on any switch — the admin's own
// call to /admin/gamification/leaderboard doesn't consult
// leaderboardVisible; it exists specifically for verifying numbers during
// the beta window.
//
// The user inspector reuses AchievementsPage's data shape (GamificationMe) but
// renders it as the compact view an admin wants: title/level on one line, the
// five condition groups collapsed to check/state tags, the badge wall shrunk
// to 40px thumbnails, and the win-rate table always expanded (no toggle).
// AchievementsPage's TaskRow/CheckIcon aren't extracted for reuse — the two
// views want different sizing and progress-bar needs, and a shared component
// would just grow a pile of variant props instead of two small local ones.
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { adminApi } from '../../api/client'
import { localizeApiError } from '../../api/utils'
import { fmtPct } from '../winrate/shared'
import { SkeletonLine } from '../Skeleton'
import BadgeIcon from '../badges/BadgeIcon'
import Select from '../Select'
import type {
  AdminUser,
  GamificationMe,
  GamificationSettings,
  GamificationTask,
  LeaderboardBoard,
  LeaderboardPayload,
} from '../../api/types'

type SelectedUser = GamificationMe & { email: string }

type PreviewPeriod = 'week' | 'month'

// 预览周期下拉的选项固定为周/月，与用户端 LeaderboardPage 的 PERIODS 一致——
// 后端 period 参数本身是自由字符串，但目前只有这两档口径，管理端没必要开放
// 任意输入。
// The preview period dropdown is fixed to week/month, matching
// LeaderboardPage's PERIODS on the user side — the backend's period param is
// a free string, but only these two cadences exist today, so there's no
// reason to open up arbitrary input here.
const PREVIEW_PERIODS: PreviewPeriod[] = ['week', 'month']
const PREVIEW_BOARDS: LeaderboardBoard[] = ['return_pct', 'win_rate']

// score 是分数（0.124 = 12.4%），同 LeaderboardPage 的 fmtScorePct 口径——两处
// 各自维护一份而不抽公共模块，因为这是唯一的重复点，抽出去反而要多绕一层导入。
// score is a fraction (0.124 = 12.4%), matching LeaderboardPage's
// fmtScorePct — kept as a separate local copy rather than a shared module
// since this is the only overlap; extracting it would add an import hop for
// one line of logic.
function fmtScorePct(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}

// 一行开关：等级勋章 / 排行榜两个「可翻」开关复用的行布局，比赛开关是永久
// 禁用态，样式和交互都不同，单独写（见下方渲染处），不硬塞进这个组件。
// One toggle row: shared layout for the two flippable switches (badges/
// levels, leaderboard). The competitions switch is permanently disabled with
// different styling/interaction, so it's rendered separately below rather
// than forced through this component.
function SettingsToggleRow({
  label,
  checked,
  saving,
  onLabel,
  offLabel,
  onChange,
}: {
  label: string
  checked: boolean
  saving: boolean
  onLabel: string
  offLabel: string
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-sm text-neutral-300">{label}</span>
      <label className="flex cursor-pointer items-center gap-3">
        <span className={`text-xs ${checked ? 'text-up' : 'text-neutral-500'}`}>
          {checked ? onLabel : offLabel}
        </span>
        <span className="relative inline-flex items-center">
          <input
            type="checkbox"
            checked={checked}
            disabled={saving}
            onChange={(e) => onChange(e.target.checked)}
            className="peer sr-only"
          />
          <span className="h-6 w-11 rounded-full bg-white/10 transition peer-checked:bg-prism-500 peer-disabled:opacity-60" />
          <span className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition peer-checked:translate-x-5" />
        </span>
      </label>
    </div>
  )
}

function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--up)" strokeWidth="2.4"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 13l4 4L19 7" />
    </svg>
  )
}

// 进度数字格式化，同 AchievementsPage 的口径（整数不带小数点，小数最多两位）。
// Progress number formatting, matching AchievementsPage's rule (no decimals
// when whole, at most 2dp otherwise).
function fmtProgressNum(n: number): string {
  const rounded = Math.round(n * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)
}

function taskStateTagClass(state: 'locked' | 'pending' | 'done'): string {
  if (state === 'pending') return 'bg-white/[0.06] text-neutral-300'
  return 'bg-white/[0.03] text-neutral-500'
}

// 一行紧凑条件：名字 + 完成勾 / 状态标签 / 进度数字，三选一。
// One compact condition row: name plus a done check, a state tag, or a
// progress fraction — whichever applies.
function CompactTask({ task, t }: { task: GamificationTask; t: TFunction }) {
  const isWinrate = task.state !== undefined
  return (
    <li className="flex items-center justify-between gap-2 text-xs">
      <span className={task.done ? 'text-neutral-300' : 'text-neutral-500'}>
        {t(`gamification.tasks.${task.id}`)}
      </span>
      {task.done ? (
        <CheckIcon />
      ) : isWinrate && task.state ? (
        <span className={`tag shrink-0 text-[10px] ${taskStateTagClass(task.state)}`}>
          {t(`gamification.taskState.${task.state}`)}
        </span>
      ) : task.progressTarget != null ? (
        <span className="num shrink-0 text-[10px] text-neutral-500">
          {fmtProgressNum(task.progressNow ?? 0)}/{fmtProgressNum(task.progressTarget)}
        </span>
      ) : (
        <span className="tag shrink-0 bg-white/[0.03] text-[10px] text-neutral-500">—</span>
      )}
    </li>
  )
}

export default function GamificationPanel() {
  const { t } = useTranslation()

  // ---- 设置组：三开关 + 下限 / settings group: three switches + baseline ----
  // 与旧版单开关不同，这里改走 gamificationSettings/updateGamificationSettings
  // （Task 8 落地的 settings 端点），旧的 /visibility 端点留在 client.ts 里
  // 不删——它和 settings 共用同一份存储记录，读-合并-写不会互相清空。
  // Unlike the old single-switch version, this reads/writes through
  // gamificationSettings/updateGamificationSettings (the settings endpoint
  // from Task 8); the old /visibility endpoint stays in client.ts unused —
  // it shares the same stored record via read-merge-write, so nothing gets
  // clobbered either way.
  const [settings, setSettings] = useState<GamificationSettings | null>(null)
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [savingUserVisible, setSavingUserVisible] = useState(false)
  const [savingLeaderboardVisible, setSavingLeaderboardVisible] = useState(false)
  const [savingCompetitionsVisible, setSavingCompetitionsVisible] = useState(false)
  const [baselineDraft, setBaselineDraft] = useState('')
  const [savingBaseline, setSavingBaseline] = useState(false)
  const [minTradesReturnDraft, setMinTradesReturnDraft] = useState('')
  const [minTradesWinrateDraft, setMinTradesWinrateDraft] = useState('')
  const [savingTradeGates, setSavingTradeGates] = useState(false)

  useEffect(() => {
    let cancelled = false
    adminApi
      .gamificationSettings()
      .then((res) => {
        if (!cancelled) {
          setSettings(res)
          setBaselineDraft(String(res.minBaselineUsd))
          setMinTradesReturnDraft(String(res.minTradesReturn))
          setMinTradesWinrateDraft(String(res.minTradesWinrate))
        }
      })
      .catch((err) => {
        if (!cancelled) setSettingsError(err instanceof Error ? localizeApiError(err.message) : 'Load failed')
      })
      .finally(() => {
        if (!cancelled) setSettingsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 翻到「开」之前必须过 confirm 这一关；翻回「关」不设置二次确认——两个开关
  // 各自用各自领域的确认文案（等级勋章沿用旧版 confirmOpen，排行榜用新增的
  // confirmOpenBoard），见文件头注释里「只升不降、发出不收回」的口径。
  // Flipping to "open" must pass this confirm; flipping back needs none —
  // each switch uses its own domain's confirm copy (badges/levels reuses the
  // legacy confirmOpen, the leaderboard uses the new confirmOpenBoard). See
  // the file header for the "up only, never revoked" framing.
  const toggleUserVisible = async (next: boolean) => {
    if (next && !window.confirm(t('gamification.admin.confirmOpen'))) return
    setSavingUserVisible(true)
    setSettingsError(null)
    try {
      setSettings(await adminApi.updateGamificationSettings({ userVisible: next }))
    } catch (err) {
      setSettingsError(err instanceof Error ? localizeApiError(err.message) : 'Save failed')
    } finally {
      setSavingUserVisible(false)
    }
  }

  const toggleLeaderboardVisible = async (next: boolean) => {
    if (next && !window.confirm(t('leaderboard.admin.confirmOpenBoard'))) return
    setSavingLeaderboardVisible(true)
    setSettingsError(null)
    try {
      setSettings(await adminApi.updateGamificationSettings({ leaderboardVisible: next }))
    } catch (err) {
      setSettingsError(err instanceof Error ? localizeApiError(err.message) : 'Save failed')
    } finally {
      setSavingLeaderboardVisible(false)
    }
  }

  const toggleCompetitionsVisible = async (next: boolean) => {
    if (next && !window.confirm(t('leaderboard.admin.confirmOpenCompetitions'))) return
    setSavingCompetitionsVisible(true)
    setSettingsError(null)
    try {
      setSettings(await adminApi.updateGamificationSettings({ competitionsVisible: next }))
    } catch (err) {
      setSettingsError(err instanceof Error ? localizeApiError(err.message) : 'Save failed')
    } finally {
      setSavingCompetitionsVisible(false)
    }
  }

  // 下限输入框自己的保存按钮，只在数值合法且与当前设置不同时才可点——两个开关
  // 各自单字段 PATCH 已经天然「只送变更字段」，这里的 dirty 判断是同一条铁律
  // 用在数字输入上的版本：没改就不送。
  // The baseline input has its own save button, enabled only when the value
  // is valid and differs from the current setting — the two switches already
  // send single-field PATCHes naturally; this dirty check is the same "only
  // send what changed" rule applied to the numeric input.
  // 后端拒绝 0（下限必须为正数），>= 0 会放过 0 让保存按钮可点、点了却被 400
  // 打回来——校验口径改成 > 0，和后端一致，按钮直接在 0 上就disable。
  // The backend rejects 0 (the baseline must be positive); >= 0 would let 0
  // through and enable Save only to get bounced by a 400. Validation now
  // matches the backend at > 0, so the button disables right at 0.
  const baselineNum = Number(baselineDraft)
  const baselineValid = baselineDraft.trim() !== '' && Number.isFinite(baselineNum) && baselineNum > 0
  const baselineDirty = settings != null && baselineValid && baselineNum !== settings.minBaselineUsd

  const saveBaseline = async () => {
    if (!baselineDirty) return
    setSavingBaseline(true)
    setSettingsError(null)
    try {
      const res = await adminApi.updateGamificationSettings({ minBaselineUsd: baselineNum })
      setSettings(res)
      setBaselineDraft(String(res.minBaselineUsd))
    } catch (err) {
      setSettingsError(err instanceof Error ? localizeApiError(err.message) : 'Save failed')
    } finally {
      setSavingBaseline(false)
    }
  }

  // 入榜笔数门槛（收益榜/胜率榜各一个），同下限输入框一样的 dirty-gated 保存：
  // 只在整数 >= 1 时视为合法（后端 400 的边界同这里一致），只把真的改过的字段
  // 塞进 PATCH——两个字段没必要拆两个按钮，一次 PATCH 只带变更的那些即可。
  // Trade-count gates for the two boards, same dirty-gated save as the
  // baseline input: valid only as an integer >= 1 (matches the backend's 400
  // boundary), and only the fields actually changed go into the PATCH — no
  // need for two separate buttons since a single PATCH already omits the
  // untouched one.
  const minTradesReturnNum = Number(minTradesReturnDraft)
  const minTradesReturnValid =
    minTradesReturnDraft.trim() !== '' && Number.isInteger(minTradesReturnNum) && minTradesReturnNum >= 1
  const minTradesReturnDirty =
    settings != null && minTradesReturnValid && minTradesReturnNum !== settings.minTradesReturn

  const minTradesWinrateNum = Number(minTradesWinrateDraft)
  const minTradesWinrateValid =
    minTradesWinrateDraft.trim() !== '' && Number.isInteger(minTradesWinrateNum) && minTradesWinrateNum >= 1
  const minTradesWinrateDirty =
    settings != null && minTradesWinrateValid && minTradesWinrateNum !== settings.minTradesWinrate

  const tradeGatesDirty = minTradesReturnDirty || minTradesWinrateDirty
  const tradeGatesValid = minTradesReturnValid && minTradesWinrateValid

  const saveTradeGates = async () => {
    if (!tradeGatesDirty || !tradeGatesValid) return
    setSavingTradeGates(true)
    setSettingsError(null)
    try {
      const patch: { minTradesReturn?: number; minTradesWinrate?: number } = {}
      if (minTradesReturnDirty) patch.minTradesReturn = minTradesReturnNum
      if (minTradesWinrateDirty) patch.minTradesWinrate = minTradesWinrateNum
      const res = await adminApi.updateGamificationSettings(patch)
      setSettings(res)
      setMinTradesReturnDraft(String(res.minTradesReturn))
      setMinTradesWinrateDraft(String(res.minTradesWinrate))
    } catch (err) {
      setSettingsError(err instanceof Error ? localizeApiError(err.message) : 'Save failed')
    } finally {
      setSavingTradeGates(false)
    }
  }

  // ---- 榜单预览 / leaderboard preview ----
  // 内测核数工具：开关关着也能看，因为管理员打这条接口本身不受
  // leaderboardVisible 门控（见 client.ts 的 gamificationLeaderboard 注释）。
  // A beta-window verification tool: usable while the switch is off, because
  // the admin's own call to this endpoint isn't gated on leaderboardVisible
  // (see the comment on gamificationLeaderboard in client.ts).
  const [previewBoard, setPreviewBoard] = useState<LeaderboardBoard>('return_pct')
  const [previewPeriod, setPreviewPeriod] = useState<PreviewPeriod>('week')
  const [previewData, setPreviewData] = useState<LeaderboardPayload | null>(null)
  const [previewLoading, setPreviewLoading] = useState(true)
  const [previewError, setPreviewError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setPreviewLoading(true)
    setPreviewError(null)
    adminApi
      .gamificationLeaderboard(previewBoard, previewPeriod)
      .then((res) => {
        if (!cancelled) setPreviewData(res)
      })
      .catch((err) => {
        if (!cancelled) {
          setPreviewError(err instanceof Error ? localizeApiError(err.message) : 'Load failed')
          setPreviewData(null)
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [previewBoard, previewPeriod])

  // ---- 用户检查器 / user inspector ----
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<AdminUser[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<SelectedUser | null>(null)
  const [selectedLoading, setSelectedLoading] = useState(false)
  const [selectedError, setSelectedError] = useState<string | null>(null)

  const handleSearch = async (e: FormEvent) => {
    e.preventDefault()
    if (!query.trim()) return
    setSearching(true)
    setSearchError(null)
    try {
      const res = await adminApi.listUsers({ q: query.trim(), limit: 20 })
      setResults(res.users)
    } catch (err) {
      setSearchError(err instanceof Error ? localizeApiError(err.message) : 'Load failed')
    } finally {
      setSearching(false)
    }
  }

  const selectUser = async (id: string) => {
    setSelectedId(id)
    setSelected(null)
    setSelectedError(null)
    setSelectedLoading(true)
    try {
      setSelected(await adminApi.gamificationUser(id))
    } catch (err) {
      setSelectedError(err instanceof Error ? localizeApiError(err.message) : 'Load failed')
    } finally {
      setSelectedLoading(false)
    }
  }

  return (
    <div className="space-y-5">
      {/* 设置卡：三开关 + 下限 / settings card: three switches + baseline */}
      <div className="glass p-5">
        <h3 className="font-display text-lg font-semibold text-neutral-100">
          {t('gamification.admin.visibility')}
        </h3>
        {settingsLoading ? (
          <div className="mt-3 space-y-3">
            <SkeletonLine width="80%" />
            <SkeletonLine width="80%" />
            <SkeletonLine width="80%" />
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            <SettingsToggleRow
              label={t('gamification.admin.visibility')}
              checked={!!settings?.userVisible}
              saving={savingUserVisible}
              onLabel={t('gamification.admin.visibleOn')}
              offLabel={t('gamification.admin.visibleOff')}
              onChange={toggleUserVisible}
            />
            <SettingsToggleRow
              label={t('leaderboard.admin.leaderboardSwitch')}
              checked={!!settings?.leaderboardVisible}
              saving={savingLeaderboardVisible}
              onLabel={t('gamification.admin.visibleOn')}
              offLabel={t('gamification.admin.visibleOff')}
              onChange={toggleLeaderboardVisible}
            />
            {/* 比赛开关：Phase 3 已上线，与前两个开关同一套「翻开要 confirm、只升不降」。
                这里曾是 Phase 2 留的禁用占位，Phase 3 合并时漏了激活——完整性审计抓出。 */}
            {/* Competitions switch: live since Phase 3, same confirm-on-open discipline
                as the other two. Was a disabled placeholder left over from Phase 2. */}
            <SettingsToggleRow
              label={t('leaderboard.admin.competitionsSwitch')}
              checked={!!settings?.competitionsVisible}
              saving={savingCompetitionsVisible}
              onLabel={t('gamification.admin.visibleOn')}
              offLabel={t('gamification.admin.visibleOff')}
              onChange={toggleCompetitionsVisible}
            />

            <div className="flex flex-wrap items-end gap-3 border-t border-white/5 pt-3">
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                {t('leaderboard.admin.minBaseline')}
                <input
                  type="number"
                  min="0"
                  className="input w-40"
                  value={baselineDraft}
                  onChange={(e) => setBaselineDraft(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="btn-primary px-4 py-1.5 text-xs disabled:opacity-40"
                disabled={!baselineDirty || savingBaseline}
                onClick={saveBaseline}
              >
                {savingBaseline ? t('common.loading') : t('common.save')}
              </button>
            </div>

            {/* 入榜笔数门槛：内测期放松用，正式面向用户前记得改回默认值（见 hint 文案）。 */}
            {/* Trade-count board gates: loosen these for the beta, remember to restore
                the defaults before opening the boards to real users (see the hint copy). */}
            <div className="flex flex-wrap items-end gap-3 border-t border-white/5 pt-3">
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                {t('leaderboard.admin.minTradesReturn')}
                <input
                  type="number"
                  min="1"
                  step="1"
                  className="input w-40"
                  value={minTradesReturnDraft}
                  onChange={(e) => setMinTradesReturnDraft(e.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500">
                {t('leaderboard.admin.minTradesWinrate')}
                <input
                  type="number"
                  min="1"
                  step="1"
                  className="input w-40"
                  value={minTradesWinrateDraft}
                  onChange={(e) => setMinTradesWinrateDraft(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="btn-primary px-4 py-1.5 text-xs disabled:opacity-40"
                disabled={!tradeGatesDirty || !tradeGatesValid || savingTradeGates}
                onClick={saveTradeGates}
              >
                {savingTradeGates ? t('common.loading') : t('common.save')}
              </button>
              <p className="w-full text-xs text-neutral-500">{t('leaderboard.admin.minTradesHint')}</p>
            </div>
          </div>
        )}
        {settingsError && <p className="mt-2 text-sm text-down">{settingsError}</p>}
      </div>

      {/* 榜单预览 / leaderboard preview */}
      <div className="glass p-5">
        <h3 className="font-display text-lg font-semibold text-neutral-100">
          {t('leaderboard.admin.preview')}
        </h3>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Select
            ariaLabel={t('leaderboard.admin.pickBoard')}
            value={previewBoard}
            options={PREVIEW_BOARDS.map((b) => ({ value: b, label: t(`leaderboard.boards.${b}`) }))}
            onChange={(v) => setPreviewBoard(v as LeaderboardBoard)}
          />
          <Select
            ariaLabel={t('leaderboard.admin.pickPeriod')}
            value={previewPeriod}
            options={PREVIEW_PERIODS.map((p) => ({ value: p, label: t(`leaderboard.periods.${p}`) }))}
            onChange={(v) => setPreviewPeriod(v as PreviewPeriod)}
          />
        </div>

        {previewError && <p className="mt-2 text-sm text-down">{previewError}</p>}

        {previewLoading ? (
          <div className="mt-4 space-y-2" aria-busy="true">
            <SkeletonLine width="100%" />
            <SkeletonLine width="100%" />
            <SkeletonLine width="100%" />
          </div>
        ) : previewData && previewData.rows.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-neutral-500">
                  <th className="py-1.5 pr-4 font-medium">{t('leaderboard.colRank')}</th>
                  <th className="py-1.5 pr-4 font-medium">{t('leaderboard.colTrader')}</th>
                  <th className="py-1.5 pr-4 font-medium">{t('leaderboard.colAccount')}</th>
                  <th className="py-1.5 pr-4 font-medium">{t(`leaderboard.colScore.${previewBoard}`)}</th>
                  <th className="py-1.5 font-medium">{t('leaderboard.colSample')}</th>
                </tr>
              </thead>
              <tbody>
                {previewData.rows.map((row) => (
                  <tr key={row.rank} className="border-t border-white/5">
                    <td className="num py-1.5 pr-4 text-neutral-300">{row.rank}</td>
                    <td className="py-1.5 pr-4 text-neutral-200">{row.displayName}</td>
                    <td className="num py-1.5 pr-4 text-neutral-400">{row.login}</td>
                    <td className="num py-1.5 pr-4 text-neutral-100">{fmtScorePct(row.score)}</td>
                    <td className="num py-1.5 text-neutral-500">{row.sample}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !previewError && <p className="mt-4 text-sm text-neutral-400">{t('leaderboard.empty')}</p>
        )}
      </div>

      {/* 用户检查器 / user inspector */}
      <div className="glass p-5">
        <h3 className="font-display text-lg font-semibold text-neutral-100">{t('gamification.admin.inspect')}</h3>
        <form onSubmit={handleSearch} className="mt-3 flex flex-wrap items-center gap-3">
          <input
            className="input flex-1 sm:max-w-xs"
            placeholder={t('gamification.admin.searchUser')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" className="btn-primary px-5 py-2 text-sm disabled:opacity-40" disabled={searching}>
            {searching ? t('common.loading') : t('admin.search')}
          </button>
        </form>
        {searchError && <p className="mt-2 text-sm text-down">{searchError}</p>}

        {results.length > 0 && (
          <ul className="mt-3 max-h-64 divide-y divide-white/5 overflow-y-auto rounded-lg border border-white/5">
            {results.map((u) => (
              <li key={u.id}>
                <button
                  type="button"
                  onClick={() => selectUser(u.id)}
                  className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition hover:bg-white/[0.03] ${
                    selectedId === u.id ? 'bg-prism-600/[0.08] text-prism-200' : 'text-neutral-300'
                  }`}
                >
                  <span className="truncate font-mono text-xs">{u.email}</span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="tag bg-white/5 text-[11px] text-neutral-400">{u.role}</span>
                    <span className="tag bg-white/5 text-[11px] text-neutral-400">{u.plan}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {selectedLoading && (
          <div className="mt-4 space-y-3" aria-busy="true">
            <SkeletonLine width="60%" /><SkeletonLine width="90%" /><SkeletonLine width="80%" />
          </div>
        )}
        {selectedError && <p className="mt-3 text-sm text-down">{selectedError}</p>}

        {selected && !selectedLoading && (
          <div className="mt-4 space-y-4 border-t border-white/5 pt-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className="truncate font-mono text-xs text-neutral-400">{selected.email}</span>
              <span className="tag bg-prism-600/20 text-xs text-prism-300">
                {t('gamification.levelLabel')} L{selected.level}
              </span>
              <span className="text-sm font-semibold text-neutral-100">
                {t(`gamification.titles.${selected.title}`)}
              </span>
            </div>

            {/* 五组条件完成态 / the five condition groups */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {selected.groups.map((group) => (
                <div key={group.group} className="rounded-lg bg-white/[0.02] p-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                    {t(`gamification.groups.${group.group}`)}
                  </p>
                  <ul className="mt-2 space-y-1.5">
                    {group.tasks.map((task) => (
                      <CompactTask key={task.id} task={task} t={t} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            {/* 勋章墙缩略 / badge wall thumbnails */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
                {t('gamification.badgeWall')}
              </p>
              <div className="mt-2 grid grid-cols-6 gap-2 sm:grid-cols-8 md:grid-cols-10">
                {selected.badges.map((b) => (
                  <div key={b.id} className="flex flex-col items-center gap-1" title={t(`gamification.badges.${b.id}.name`)}>
                    <BadgeIcon id={b.id} rarity={b.rarity} earned={b.earned} size={40} />
                  </div>
                ))}
              </div>
            </div>

            {/* 综合胜率 + perLogin 构成表 / combined win rate + per-login table */}
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-neutral-500">{t('gamification.winRateCard.combined')}</span>
                <span className="num text-lg font-bold text-up">
                  {selected.winRate.value != null ? fmtPct(selected.winRate.value) : '—'}
                </span>
              </div>
              {selected.winRate.perLogin.length > 0 && (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="text-neutral-500">
                        <th className="py-1.5 pr-4 font-medium">{t('gamification.winRateCard.colLogin')}</th>
                        <th className="py-1.5 pr-4 font-medium">{t('gamification.winRateCard.colTrades')}</th>
                        <th className="py-1.5 pr-4 font-medium">{t('gamification.winRateCard.colWins')}</th>
                        <th className="py-1.5 pr-4 font-medium">{t('gamification.winRateCard.colWinRate')}</th>
                        <th className="py-1.5 font-medium">{t('gamification.winRateCard.colExcluded')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.winRate.perLogin.map((row) => (
                        <tr key={row.login} className="border-t border-white/5">
                          <td className="num py-1.5 pr-4 text-neutral-200">{row.login}</td>
                          <td className="num py-1.5 pr-4 text-neutral-300">{row.trades}</td>
                          <td className="num py-1.5 pr-4 text-neutral-300">{row.wins}</td>
                          <td className="num py-1.5 pr-4 text-neutral-300">
                            {row.winRate != null ? fmtPct(row.winRate) : '—'}
                          </td>
                          <td className="num py-1.5 text-neutral-500">{row.excluded}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
