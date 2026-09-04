// 成就页陈列台的台座部分：三枚佩戴勋章的转盘 + 倒影 + 铭牌，外加两样手机专属的
// 触感——左右滑动转盘（把副戴转到 C 位）、陀螺仪反光（拿着手机倾斜，勋章表面
// 的高光跟着走，像真的把勋章拿在手上）。
// 转盘只改"看哪一枚"，不动服务端；转到非默认那枚时铭牌下给一个「设为默认」。
// The pedestal half of the achievements stage: a turntable of the three equipped
// badges + reflection + nameplate, plus two phone-only tactile layers — swipe to
// rotate (bring a side badge to centre) and gyroscope-driven sheen (tilt the
// phone and the highlight on the badge follows, like holding the medal).
// Rotating only changes which badge faces front, nothing server-side; when a
// non-default badge is in front the nameplate offers "set as default".
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import BadgeIcon from './BadgeIcon'
import MedalTilt from './MedalTilt'
import type { GamificationBadge } from '../../api/types'

type Slot = 'l' | 'c' | 'r'
// 横向位移超过这个值才算一次滑动（否则是点按，交给 MedalTilt 的 onClick 开详情）。
// Horizontal travel beyond this counts as a swipe (otherwise it is a tap, left to
// MedalTilt's onClick to open the detail layer).
const SWIPE_PX = 36
// 勋章的 SVG 一律按桌面 C 位尺寸渲染，副戴与手机用 CSS 缩放——转盘转动时尺寸
// 用 transform 过渡，不重画 SVG。
// Badges always render at the desktop centre size; sides and phones scale via CSS,
// so a rotation transitions with transform instead of re-rendering the SVG.
const RENDER_SIZE = 236

type DOEWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>
}
type GyroState = 'idle' | 'ask' | 'on' | 'off'

// 陀螺仪 → 台座上的两个 CSS 变量（--gx 左右、--gy 前后，各归一化到 -1..1）。
// beta（前后倾）以 40° 为零点：手持看屏幕的常态大约就是这个角度，让"正常拿着"
// 时高光居中，往前后倾才移动。只在 rAF 里写一次，事件再密也不抖。
// Gyroscope → two CSS variables on the pedestal (--gx left/right, --gy front/back,
// each normalised to -1..1). beta is zeroed at 40°, roughly how a phone is held
// when reading, so the highlight sits centred at rest and moves as you tilt.
// Written once per rAF however dense the events are.
function useDeviceTilt(target: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return
    const el = target.current
    if (!el) return
    // 传感器原始值 → 目标值；每帧向目标值靠 18%（指数平滑），手一抖勋章不会跟着抖，
    // 又不至于拖泥带水。只驱动位移与倾斜——曾试过叠反光带/边缘亮弧，真机上不好看，
    // 已去掉，勋章本身的材质渲染够用。
    // Raw sensor → target; each frame moves 18% of the way (exponential smoothing),
    // so a shaky hand doesn't jitter the badge yet it never feels laggy. Drives
    // movement and tilt only — a sheen band / rim glint overlay was tried and looked
    // wrong on real devices, so it was removed; the medal's own material rendering
    // carries the effect.
    let tx = 0
    let ty = 0
    let gx = 0
    let gy = 0
    let raf = 0
    let running = true
    const onOrient = (e: DeviceOrientationEvent) => {
      tx = Math.max(-1, Math.min(1, (e.gamma ?? 0) / 28))
      ty = Math.max(-1, Math.min(1, ((e.beta ?? 0) - 40) / 28))
    }
    const tick = () => {
      if (!running) return
      gx += (tx - gx) * 0.18
      gy += (ty - gy) * 0.18
      el.style.setProperty('--gx', gx.toFixed(3))
      el.style.setProperty('--gy', gy.toFixed(3))
      raf = requestAnimationFrame(tick)
    }
    window.addEventListener('deviceorientation', onOrient)
    raf = requestAnimationFrame(tick)
    return () => {
      running = false
      window.removeEventListener('deviceorientation', onOrient)
      if (raf) cancelAnimationFrame(raf)
      el.style.removeProperty('--gx')
      el.style.removeProperty('--gy')
    }
  }, [target, active])
}

interface Props {
  badges: GamificationBadge[]
  defaultId: string | null
  busy: boolean
  onOpen: (badge: GamificationBadge) => void
  onMakeDefault: (badgeId: string) => void
}

export default function PedestalStage({ badges, defaultId, busy, onOpen, onMakeDefault }: Props) {
  const { t } = useTranslation()
  const n = badges.length
  const [front, setFront] = useState(0)
  const pedRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  const swipedRef = useRef(false)
  const [gyro, setGyro] = useState<GyroState>('idle')

  // 取消佩戴后列表变短，正面索引可能越界——回到 0。
  // The list shrinks after an unequip and the front index may run past it — reset to 0.
  useEffect(() => {
    if (front >= n) setFront(0)
  }, [n, front])

  // 陀螺仪只在粗指针设备（手机/平板）上启用；iOS 13+ 要在用户手势里申请权限，
  // 先渲染一个按钮；安卓直接开。系统减少动效时不开。
  // Gyro only on coarse-pointer devices (phones/tablets); iOS 13+ needs a permission
  // request from a user gesture, so a button is shown first; Android starts at once.
  // Off under reduced motion.
  useEffect(() => {
    if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) {
      setGyro('off')
      return
    }
    const coarse = window.matchMedia('(pointer: coarse)').matches
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!coarse || reduced) {
      setGyro('off')
      return
    }
    const DOE = DeviceOrientationEvent as DOEWithPermission
    setGyro(typeof DOE.requestPermission === 'function' ? 'ask' : 'on')
  }, [])
  useDeviceTilt(pedRef, gyro === 'on')

  async function enableGyro() {
    try {
      const DOE = DeviceOrientationEvent as DOEWithPermission
      const res = await DOE.requestPermission?.()
      setGyro(res === 'granted' ? 'on' : 'off')
    } catch {
      setGyro('off')
    }
  }

  // 每枚勋章相对正面那枚的位置：正面 c，下一枚 r，再下一枚 l（三枚成环）。
  // Each badge's slot relative to the front one: front is c, the next r, the one after l (a ring of three).
  function slotOf(i: number): Slot {
    if (n <= 1) return 'c'
    const d = (((i - front) % n) + n) % n
    if (d === 0) return 'c'
    if (n === 2) return 'r'
    return d === 1 ? 'r' : 'l'
  }
  const emptySlots: Slot[] = n === 0 ? ['c'] : n === 1 ? ['l', 'r'] : n === 2 ? ['l'] : []
  const frontBadge = badges[front] ?? null
  const frontIsDefault = frontBadge != null && frontBadge.id === defaultId

  // 滑动：记下按下点，抬起时看横向位移。滑动过的那一次抬起会连带一个 click，
  // 在捕获阶段拦掉，免得转盘转完还弹出详情层。
  // Swipe: remember the pointer-down point and read the horizontal travel on release.
  // A release that ended a swipe also emits a click — intercepted in the capture
  // phase so the detail layer doesn't pop after a rotation.
  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    dragRef.current = { x: e.clientX, y: e.clientY }
    swipedRef.current = false
  }
  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    const start = dragRef.current
    dragRef.current = null
    if (!start || n <= 1) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < Math.abs(dy)) return
    swipedRef.current = true
    // 向左滑 = 右边那枚转到正面 / swipe left = the right-hand badge comes to the front
    setFront((f) => (dx < 0 ? (f + 1) % n : (f - 1 + n) % n))
  }
  function onClickCapture(e: ReactMouseEvent<HTMLDivElement>) {
    if (swipedRef.current) {
      swipedRef.current = false
      e.stopPropagation()
      e.preventDefault()
    }
  }

  return (
    <div className="ach-pedestal" ref={pedRef}>
      <div className="ach-cone" aria-hidden />
      <div className="ach-floorline" aria-hidden />
      <div className="ach-floor" aria-hidden />
      {/* 整个场景（台座 + 转盘 + 倒影）随陀螺仪一起微倾，台座和勋章之间就有了视差。
          The whole scene (plinth + turntable + reflection) tilts with the gyroscope,
          which gives parallax between plinth and badge. */}
      <div className="ach-scene">
        <i className="ach-plinth ach-plinth-outer" aria-hidden />
        <i className="ach-plinth ach-plinth-inner" aria-hidden />
        <div
          className="ach-trio"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => { dragRef.current = null }}
          onClickCapture={onClickCapture}
        >
          {badges.map((b, i) => {
            const slot = slotOf(i)
            return (
              <div key={b.id} className={`ach-3d ach-3d-${slot}`}>
                <div className="ach-sway">
                  <MedalTilt ariaLabel={t(`gamification.badges.${b.id}.name`)} onClick={() => onOpen(b)} className="ach-hero">
                    <BadgeIcon id={b.id} rarity={b.rarity} earned size={RENDER_SIZE} spin={slot === 'c'} />
                  </MedalTilt>
                </div>
              </div>
            )
          })}
          {emptySlots.map((slot) => (
            <div key={`empty-${slot}`} className={`ach-3d ach-3d-${slot}`} aria-hidden>
              <span className="ach-slot" />
            </div>
          ))}
          <div className="ach-refl" aria-hidden>
            {badges.map((b, i) => (
              <span key={b.id} className={`ach-3d ach-3d-${slotOf(i)}`}>
                <BadgeIcon id={b.id} rarity={b.rarity} earned size={RENDER_SIZE} className="ach-hero" />
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="ach-cap">
        {frontBadge ? (
          <>
            <b>{t(`gamification.badges.${frontBadge.id}.name`)}</b>
            {frontIsDefault ? (
              <span>{t('gamification.equipSlots.onBoard')}</span>
            ) : (
              <button type="button" className="ach-cap-btn" disabled={busy} onClick={() => onMakeDefault(frontBadge.id)}>
                {t('gamification.equipSlots.setDefault')}
              </button>
            )}
            <span className="ach-slots" aria-hidden>
              {badges.map((b, i) => (
                <i key={b.id} className={i === front ? 'cur' : ''} title={t(`gamification.badges.${b.id}.name`)} />
              ))}
              {emptySlots.filter((s) => n > 0 || s !== 'c').map((s) => <i key={s} className="empty" />)}
            </span>
            {n > 1 && <small className="ach-swipe-hint">{t('gamification.stage.swipeHint')}</small>}
          </>
        ) : (
          <>
            <b>{t('gamification.stage.noEquip')}</b>
            <span>{t('gamification.stage.noEquipHint')}</span>
          </>
        )}
        {gyro === 'ask' && (
          <button type="button" className="ach-gyro-btn" onClick={enableGyro}>
            {t('gamification.stage.gyroEnable')}
          </button>
        )}
      </div>
    </div>
  )
}
