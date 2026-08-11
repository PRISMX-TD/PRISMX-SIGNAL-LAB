// 手机号输入：区号下拉 + 号码输入框。注册页与「补录手机号」页共用。
//
// 为什么拆成两段而不是一个「请输入完整号码」的输入框：让用户自己敲 +60，会得到
// 各种写法（漏 +、写成 0060、带空格、把国内前导 0 也敲进去）。下拉把区号这一半
// 变成不可能填错，剩下那一半的容错交给后端的 compose_phone。
//
// 两段也是接口的形状（POST 传 phoneCountry + phone 两个字段）：前端不拼 E.164，
// 因为去掉国内号码前导 0 必须知道区号在哪断开，让知道这件事的一方做（见
// backend/app/services/phone.py 里那段说明）。
//
// Dial-code select + number input, shared by the register form and the
// complete-profile page. Split in two so the dial-code half can't be typed
// wrong, and because it mirrors the API shape: the frontend never assembles
// E.164 itself, since stripping a national trunk zero requires knowing where the
// dial code ends (see backend/app/services/phone.py).
import { useTranslation } from 'react-i18next'
import Select from './Select'
import { DIAL_CODES, flagOf } from '../data/dialCodes'

export interface PhoneValue {
  /** 选中的 ISO 码（不是区号本身——+1 同时是美国和加拿大，用 ISO 才能区分选了哪个）
   *  The selected ISO code, not the dial code: +1 is both US and CA. */
  iso: string
  /** 用户输入的国内号码部分 / the national number as typed */
  national: string
}

export function dialCodeOf(iso: string): string {
  return DIAL_CODES.find((d) => d.iso === iso)?.code ?? ''
}

export default function PhoneField({
  value,
  onChange,
  required = true,
  autoFocus = false,
}: {
  value: PhoneValue
  onChange: (v: PhoneValue) => void
  required?: boolean
  autoFocus?: boolean
}) {
  const { t, i18n } = useTranslation()
  const zh = i18n.language?.startsWith('zh')

  const options = DIAL_CODES.map((d) => ({
    value: d.iso,
    label: `${flagOf(d.iso)} ${zh ? d.zh : d.en} +${d.code}`,
  }))

  return (
    <div>
      <label className="label">{t('auth.phone')}</label>
      <div className="flex gap-2">
        <Select
          className="phone-dial-select"
          value={value.iso}
          options={options}
          onChange={(iso) => onChange({ ...value, iso })}
        />
        <input
          type="tel"
          required={required}
          autoFocus={autoFocus}
          className="input flex-1"
          placeholder={t('auth.phonePlaceholder')}
          value={value.national}
          // 只留数字与常见分隔符。不在这里做「必须多少位」的校验——各国号码长度
          // 差异很大，前端定死会误伤真实用户；长度由后端按 E.164 统一判定。
          // Digits and common separators only. No length rule here: national
          // formats vary too much to hard-code without rejecting real users.
          onChange={(e) => onChange({ ...value, national: e.target.value.replace(/[^\d\s\-()]/g, '') })}
          inputMode="numeric"
          autoComplete="tel-national"
        />
      </div>
      <p className="mt-1.5 text-xs text-slate-500">{t('auth.phoneHint')}</p>
    </div>
  )
}
