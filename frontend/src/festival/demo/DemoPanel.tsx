// 节日预览面板（仅演示构建）/ festival preview panel, demo builds only
//
// 左下角的一颗小药丸，点开可以：切节日、模拟日期、切「减少动效」、模拟用户在
// 设置里关掉装饰、重放全部入场动画、在官网与 App 演示之间来回跳。
// A small pill in the bottom-left. Opened, it switches festival, simulates a
// date, toggles reduced motion, simulates the user's off switch, replays every
// entrance, and hops between the landing page and the app demo.
import { useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import Switch from '../../components/Switch'
import { useFestival, type DemoMode } from '../FestivalProvider'
import { detect, nextWindow, ymd, type FestivalKey } from '../calendar'
import { icon } from '../art'
import SvgArt from '../SvgArt'
import { enterMock, leaveMock, mockActive, signalsMode, DEMO_SIGNAL_EVENT, MOCK_SIGNALS_KEY } from './mockBackend'
import '../festival.css'

const NAMES: Record<FestivalKey, string> = {
  spring: '春节',
  midautumn: '中秋',
  halloween: '万圣节',
  christmas: '圣诞',
  newyear: '新年',
}
const MODES: [DemoMode, string][] = [
  ['auto', '自动'],
  ['none', '默认'],
  ['spring', '春节'],
  ['midautumn', '中秋'],
  ['halloween', '万圣节'],
  ['christmas', '圣诞'],
  ['newyear', '新年'],
]

const md = (s: string) => s.slice(5).replace('-', '/')

export default function DemoPanel() {
  const f = useFestival()
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const inApp = pathname.indexOf('/app') === 0 || pathname === '/account'
  const mock = mockActive()
  const chipIcon = useMemo(() => icon(f.festival || 'none'), [f.festival])

  const status = (() => {
    if (!f.enabled) return <>用户已在设置里关闭，全站显示<b>默认样式</b></>
    if (f.demo.mode === 'none') return <>手动预览：<b>默认样式</b></>
    if (f.demo.mode !== 'auto') return <>手动预览：<b>{NAMES[f.demo.mode]}</b></>
    const hit = detect(f.today)
    if (hit) return <>{ymd(f.today)} 命中 <b>{NAMES[hit.key]}</b>（{md(hit.start)} 至 {md(hit.end)}）</>
    const nx = nextWindow(f.today)
    return <>{ymd(f.today)} 不在节日窗口{nx ? '，下一个是' + NAMES[nx.key] + '（' + md(nx.start) + ' 开始）' : ''}</>
  })()

  return (
    <div className={'fa-demo' + (inApp ? ' in-app' : '')}>
      {open && (
        <div className="fa-demo-panel" role="dialog" aria-label="节日预览">
          <div className="fa-demo-h">
            <b>节日预览</b>
            <span>演示用，正式版没有这个面板</span>
          </div>

          <div className="fa-demo-grid" role="group" aria-label="节日">
            {MODES.map(([m, label]) => (
              <button key={m} type="button" aria-pressed={f.demo.mode === m} onClick={() => f.setDemo({ mode: m })}>
                {label}
              </button>
            ))}
          </div>

          <label className="fa-demo-row">
            <span>模拟今天</span>
            <input
              type="date"
              value={ymd(f.today)}
              disabled={f.demo.mode !== 'auto'}
              onChange={(e) => e.target.value && f.setDemo({ date: e.target.value })}
            />
          </label>
          <div className="fa-demo-status">{status}</div>

          <div className="fa-demo-row">
            <span>减少动效</span>
            <Switch checked={f.reducedMotion} onChange={(v) => f.setDemo({ reduce: v })} aria-label="减少动效" />
          </div>
          <div className="fa-demo-row">
            <span>用户在设置里关闭装饰</span>
            <Switch checked={!f.enabled} onChange={(v) => f.setEnabled(!v)} aria-label="用户关闭装饰" />
          </div>
          {mock && (
            <div className="fa-demo-row">
              <span>信号面板为空（看空状态）</span>
              <Switch
                checked={signalsMode() === 'empty'}
                onChange={(v) => {
                  localStorage.setItem(MOCK_SIGNALS_KEY, v ? 'empty' : 'live')
                  window.location.reload()
                }}
                aria-label="信号面板为空"
              />
            </div>
          )}

          <div className="fa-demo-actions">
            <button type="button" onClick={f.bumpReplay}>
              重放动画
            </button>
            {mock && inApp && signalsMode() === 'live' && (
              <button type="button" onClick={() => window.dispatchEvent(new Event(DEMO_SIGNAL_EVENT))}>
                模拟新信号到达
              </button>
            )}
            {inApp ? (
              <button type="button" className="is-primary" onClick={() => navigate('/')}>
                回到官网
              </button>
            ) : mock ? (
              <button type="button" className="is-primary" onClick={() => navigate('/app')}>
                进入 App
              </button>
            ) : (
              <button
                type="button"
                className="is-primary"
                onClick={() => {
                  // 假后端要在应用启动前装上，所以这里整页跳转而不是路由跳转。
                  // The stand-in backend must be installed before boot, hence a full navigation.
                  enterMock()
                  window.location.href = '/app'
                }}
              >
                进入 App 演示
              </button>
            )}
            {mock && (
              <button
                type="button"
                style={{ gridColumn: '1 / -1' }}
                onClick={() => {
                  leaveMock()
                  window.location.href = '/'
                }}
              >
                退出 App 演示（清除示例账号）
              </button>
            )}
          </div>
        </div>
      )}
      <button type="button" className="fa-demo-chip" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <SvgArt html={chipIcon} />
        节日预览
        <small>{f.festival ? NAMES[f.festival] : '默认'}</small>
      </button>
    </div>
  )
}
