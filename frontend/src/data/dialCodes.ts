// 国际区号表。
//
// 顺序不是字母序，是「命中概率序」：平台的合作券商在马来西亚，用户以马来西亚、
// 新加坡、中国、港澳台为主，这些放最前面，其余按地区聚拢。下拉里滚动找号码是
// 注册流程里最容易让人烦躁的一步，把 90% 的用户要选的那几项放在一眼能看到的地方，
// 比排得整齐重要。
//
// 名称一律用直接的地区名（香港、台湾、澳门），不加前缀。选区号是个功能性动作，
// 用户扫的是「哪个是我」，名字越短越快认出来。
//
// 不追求收录全球每一个国家：漏掉的用户会去联系客服，而一个几百项的下拉会让所有人
// 都变慢。真有需要再往下加。
//
// International dial codes, ordered by likelihood rather than alphabetically:
// the partner broker is Malaysian and users skew MY/SG/CN/HK/TW, so those come
// first. Scrolling a long list is the most irritating step in a signup flow;
// putting the 90% case where it's immediately visible beats tidy ordering.
export interface DialCode {
  /** ISO 3166-1 alpha-2，仅用作 React key 与国旗 emoji 推导 / used for keys and the flag emoji */
  iso: string
  /** 国际区号，不含 + / dial code without the leading + */
  code: string
  /** 中文名 / Chinese name */
  zh: string
  /** 英文名 / English name */
  en: string
}

export const DIAL_CODES: DialCode[] = [
  { iso: 'MY', code: '60', zh: '马来西亚', en: 'Malaysia' },
  { iso: 'SG', code: '65', zh: '新加坡', en: 'Singapore' },
  { iso: 'CN', code: '86', zh: '中国', en: 'China' },
  { iso: 'HK', code: '852', zh: '香港', en: 'Hong Kong' },
  { iso: 'TW', code: '886', zh: '台湾', en: 'Taiwan' },
  { iso: 'MO', code: '853', zh: '澳门', en: 'Macau' },
  { iso: 'ID', code: '62', zh: '印度尼西亚', en: 'Indonesia' },
  { iso: 'TH', code: '66', zh: '泰国', en: 'Thailand' },
  { iso: 'VN', code: '84', zh: '越南', en: 'Vietnam' },
  { iso: 'PH', code: '63', zh: '菲律宾', en: 'Philippines' },
  { iso: 'BN', code: '673', zh: '文莱', en: 'Brunei' },
  { iso: 'KH', code: '855', zh: '柬埔寨', en: 'Cambodia' },
  { iso: 'LA', code: '856', zh: '老挝', en: 'Laos' },
  { iso: 'MM', code: '95', zh: '缅甸', en: 'Myanmar' },
  { iso: 'JP', code: '81', zh: '日本', en: 'Japan' },
  { iso: 'KR', code: '82', zh: '韩国', en: 'South Korea' },
  { iso: 'IN', code: '91', zh: '印度', en: 'India' },
  { iso: 'BD', code: '880', zh: '孟加拉国', en: 'Bangladesh' },
  { iso: 'PK', code: '92', zh: '巴基斯坦', en: 'Pakistan' },
  { iso: 'LK', code: '94', zh: '斯里兰卡', en: 'Sri Lanka' },
  { iso: 'NP', code: '977', zh: '尼泊尔', en: 'Nepal' },
  { iso: 'AU', code: '61', zh: '澳大利亚', en: 'Australia' },
  { iso: 'NZ', code: '64', zh: '新西兰', en: 'New Zealand' },
  { iso: 'US', code: '1', zh: '美国', en: 'United States' },
  { iso: 'CA', code: '1', zh: '加拿大', en: 'Canada' },
  { iso: 'GB', code: '44', zh: '英国', en: 'United Kingdom' },
  { iso: 'IE', code: '353', zh: '爱尔兰', en: 'Ireland' },
  { iso: 'DE', code: '49', zh: '德国', en: 'Germany' },
  { iso: 'FR', code: '33', zh: '法国', en: 'France' },
  { iso: 'NL', code: '31', zh: '荷兰', en: 'Netherlands' },
  { iso: 'BE', code: '32', zh: '比利时', en: 'Belgium' },
  { iso: 'CH', code: '41', zh: '瑞士', en: 'Switzerland' },
  { iso: 'AT', code: '43', zh: '奥地利', en: 'Austria' },
  { iso: 'IT', code: '39', zh: '意大利', en: 'Italy' },
  { iso: 'ES', code: '34', zh: '西班牙', en: 'Spain' },
  { iso: 'PT', code: '351', zh: '葡萄牙', en: 'Portugal' },
  { iso: 'SE', code: '46', zh: '瑞典', en: 'Sweden' },
  { iso: 'NO', code: '47', zh: '挪威', en: 'Norway' },
  { iso: 'DK', code: '45', zh: '丹麦', en: 'Denmark' },
  { iso: 'FI', code: '358', zh: '芬兰', en: 'Finland' },
  { iso: 'PL', code: '48', zh: '波兰', en: 'Poland' },
  { iso: 'RU', code: '7', zh: '俄罗斯', en: 'Russia' },
  { iso: 'TR', code: '90', zh: '土耳其', en: 'Turkey' },
  { iso: 'AE', code: '971', zh: '阿联酋', en: 'United Arab Emirates' },
  { iso: 'SA', code: '966', zh: '沙特阿拉伯', en: 'Saudi Arabia' },
  { iso: 'QA', code: '974', zh: '卡塔尔', en: 'Qatar' },
  { iso: 'IL', code: '972', zh: '以色列', en: 'Israel' },
  { iso: 'EG', code: '20', zh: '埃及', en: 'Egypt' },
  { iso: 'ZA', code: '27', zh: '南非', en: 'South Africa' },
  { iso: 'NG', code: '234', zh: '尼日利亚', en: 'Nigeria' },
  { iso: 'KE', code: '254', zh: '肯尼亚', en: 'Kenya' },
  { iso: 'BR', code: '55', zh: '巴西', en: 'Brazil' },
  { iso: 'MX', code: '52', zh: '墨西哥', en: 'Mexico' },
  { iso: 'AR', code: '54', zh: '阿根廷', en: 'Argentina' },
  { iso: 'CL', code: '56', zh: '智利', en: 'Chile' },
  { iso: 'CO', code: '57', zh: '哥伦比亚', en: 'Colombia' },
]

/** 默认区号：合作券商在马来西亚 / default to Malaysia, where the partner broker is */
export const DEFAULT_DIAL_ISO = 'MY'

/** ISO 两字母码转国旗 emoji（区域指示符号）/ ISO alpha-2 to flag emoji */
export function flagOf(iso: string): string {
  return String.fromCodePoint(
    ...iso.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  )
}
