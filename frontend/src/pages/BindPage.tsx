// 连接 MT5 页：合作券商 MT5 直连（无需本地 Bridge）。需要桥接程序的部分见 /bind/bridge。
//
// 页面顺序刻意是「开户福利 → 直连表单 → 已绑定账号 → （折叠）桥接程序」：直连是绝大多数
// 用户唯一需要走的路，桥接是给非合作券商准备的兜底，从并列的入口卡降级成
// 默认收起的 <details>，免得新用户以为自己非装个程序不可。
//
// 2026-09-08 视觉重做（样式见 styles/bind.css）：直连面板分成券商身份 + 表单两栏，
// 标签放到输入框上方；已绑定账号从表格改成账本行（登录号 20px 等宽为锚点）；桥接
// 折叠块换 32px 圆形箭头。数据流、校验、错误处理一行没变。
//
// Connect MT5 page: partner-broker MT5 direct connect (no local Bridge needed).
// Everything requiring the Bridge app lives on /bind/bridge.
//
// The order — bonus offer, then the direct-connect form, then the bound accounts,
// then a collapsed bridge section — is deliberate: direct connect is the only path
// most users need, and the bridge is the fallback for non-partner brokers. It
// drops from a co-equal entry card to a closed-by-default <details> so new users
// don't conclude they must install something.
//
// Relaid 2026-09-08 (styles in styles/bind.css): the connect panel splits into
// broker identity + form with labels above inputs; bound accounts move from a
// table to ledger rows anchored by a 20px tabular login; the bridge disclosure
// gets a 32px round chevron. Data flow, validation and error handling unchanged.
import { useEffect, useState, type FormEvent } from 'react'
import PageHead from '../components/PageHead'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { bridgeVersionApi, gatewayApi } from '../api/client'
import { BRIDGE_DOWNLOAD_URL, BRIDGE_FILENAME } from '../api/bridgeDownload'
import { useLive } from '../store/live'
import { localizeApiError } from '../api/utils'
import PartnerBrokerCard, { usePartnerBroker } from '../components/PartnerBrokerCard'

// 券商字母标：英文名取每个词的首字母（最多两个），中文名取前两个字。
// Broker monogram: initials of up to two words for Latin names, first two
// characters otherwise.
function brokerInitials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return 'MT'
  if (/^[A-Za-z]/.test(trimmed)) {
    return trimmed.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || 'MT'
  }
  return trimmed.slice(0, 2)
}

// 金额两位小数带千分位，与订单页的账本条同一种写法。
// Money with two decimals and thousands separators, as on the orders ledger.
const money2 = (n: number | null | undefined): string =>
  n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export default function BindPage() {
  const { t, i18n } = useTranslation()
  const { accounts, refreshAll } = useLive()
  const { name: brokerName } = usePartnerBroker()

  // 桥接程序版本徽标：后端抓 GitHub releases/latest 的 tag（10 分钟缓存），拿不到
  // 就不显示，宁缺毋错——见 DownloadPage 里同一段说明。
  // Bridge version badge from the backend (GitHub releases/latest tag, cached);
  // omitted when unavailable — no information beats wrong information.
  const [bridgeVersion, setBridgeVersion] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    bridgeVersionApi.status().then((r) => { if (alive && r.latest) setBridgeVersion(r.latest) }).catch(() => {})
    return () => { alive = false }
  }, [])

  // ---------- Gateway 绑定状态（Make Capital 用户无需本地 Bridge）----------
  const [gwLogin, setGwLogin] = useState('')
  const [gwPassword, setGwPassword] = useState('')
  const [gwVerifying, setGwVerifying] = useState(false)
  const [gwResult, setGwResult] = useState<{ valid: boolean; name: string; balance: number; retcode: string } | null>(null)
  const [gwError, setGwError] = useState('')

  const handleGatewayVerify = async () => {
    const loginNum = parseInt(gwLogin, 10)
    if (!loginNum || loginNum <= 0) {
      setGwError(t('bind.gw.errLogin'))
      return
    }
    if (!gwPassword) {
      setGwError(t('bind.gw.errPassword'))
      return
    }
    setGwVerifying(true)
    setGwError('')
    setGwResult(null)
    try {
      const res = await gatewayApi.verify(loginNum, gwPassword)
      setGwResult({ valid: res.valid, name: res.name, balance: res.balance, retcode: res.retcode })
      if (res.valid) {
        setGwPassword('') // 验证通过后清空密码
        refreshAll()
      }
    } catch (e) {
      setGwError(e instanceof Error ? localizeApiError(e.message) : t('bind.gw.errFailed'))
    } finally {
      setGwVerifying(false)
    }
  }

  // 用真正的 <form>：回车提交、浏览器密码管理器都能识别，不用再在输入框上挂 onKeyDown。
  // A real <form>: Enter submits and password managers recognise it, so the
  // password input no longer needs its own onKeyDown.
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!gwVerifying) void handleGatewayVerify()
  }

  // 解绑失败必须说话。此前这里是 `catch {}`：后端拒绝或网络断了，按钮点下去
  // 界面纹丝不动，用户只能反复点，以为是自己没点到。复用上面那条错误横幅，
  // 不额外造一套提示。
  // A failed disconnect has to say so. This used to be `catch {}`: if the
  // backend refused or the network dropped, the button did visibly nothing and
  // the user just kept clicking, assuming they'd missed it. Reuses the error
  // banner above rather than introducing a second notification mechanism.
  const handleGatewayRemove = async (login: string) => {
    setGwError('')
    try {
      await gatewayApi.remove(login)
      refreshAll()
    } catch (e) {
      setGwError(e instanceof Error ? localizeApiError(e.message) : t('bind.gw.unbindFailed'))
    }
  }

  // Gateway 绑定的账号（过滤 source === "gateway"）
  const gatewayAccounts = accounts.filter((a) => a.source === 'gateway')

  // 密码变更后被撤销、等着用户重新验证的账号。撤销的判据在后端（券商记录的
  // 改密时间与绑定时对不上），前端只负责把它说清楚：这件事不会自己恢复，
  // 必须重新输一次主密码，而在那之前自动下单是静默失效的。
  // Accounts revoked after a password change. The judgement is the backend's;
  // this page's job is to say the part that matters — it will not fix itself,
  // and until it is fixed automated orders silently fail.
  const revokedAccounts = gatewayAccounts.filter((a) => a.needsReverify)
  // 顿号只在中文里对；英文列表用逗号。写死一个会在另一种语言下明显别扭。
  // The ideographic comma is only right in Chinese; English lists take ", ".
  const revokedLogins = revokedAccounts
    .map((a) => a.login)
    .join(i18n.language?.startsWith('zh') ? '、' : ', ')

  const hasMessages = !!gwError || revokedAccounts.length > 0 || !!gwResult

  return (
    <div>
      <PageHead as="h1" title={t('bind.title')} subtitle={t('bind.gw.pageSubtitle', { name: brokerName })} />

      <div className="bind-stack">
        {/* 开户福利：只在还没有直连账号时出现。已经连上的人不需要再被劝一次开户，
            那时这张卡只是占地方。
            Bonus offer, shown only while no direct-connect account exists. Someone
            already connected doesn't need to be pitched an account again — the
            card would just take up space. */}
        {gatewayAccounts.length === 0 && (
          <PartnerBrokerCard variant="compact" />
        )}

        {/* 合作券商 MT5 直连：左边券商身份，右边表单 / partner-broker direct connect */}
        <section className="card glass bind-connect">
          <div className="bind-broker">
            <div className="bind-broker-id">
              <span className="bind-mark num" aria-hidden="true">{brokerInitials(brokerName)}</span>
              <div className="min-w-0">
                <h3 className="font-display">{t('bind.gw.title', { name: brokerName })}</h3>
                <p>{t('bind.gw.hint')}</p>
              </div>
            </div>
            <p className="bind-note">{t('bind.brokerOnly', { name: brokerName })}</p>
          </div>

          <form className="bind-form" onSubmit={onSubmit} noValidate>
            <div className="bind-field">
              <label htmlFor="gw-login">{t('bind.gw.loginPlaceholder')}</label>
              <input
                id="gw-login"
                className="input num"
                type="text"
                inputMode="numeric"
                autoComplete="username"
                value={gwLogin}
                onChange={(e) => { setGwLogin(e.target.value); setGwError(''); setGwResult(null) }}
              />
            </div>
            <div className="bind-field">
              <label htmlFor="gw-password">{t('bind.gw.passwordPlaceholder')}</label>
              <input
                id="gw-password"
                className="input num"
                type="password"
                autoComplete="current-password"
                value={gwPassword}
                onChange={(e) => { setGwPassword(e.target.value); setGwError(''); setGwResult(null) }}
              />
            </div>
            <button
              type="submit"
              disabled={gwVerifying || !gwLogin || !gwPassword}
              className="btn btn-primary bind-submit"
            >
              {gwVerifying ? t('bind.gw.verifying') : t('bind.gw.verify')}
            </button>

            {hasMessages && (
              <div className="bind-msgs" aria-live="polite">
                {gwError && <p className="bind-msg err">{gwError}</p>}
                {revokedAccounts.length > 0 && (
                  <p className="bind-msg warn">{t('bind.gw.revokedBanner', { logins: revokedLogins })}</p>
                )}
                {gwResult && (
                  <p className={`bind-msg ${gwResult.valid ? 'ok' : 'warn'}`}>
                    {gwResult.valid
                      ? t('bind.gw.verified', { name: gwResult.name, balance: gwResult.balance.toFixed(2) })
                      : t('bind.gw.verifyFailed', { code: gwResult.retcode })}
                  </p>
                )}
              </div>
            )}
          </form>
        </section>

        {/* 已绑定的直连账号：与桥接页的账户表展示同一组信息（账户名 / 券商 / 余额 /
            净值 / 状态），加上杠杆。gateway 不落库 company，券商列回落到合作券商名。
            Bound direct-connect accounts: same info set as the bridge page's account
            table (name / company / balance / equity / status) plus leverage. Gateway
            rows don't store company, so that falls back to the partner broker name. */}
        {gatewayAccounts.length > 0 && (
          <section className="card glass bind-accts" aria-label={t('bind.gw.boundTitle')}>
            <div className="bind-accts-head">
              <h3>{t('bind.gw.boundTitle')}</h3>
              <b className="num">{gatewayAccounts.length}</b>
            </div>
            {gatewayAccounts.map((a, i) => (
              <div key={a.login} className="bind-acct" style={{ animationDelay: `${Math.min(i, 6) * 50}ms` }}>
                <div className="bind-acct-id">
                  <div className="login">
                    <b className="num">{a.login}</b>
                    <span className="tag bg-prism-600/20 text-prism-300 text-[10px]">{t('bind.gw.tag')}</span>
                  </div>
                  <div className="who">
                    <span>{a.accountName || '—'}</span>
                    {' '}
                    {a.company || brokerName}
                  </div>
                </div>
                <div>
                  <span className="k">{t('bind.balance')}</span>
                  <span className="v num">{money2(a.balance)}{a.accountCurrency && a.balance != null && <small>{a.accountCurrency}</small>}</span>
                </div>
                <div>
                  <span className="k">{t('bind.equity')}</span>
                  <span className="v num">{money2(a.equity)}{a.accountCurrency && a.equity != null && <small>{a.accountCurrency}</small>}</span>
                </div>
                <div>
                  <span className="k">{t('bind.leverage')}</span>
                  <span className="v num">{a.leverage ? `1:${a.leverage}` : '—'}</span>
                </div>
                {/* 需重新验证要盖过在线/离线：被撤销的账号在后端本来就判离线，只显示一个
                    灰色「离线」会让用户以为等一会儿就好，而它永远不会自己好。
                    "Needs re-verify" overrides online/offline: a revoked account already
                    reads as offline, and a grey badge alone would read as "wait it out"
                    for something that never recovers on its own. */}
                {a.needsReverify ? (
                  <span className="bind-state warn"><i />{t('bind.gw.needsReverify')}</span>
                ) : (
                  <span className={`bind-state ${a.online ? 'on' : 'off'}`}><i />{a.online ? t('common.online') : t('common.offline')}</span>
                )}
                <button type="button" onClick={() => handleGatewayRemove(a.login)} className="bind-unbind">
                  {t('bind.gw.unbind')}
                </button>
              </div>
            ))}
          </section>
        )}

        {/* 桥接程序入口（默认折叠）。用原生 <details> 而不是 useState：不需要
            额外状态，键盘可达性和「点标题展开」的语义浏览器已经给全了。
            Bridge entry, collapsed by default. Native <details> rather than
            useState: no extra state needed, and the browser already provides the
            keyboard affordance and click-the-heading-to-expand semantics. */}
        <details className="card glass bind-bridge">
          <summary>
            <span className="min-w-0">
              <span className="t">{t('bind.bridgeEntry.collapsedTitle')}</span>
              <span className="h">{t('bind.bridgeEntry.collapsedHint')}</span>
            </span>
            <span className="chev" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </span>
          </summary>

          <div className="bind-bridge-body">
            <h3 className="font-display">{t('bind.bridgeEntry.title')}</h3>
            <p>{t('bind.bridgeEntry.desc', { name: brokerName })}</p>
            <div className="bind-feats" role="list">
              <span role="listitem">{t('bind.bridgeEntry.f1')}</span>
              <span role="listitem">{t('bind.bridgeEntry.f2')}</span>
              <span role="listitem">{t('bind.bridgeEntry.f3')}</span>
              <span role="listitem">{t('bind.bridgeEntry.f4')}</span>
            </div>
            {/* 下载入口就在这里（用户菜单里那项已撤）：直连合作券商的用户根本用不到
                桥接，把它藏进这个折叠区，只有真需要的人展开才看到。
                The download entry lives here (the user-menu item is gone): partner-
                broker users never need the bridge, so only those who expand see it. */}
            <div className="bind-bridge-cta">
              <a href={BRIDGE_DOWNLOAD_URL} download={BRIDGE_FILENAME} className="btn btn-primary">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                {t('bind.bridgeEntry.downloadCta')}
                {bridgeVersion && <span className="num ver">v{bridgeVersion}</span>}
              </a>
              <Link to="/bind/bridge" className="btn btn-ghost">
                {t('bind.bridgeEntry.openCta')}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
              </Link>
              <Link to="/download" className="guide">
                {t('bind.bridgeEntry.guideLink')}
              </Link>
            </div>
            <p className="bind-platform">{t('download.platform')}</p>
          </div>
        </details>
      </div>
    </div>
  )
}
