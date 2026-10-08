// 渠道输入：自由文本（≤32），下面一排建议值（FB广告、Google广告…）点一下填入。
// 不用 <datalist>：手机浏览器对它的支持参差不齐，建议值做成按钮在哪都一样。
// Channel input: free text (≤32) plus a row of suggestion chips. Not a <datalist> —
// mobile support is patchy; chips behave the same everywhere.
import { useTranslation } from 'react-i18next'
import { CHANNEL_MAX, CHANNEL_SUGGESTIONS } from './inviteLinkLogic'

export default function ChannelField({
  value,
  onChange,
  disabled = false,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div>
      <input
        className="input w-full"
        value={value}
        maxLength={CHANNEL_MAX}
        placeholder={t('admin.invite.channelPlaceholder')}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="mt-2 flex flex-wrap gap-1.5">
        {CHANNEL_SUGGESTIONS.map((c) => (
          <button
            key={c}
            type="button"
            disabled={disabled}
            onClick={() => onChange(c)}
            className={`rounded-full px-2 py-0.5 text-[11px] transition disabled:opacity-40 ${
              value.trim() === c ? 'bg-prism-500/20 text-prism-200' : 'bg-white/5 text-neutral-400 hover:text-neutral-100'
            }`}
          >
            {c}
          </button>
        ))}
      </div>
    </div>
  )
}
