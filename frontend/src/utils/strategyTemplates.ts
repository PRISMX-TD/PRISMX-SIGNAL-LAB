// 策略预设键 → i18n 标签键。原本是 StrategiesPage 的私有常量，管理看板也要显示
// 模板名，搬到这里两处共用。
// Preset key → i18n label key, shared by StrategiesPage and the admin dashboard.
import type { StrategyTemplateKey } from '../api/types'

export const TEMPLATE_LABEL_KEYS: Record<StrategyTemplateKey, string> = {
  ma_trend: 'strategy.templateMaTrend',
  macd_cross: 'strategy.templateMacdCross',
  rsi_reversal: 'strategy.templateRsiReversal',
  bollinger_breakout: 'strategy.templateBollingerBreakout',
  donchian_breakout: 'strategy.templateDonchianBreakout',
  macd_rsi_combo: 'strategy.templateMacdRsiCombo',
}
