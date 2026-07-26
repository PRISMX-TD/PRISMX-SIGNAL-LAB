// 新建策略的第一步：从预设起步，还是从空白开始。
//
// 预设就是 10 个老模板的规则树（后端 presets.PRESET_RULES，经 GET
// /strategies/templates 的 presets 字段下发）。载入后规则树完全可改——预设只是
// 一组初值，不是不可动的黑盒，这正是本次改造把「模板 + 参数表单」换成「AST +
// 构建器」的意义。
//
// Step one of creating a strategy: start from a preset, or from blank.
//
// A preset is one of the ten legacy templates' rule trees (backend
// presets.PRESET_RULES, delivered in the `presets` field of GET
// /strategies/templates). Once loaded the tree is fully editable — a preset is a
// set of starting values, not an opaque box. That's the whole point of replacing
// "template + param form" with "AST + builder".
import { useTranslation } from 'react-i18next'
import type { StrategyTemplateKey } from '../../api/types'

export interface PresetPickerProps {
  // 可选预设。由页面按 GET /templates 的 presets 键集合算好并本地化标签。
  // Selectable presets, derived by the page from the `presets` key set of
  // GET /templates, with labels already localized.
  options: { key: StrategyTemplateKey; label: string }[]
  loading: boolean
  // 拉取预设失败时的消息。失败不阻塞「从空白开始」——预设是便利项，不是前提。
  // Message shown when fetching presets failed. A failure never blocks "start
  // blank": presets are a convenience, not a prerequisite.
  error: string | null
  // null = 从空白开始
  // null means start from blank
  onStart: (template: StrategyTemplateKey | null) => void
  onCancel: () => void
}

export default function PresetPicker({ options, loading, error, onStart, onCancel }: PresetPickerProps) {
  const { t } = useTranslation()

  return (
    <section className="glass mb-5 p-5">
      <h4 className="text-sm font-semibold text-slate-300">{t('strategy.presetStartTitle')}</h4>
      <p className="mt-2 max-w-2xl text-xs leading-relaxed text-slate-500">{t('strategy.presetStartHint')}</p>

      <button
        type="button"
        onClick={() => onStart(null)}
        className="mt-4 rounded-lg border border-prism-500/40 bg-prism-600/15 px-4 py-2 text-sm text-prism-200 transition hover:bg-prism-600/25"
      >
        {t('strategy.presetStartBlank')}
      </button>

      <div className="mt-4 border-t border-white/10 pt-4">
        <span className="text-[11px] uppercase tracking-wide text-slate-500">{t('strategy.presetStartFrom')}</span>
        {loading ? (
          <p className="mt-2 text-xs text-slate-500">{t('strategy.presetLoading')}</p>
        ) : error ? (
          <p className="mt-2 text-xs text-amber-200">{error}</p>
        ) : options.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">{t('strategy.presetNone')}</p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {options.map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => onStart(o.key)}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition hover:border-prism-400/50 hover:text-prism-200"
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onCancel}
        className="mt-5 rounded-lg border border-white/10 bg-white/5 px-4 py-1.5 text-xs text-slate-400 transition hover:text-white"
      >
        {t('common.cancel')}
      </button>
    </section>
  )
}
