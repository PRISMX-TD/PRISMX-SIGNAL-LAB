// 新建自动邮件规则时，按情景预填的默认值：延迟、邮件类型、中英两份正文。管理员照着改，不用从空白写起。
// 正文是邮件内容而不是界面文案：和群发一样中英各一份进同一封信，所以不走 i18n，两种语言都写死在这里。
// 变量（{昵称} {到期日期} …）在发送那一刻由后端按收件人替换，见 services/email_automation.fill。
// Defaults prefilled for a new automated-email rule, per trigger: delay, mail kind, and zh + en bodies
// for the admin to edit instead of a blank page. These are email content, not UI copy (both languages
// go into one message, like broadcasts), so they live here rather than in i18n. Variables are filled
// per recipient by the backend at send time (services/email_automation.fill).
import type { EmailAutomationTrigger, EmailKind } from '../../api/types'

export interface AutomationPreset {
  delayMinutes: number
  maxTimes: number | null
  kind: EmailKind
  name: string
  subjectZh: string
  bodyZh: string
  subjectEn: string
  bodyEn: string
}

const DAY = 24 * 60

export const TRIGGER_ORDER: EmailAutomationTrigger[] = [
  'signup',
  'unverified',
  'no_mt5',
  'mt5_first_bind',
  'trial_started',
  'trial_expiring',
  'trial_expired',
  'first_payment',
  'plan_expiring',
  'plan_expired',
  'inactive',
]

// 每种情景的延迟下限（分钟），与后端 TRIGGERS[*].min_delay 一致 / mirrors the backend's min_delay
export const MIN_DELAY: Record<EmailAutomationTrigger, number> = {
  signup: 0,
  unverified: 60,
  no_mt5: 60,
  mt5_first_bind: 0,
  trial_started: 0,
  trial_expiring: 60,
  trial_expired: 0,
  plan_expiring: 60,
  plan_expired: 0,
  first_payment: 0,
  inactive: DAY,
}

export const PRESETS: Record<EmailAutomationTrigger, AutomationPreset> = {
  signup: {
    delayMinutes: DAY,
    maxTimes: null,
    kind: 'marketing',
    name: '欢迎信',
    subjectZh: '欢迎加入 PRISMX Signal Lab，{昵称}',
    bodyZh:
      '{昵称}，你好！\n\n感谢注册 PRISMX Signal Lab。三步就能开始：\n\n1. 绑定你的 MT5 账号\n2. 看看今天的信号与策略\n3. 开通 PRO 试用，解锁全部功能\n\n现在就去看看：{网站链接}',
    subjectEn: 'Welcome to PRISMX Signal Lab, {nickname}',
    bodyEn:
      'Hi {nickname},\n\nThanks for signing up. Getting started takes three steps:\n\n1. Link your MT5 account\n2. Browse today\'s signals and strategies\n3. Start a PRO trial to unlock everything\n\nTake a look: {site_url}',
  },
  unverified: {
    delayMinutes: DAY,
    maxTimes: null,
    kind: 'marketing',
    name: '提醒验证邮箱',
    subjectZh: '还差一步：验证你的邮箱',
    bodyZh:
      '{昵称}，你好！\n\n你的邮箱还没有验证。验证之后才能绑定 MT5 账号、领取 PRO 试用。\n\n登录后点页面顶部提示条里的「重新发送」，再收一封验证邮件即可：{网站链接}',
    subjectEn: 'One more step: verify your email',
    bodyEn:
      'Hi {nickname},\n\nYour email isn\'t verified yet. You\'ll need that before linking an MT5 account or starting a PRO trial.\n\nSign in and tap "Resend" in the banner at the top to get a new verification email: {site_url}',
  },
  no_mt5: {
    delayMinutes: 3 * DAY,
    maxTimes: null,
    kind: 'marketing',
    name: '引导绑定 MT5',
    subjectZh: '绑定 MT5，让信号直接跑在你的账户上',
    bodyZh:
      '{昵称}，你好！\n\n你注册已经几天了，但还没有绑定 MT5 账号。绑定之后，信号与策略可以直接在你的账户上执行，持仓和盈亏也会自动同步。\n\n绑定只需一分钟：{网站链接}',
    subjectEn: 'Link MT5 and trade signals on your own account',
    bodyEn:
      'Hi {nickname},\n\nYou signed up a few days ago but haven\'t linked an MT5 account yet. Once linked, signals and strategies run straight on your account and your positions and P&L sync automatically.\n\nIt takes a minute: {site_url}',
  },
  mt5_first_bind: {
    delayMinutes: 30,
    maxTimes: null,
    kind: 'marketing',
    name: '绑定成功',
    subjectZh: 'MT5 账号 {MT5账号} 已绑定成功',
    bodyZh:
      '{昵称}，你好！\n\n你的 MT5 账号 {MT5账号} 已经绑定成功。接下来可以：\n\n- 在信号页一键跟随信号\n- 给持仓设置自动止盈止损\n\n有问题随时在 App 里提交工单：{网站链接}',
    subjectEn: 'MT5 account {mt5_login} is linked',
    bodyEn:
      'Hi {nickname},\n\nYour MT5 account {mt5_login} is now linked. Next you can:\n\n- Follow signals in one tap\n- Set automatic take-profit and stop-loss on your positions\n\nQuestions? Open a ticket in the app: {site_url}',
  },
  trial_started: {
    delayMinutes: 0,
    maxTimes: null,
    kind: 'marketing',
    name: '试用开通',
    subjectZh: '你的 PRO 试用已开通',
    bodyZh:
      '{昵称}，你好！\n\n你的 PRO 试用已经开通，到 {到期日期} 为止。试用期间所有 PRO 功能都可以用，建议先试试策略信号和自动仓位管理。\n\n开始体验：{网站链接}',
    subjectEn: 'Your PRO trial is on',
    bodyEn:
      'Hi {nickname},\n\nYour PRO trial is active until {expiry_date}. Every PRO feature is unlocked — strategy signals and automatic position management are a good place to start.\n\nDive in: {site_url}',
  },
  trial_expiring: {
    delayMinutes: 2 * DAY,
    maxTimes: null,
    kind: 'notice',
    name: '试用即将到期',
    subjectZh: '你的 PRO 试用还剩 {剩余天数} 天',
    bodyZh:
      '{昵称}，你好！\n\n你的 PRO 试用将在 {到期日期} 到期。到期后会自动回到免费版，PRO 功能将暂停。\n\n想继续使用，可以随时开通 PRO：{网站链接}',
    subjectEn: 'Your PRO trial ends in {days_left} days',
    bodyEn:
      'Hi {nickname},\n\nYour PRO trial ends on {expiry_date}. After that your account returns to the free plan and PRO features pause.\n\nYou can upgrade any time: {site_url}',
  },
  trial_expired: {
    delayMinutes: DAY,
    maxTimes: null,
    kind: 'marketing',
    name: '试用已到期',
    subjectZh: '你的 PRO 试用已结束',
    bodyZh:
      '{昵称}，你好！\n\n你的 PRO 试用已经结束，账号已回到免费版。试用期间的设置都还在，开通 PRO 后立即恢复。\n\n开通 PRO：{网站链接}',
    subjectEn: 'Your PRO trial has ended',
    bodyEn:
      'Hi {nickname},\n\nYour PRO trial has ended and your account is back on the free plan. Your settings are kept and come back the moment you upgrade.\n\nUpgrade to PRO: {site_url}',
  },
  first_payment: {
    delayMinutes: 0,
    maxTimes: null,
    kind: 'marketing',
    name: '感谢付费',
    subjectZh: '感谢开通 PRO，{昵称}',
    bodyZh:
      '{昵称}，你好！\n\n感谢你开通 PRO，会员有效期到 {到期日期}。所有 PRO 功能已经解锁。\n\n使用中有任何问题，随时在 App 里提交工单：{网站链接}',
    subjectEn: 'Thanks for going PRO, {nickname}',
    bodyEn:
      'Hi {nickname},\n\nThanks for upgrading — your PRO membership runs until {expiry_date} and every PRO feature is unlocked.\n\nAny questions, open a ticket in the app: {site_url}',
  },
  plan_expiring: {
    delayMinutes: 3 * DAY,
    maxTimes: null,
    kind: 'notice',
    name: '会员即将到期',
    subjectZh: '你的 PRO 会员还剩 {剩余天数} 天',
    bodyZh:
      '{昵称}，你好！\n\n你的 PRO 会员将在 {到期日期} 到期。到期后会自动回到免费版，PRO 功能将暂停。\n\n续费：{网站链接}',
    subjectEn: 'Your PRO membership ends in {days_left} days',
    bodyEn:
      'Hi {nickname},\n\nYour PRO membership ends on {expiry_date}. After that your account returns to the free plan and PRO features pause.\n\nRenew: {site_url}',
  },
  plan_expired: {
    delayMinutes: DAY,
    maxTimes: null,
    kind: 'marketing',
    name: '会员已到期',
    subjectZh: '你的 PRO 会员已到期',
    bodyZh:
      '{昵称}，你好！\n\n你的 PRO 会员已经到期，账号已回到免费版。你的设置都还在，续费后立即恢复。\n\n续费：{网站链接}',
    subjectEn: 'Your PRO membership has ended',
    bodyEn:
      'Hi {nickname},\n\nYour PRO membership has ended and your account is back on the free plan. Your settings are kept and come back as soon as you renew.\n\nRenew: {site_url}',
  },
  inactive: {
    delayMinutes: 14 * DAY,
    maxTimes: 2,
    kind: 'marketing',
    name: '沉睡召回',
    subjectZh: '{昵称}，好久不见',
    bodyZh:
      '{昵称}，你好！\n\n有一阵子没见到你了。这段时间平台上新增了不少信号和策略，回来看看吧：{网站链接}',
    subjectEn: 'We miss you, {nickname}',
    bodyEn:
      'Hi {nickname},\n\nIt\'s been a while. Plenty of new signals and strategies have landed since your last visit — come take a look: {site_url}',
  },
}
