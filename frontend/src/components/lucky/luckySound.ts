// 转盘的声音：指针拨过格子的「嗒」、中奖的上行琶音、没中的两声轻音、「再来一次」的弹跳音。
// 全部用 Web Audio 现场合成，不带音频文件。AudioContext 只在用户点「抽奖」那一下创建 / 唤醒
// （iOS 与 Chrome 都要求在用户手势里），所以声音永远不会在没操作时自己响。
// 开关记在本机（localStorage，读写失败就当默认开），与账号无关。
// Wheel sounds: the pointer's tick, a rising arpeggio for a win, two soft notes for a miss and a bounce
// for "spin again", all synthesised with Web Audio (no audio files). The AudioContext is created or
// resumed only inside the spin tap (iOS and Chrome require a user gesture), so nothing ever plays
// unprompted. The on/off preference is a device setting in localStorage; failures mean "on".
import { readStorage, writeStorage } from '../../utils/safeStorage'

export const SOUND_KEY = 'prismx.lucky.sound'

export function soundEnabled(): boolean {
  return readStorage(SOUND_KEY) !== 'off'
}

export function setSoundEnabled(on: boolean): void {
  writeStorage(SOUND_KEY, on ? 'on' : 'off')
}

type Ctx = AudioContext
let ctx: Ctx | null = null
let lastTick = 0

/** 在点击处理函数里调用：创建或唤醒 AudioContext / Call from the tap handler: create or resume the context. */
export function primeAudio(): void {
  if (!soundEnabled()) return
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    if (!ctx) ctx = new AC()
    if (ctx.state === 'suspended') void ctx.resume()
  } catch {
    ctx = null
  }
}

// 声音只是点缀：任何一步出错都吞掉。tick 在转盘的逐帧回调里调用，这里一抛异常转盘就停在半路、
// 结果永远出不来。connect 也不能链式写：Safari 12.0 的 connect() 返回 undefined。
// Sound is decoration, so every failure is swallowed: ticks run inside the wheel's per-frame callback,
// and a throw there would freeze the wheel mid-turn with no result. connect() isn't chained either:
// it returns undefined on Safari 12.0.
function tone(freq: number, start: number, dur: number, gain: number, type: OscillatorType = 'triangle') {
  if (!ctx) return
  try {
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = type
    o.frequency.setValueAtTime(freq, start)
    g.gain.setValueAtTime(0.0001, start)
    g.gain.exponentialRampToValueAtTime(gain, start + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur)
    o.connect(g)
    g.connect(ctx.destination)
    o.start(start)
    o.stop(start + dur + 0.02)
  } catch { /* 没声音就算了 / no sound is fine */ }
}

function ready(): boolean {
  return !!ctx && ctx.state === 'running' && soundEnabled()
}

/** 指针拨过一格。高速时一帧可能跨好几格，限到每 40ms 最多一声，免得糊成噪音。
 *  The pointer passing a slot; capped at one per 40 ms so a fast spin doesn't smear into noise. */
export function playTick(): void {
  if (!ready()) return
  const now = ctx!.currentTime
  if (now - lastTick < 0.04) return
  lastTick = now
  tone(1900, now, 0.035, 0.05, 'square')
}

export function playWin(): void {
  if (!ready()) return
  const t = ctx!.currentTime + 0.02
  ;[523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, t + i * 0.09, 0.32, 0.09, 'triangle'))
  tone(1567.98, t + 0.38, 0.5, 0.05, 'sine')
}

export function playMiss(): void {
  if (!ready()) return
  const t = ctx!.currentTime + 0.02
  tone(392, t, 0.22, 0.06, 'sine')
  tone(329.63, t + 0.16, 0.34, 0.05, 'sine')
}

export function playRetry(): void {
  if (!ready()) return
  const t = ctx!.currentTime + 0.02
  tone(587.33, t, 0.14, 0.07, 'triangle')
  tone(880, t + 0.1, 0.24, 0.07, 'triangle')
}
