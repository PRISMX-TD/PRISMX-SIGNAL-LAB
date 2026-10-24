// App 内下载安装新版：插件探测（Plugins 有 / 只有原生桥原语 / 都没有）与下载→校验→安装的状态流。
// 假插件按原生 SignalUpdate 的约定回包与报错码（APP Pack native/apkUpdate.ts）。
// In-App APK update: plugin discovery and the download → verify → install state flow, against a fake
// plugin that resolves / rejects with the native SignalUpdate codes.
import { describe, expect, it, vi } from 'vitest'
import {
  type ApkDownloadResult, type ApkUpdateState, type ApkUpdater,
  downloadAndInstall, getApkUpdater, installDownloaded, probeApkUpdater,
} from './nativeApkUpdate'

const URL = 'https://github.com/x/y/releases/download/app-latest/SignalLab.apk'
const last = <T,>(xs: T[]) => xs[xs.length - 1]
const reject = (code?: string) => Promise.reject(Object.assign(new Error(code ?? 'boom'), code ? { code } : {}))

function fake(opts: {
  result?: Partial<ApkDownloadResult>
  downloadError?: string
  installError?: string
  progress?: Array<[number, number]>
  lateProgress?: boolean
} = {}) {
  let cb: ((d: { loaded: number; total: number }) => void) | null = null
  const remove = vi.fn(async () => {})
  const u: ApkUpdater = {
    info: vi.fn(async () => ({ versionName: '1.0.5', versionCode: 12 })),
    addListener: vi.fn((_e, f) => { cb = f; return { remove } }),
    download: vi.fn(async () => {
      for (const [loaded, total] of opts.progress ?? []) cb?.({ loaded, total })
      if ('downloadError' in opts) return reject(opts.downloadError)
      return { versionName: '1.0.6', versionCode: 13, currentVersionName: '1.0.5', currentVersionCode: 12, ...opts.result }
    }),
    install: vi.fn(async () => {
      if (opts.lateProgress) cb?.({ loaded: 1, total: 2 })
      if (opts.installError) return reject(opts.installError)
      return undefined
    }),
  }
  const states: ApkUpdateState[] = []
  return { u, remove, states, set: (s: ApkUpdateState) => { states.push(s) } }
}

describe('getApkUpdater', () => {
  it('uses the injected Capacitor.Plugins.SignalUpdate when it is there', () => {
    const own = { info: vi.fn(), download: vi.fn(), install: vi.fn(), addListener: vi.fn() }
    expect(getApkUpdater({ Capacitor: { Plugins: { SignalUpdate: own } } })).toBe(own)
  })

  it('builds one from the bridge primitives when Plugins is empty', async () => {
    const nativePromise = vi.fn(async () => ({ versionName: '1.0.5', versionCode: 12 }))
    const addListener = vi.fn(() => ({ remove: vi.fn() }))
    const u = getApkUpdater({ Capacitor: { Plugins: {}, nativePromise, addListener } })!
    await u.download({ url: URL })
    u.addListener('progress', () => {})
    expect(nativePromise).toHaveBeenCalledWith('SignalUpdate', 'download', { url: URL })
    expect(addListener).toHaveBeenCalledWith('SignalUpdate', 'progress', expect.any(Function))
  })

  it('returns null in a plain browser', () => {
    expect(getApkUpdater({})).toBeNull()
    expect(getApkUpdater(undefined)).toBeNull()
    expect(getApkUpdater({ Capacitor: { Plugins: {} } })).toBeNull()
  })
})

describe('probeApkUpdater', () => {
  it('returns the version when the plugin answers', async () => {
    const { u } = fake()
    expect(await probeApkUpdater(u)).toEqual({ versionName: '1.0.5', versionCode: 12 })
  })

  it('returns null on an older APK ("unable to find plugin")', async () => {
    const { u } = fake()
    u.info = () => Promise.reject(new Error('unable to find plugin : SignalUpdate'))
    expect(await probeApkUpdater(u)).toBeNull()
  })
})

describe('downloadAndInstall', () => {
  it('reports progress, then opens the installer for a newer build', async () => {
    const f = fake({ progress: [[0, 200], [100, 200], [200, 200]] })
    await downloadAndInstall(f.u, URL, f.set)
    expect(f.states).toEqual([
      { kind: 'downloading', percent: null },
      { kind: 'downloading', percent: 0 },
      { kind: 'downloading', percent: 50 },
      { kind: 'downloading', percent: 100 },
      { kind: 'opening' },
      { kind: 'opened' },
    ])
    expect(f.u.download).toHaveBeenCalledWith({ url: URL })
    expect(f.u.install).toHaveBeenCalledTimes(1)
    expect(f.remove).toHaveBeenCalledTimes(1)
  })

  it('shows an unknown size as no percentage', async () => {
    const f = fake({ progress: [[300, -1]] })
    await downloadAndInstall(f.u, URL, f.set)
    expect(f.states[1]).toEqual({ kind: 'downloading', percent: null })
  })

  it('does not install when the download is not newer than what is installed', async () => {
    const f = fake({ result: { versionName: '1.0.5', versionCode: 12 } })
    await downloadAndInstall(f.u, URL, f.set)
    expect(last(f.states)).toEqual({ kind: 'upToDate', version: '1.0.5' })
    expect(f.u.install).not.toHaveBeenCalled()
  })

  it('maps a failed verification to a package error and a network error otherwise', async () => {
    for (const [code, reason] of [['SIGNATURE_MISMATCH', 'package'], ['BAD_PACKAGE', 'package'], ['DOWNLOAD_FAILED', 'network'], [undefined, 'network']] as const) {
      const f = fake({ downloadError: code })
      await downloadAndInstall(f.u, URL, f.set)
      expect(last(f.states)).toEqual({ kind: 'failed', reason })
      expect(f.u.install).not.toHaveBeenCalled()
      expect(f.remove).toHaveBeenCalledTimes(1)
    }
  })

  it('ignores progress events that arrive after the download settled', async () => {
    const f = fake({ lateProgress: true })
    await downloadAndInstall(f.u, URL, f.set)
    expect(f.states.slice(-2)).toEqual([{ kind: 'opening' }, { kind: 'opened' }])
  })

  it('still downloads when the progress listener cannot be attached', async () => {
    const f = fake()
    f.u.addListener = () => { throw new Error('no listener') }
    await downloadAndInstall(f.u, URL, f.set)
    expect(last(f.states)).toEqual({ kind: 'opened' })
  })
})

describe('installDownloaded', () => {
  it('asks for the install permission when the user did not allow it', async () => {
    const f = fake({ installError: 'PERMISSION_DENIED' })
    await installDownloaded(f.u, f.set)
    expect(f.states).toEqual([{ kind: 'opening' }, { kind: 'needPermission' }])
  })

  it('goes back to idle when the downloaded file is gone (App restarted)', async () => {
    const f = fake({ installError: 'NO_FILE' })
    await installDownloaded(f.u, f.set)
    expect(last(f.states)).toEqual({ kind: 'idle' })
  })

  it('reports an installer failure separately from a bad package', async () => {
    const a = fake({ installError: 'INSTALL_FAILED' })
    await installDownloaded(a.u, a.set)
    expect(last(a.states)).toEqual({ kind: 'failed', reason: 'install' })
    const b = fake({ installError: 'SIGNATURE_MISMATCH' })
    await installDownloaded(b.u, b.set)
    expect(last(b.states)).toEqual({ kind: 'failed', reason: 'package' })
  })
})
