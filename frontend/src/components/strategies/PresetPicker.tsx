// 新建策略的第一步：从预设起步，还是从空白开始。
//
// 预设就是 6 条新手条件组合（后端 presets.PRESET_CONDITIONS，经 GET
// /strategies/templates 的 presets 字段下发，只含 logic 与 conditions，品种周期
// 由用户自己选）。载入后条件完全可改——预设只是一组初值，不是不可动的黑盒，这正是
// 本次改造把「模板 + 参数表单」换成「条件列表编辑器」的意义。
//
// Step one of creating a strategy: start from a preset, or from blank.
//
// A preset is one of the six beginner condition sets (backend
// presets.PRESET_CONDITIONS, delivered in the `presets` field of GET
// /strategies/templates as logic + conditions only, with the user picking the
// symbol and interval). Once loaded the conditions are fully editable — a preset
// is a set of starting values, not an opaque box. That's the whole point of
// replacing "template + param form" with a condition-list editor.
import { useTranslation } from 'react-i18next'
import type { StrategyTemplateKey } from '../../api/types'

export interface PresetPickerProps {
  // 可选预设。由页面按 GET /templates 的 presets 键集合算好并本地化标签与说明。
  // 说明文案（templateXxxDesc）此前只存在于 i18n 里没有出口，新手看到的是六个
  // 只有名字的按钮；卡片化之后它是"这个预设在干什么"的唯一来源。
  // Selectable presets, derived by the page from the `presets` key set of
  // GET /templates, with label and description already localized. The
  // descriptions (templateXxxDesc) existed in i18n with no surface: a beginner
  // saw six name-only buttons. On a card they are the only answer to "what does
  // this preset actually do".
  options: { key: StrategyTemplateKey; label: string; desc: string }[]
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
      <h3 className="font-display text-lg font-semibold text-neutral-100">{t('strategy.presetStartTitle')}</h3>

      {/* 推荐预设在前、空白在后：新手的默认路径是"挑一个看得懂的改"，而"从空白
          开始"要求先知道自己想用哪些指标。此前两者的视觉权重正好相反——空白是
          唯一那个紫色实心按钮，预设是一排小灰按钮。
          Presets lead and blank follows: a beginner's default path is "take one
          you can read and tweak it", while starting blank presumes you already
          know which indicators you want. The weights used to be exactly
          inverted — blank was the one filled purple button, the presets a row of
          small grey ones. */}
      <div className="mt-4">
        <h4 className="text-sm font-semibold text-neutral-200">{t('strategy.presetPickTitle')}</h4>
        <p className="mt-1.5 max-w-2xl text-xs leading-relaxed text-neutral-400">{t('strategy.presetPickHint')}</p>
        {loading ? (
          <p className="mt-3 text-xs text-neutral-500">{t('strategy.presetLoading')}</p>
        ) : error ? (
          <p className="mt-3 text-xs text-amber-200">{error}</p>
        ) : options.length === 0 ? (
          <p className="mt-3 text-xs text-neutral-500">{t('strategy.presetNone')}</p>
        ) : (
          <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {options.map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => onStart(o.key)}
                className="group flex flex-col gap-1.5 rounded-inner border border-white/10 bg-white/[0.03] p-3.5 text-left transition hover:border-prism-400/50 hover:bg-prism-600/10"
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-neutral-100">{o.label}</span>
                  <span className="shrink-0 text-[11px] text-neutral-500 transition group-hover:text-prism-200">
                    {t('strategy.presetUse')} →
                  </span>
                </span>
                <span className="text-xs leading-relaxed text-neutral-400">{o.desc}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-neutral-200">{t('strategy.presetBlankTitle')}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">{t('strategy.presetBlankHint')}</p>
        </div>
        <button
          type="button"
          onClick={() => onStart(null)}
          className="rounded-pill border border-white/10 bg-white/5 px-4 py-2 text-xs text-neutral-300 transition hover:border-prism-400/50 hover:text-prism-200"
        >
          {t('strategy.presetStartBlank')}
        </button>
      </div>

      <button
        type="button"
        onClick={onCancel}
        className="mt-4 text-xs text-neutral-500 underline decoration-white/20 underline-offset-4 transition hover:text-neutral-300"
      >
        {t('common.cancel')}
      </button>
    </section>
  )
}
