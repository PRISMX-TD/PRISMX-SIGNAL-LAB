// 给老引擎补的几个内置 API。**必须是 main.tsx 的第一条 import**：ES 模块按 import 顺序
// 求值，排在后面才补就晚了。
//
// 为什么需要它：vite.config.ts 的 build.target 已降到 Chrome 70（见那边的说明），esbuild
// 能把 `?.` / `??` / 类字段这类**语法**降级，但补不了**运行时 API**——`Promise.allSettled`
// 之类在老引擎上就是 undefined，调用即 TypeError。而其中有一个特别要命：Vite 自己注入的
// 懒加载预取助手（每条 lazy 路由 import 时都跑）用的正是 `Promise.allSettled`，Chrome 76
// 以下没有它，等于**每个页面都进 ErrorBoundary 的错误卡**。
//
// 取舍：手写而不是引 core-js——只补代码里（含依赖产物）实际用到、且目标区间缺失的几个，
// 全部在 dist 里 grep 核对过；每个都先判 `typeof === 'function'`，现代浏览器零开销。
// 不补的：Intl.RelativeTimeFormat（i18next 只在用相对时间格式化时才碰，本站不用）、
// structuredClone / findLast / toSorted（代码与依赖里一个都没有）。
//
// Runtime API shims for older engines. **Must be the first import in main.tsx**:
// ES modules evaluate in import order, so anything imported before this runs
// without the shims. build.target is Chrome 70 (see vite.config.ts); esbuild lowers
// *syntax*, but it cannot add missing *APIs*. One of them matters more than the
// rest: Vite's own preload helper, which runs on every lazy route import, calls
// `Promise.allSettled` — absent before Chrome 76, so every page would land on the
// ErrorBoundary card. Hand-written rather than core-js: only what the dist output
// actually uses and the target range actually lacks, each guarded by a typeof
// check so modern browsers pay nothing.

/* eslint-disable @typescript-eslint/no-explicit-any */

// Chrome 71 / Safari 12.1 / Firefox 65
if (typeof globalThis === 'undefined') {
  // 只在这一处赋值：这是唯一能拿到全局对象的老写法 / the one legacy way to reach the global
  ;(window as any).globalThis = window
}

// Chrome 73 / Safari 12.1 / Firefox 63。indicatorCatalog / IndicatorSettingsModal 直接用，
// 若干依赖也用。/ Used directly in the charts code and by several dependencies.
if (typeof Object.fromEntries !== 'function') {
  Object.defineProperty(Object, 'fromEntries', {
    configurable: true,
    writable: true,
    value: function fromEntries(iterable: Iterable<readonly [PropertyKey, unknown]>) {
      const out: Record<PropertyKey, unknown> = {}
      for (const [k, v] of Array.from(iterable)) out[k as any] = v
      return out
    },
  })
}

// Chrome 93 / Safari 15.4 / Firefox 92。依赖里可能出现；补上便宜。
if (typeof (Object as any).hasOwn !== 'function') {
  Object.defineProperty(Object, 'hasOwn', {
    configurable: true,
    writable: true,
    value: function hasOwn(o: object, k: PropertyKey) {
      return Object.prototype.hasOwnProperty.call(o, k)
    },
  })
}

// Chrome 76 / Safari 13 / Firefox 71。**Vite 的懒加载预取助手每次 import() 都调它。**
if (typeof Promise.allSettled !== 'function') {
  Object.defineProperty(Promise, 'allSettled', {
    configurable: true,
    writable: true,
    value: function allSettled(this: PromiseConstructor, iterable: Iterable<unknown>) {
      const P = this
      return P.all(
        Array.from(iterable, (p) =>
          P.resolve(p).then(
            (value) => ({ status: 'fulfilled' as const, value }),
            (reason) => ({ status: 'rejected' as const, reason }),
          ),
        ),
      )
    },
  })
}

// Chrome 71 / Safari 12.1 / Firefox 69。React 18 自带回退，但依赖里的直接调用没有。
if (typeof (window as any).queueMicrotask !== 'function') {
  ;(window as any).queueMicrotask = (cb: () => void) => {
    Promise.resolve().then(cb).catch((e) => setTimeout(() => { throw e }, 0))
  }
}

// Chrome 69 / Safari 12 / Firefox 62。BacktestPanel 用 flatMap；目标 Chrome 70 已有，
// 只为 Safari 11 一类留着，代价一个 typeof。
if (typeof Array.prototype.flat !== 'function') {
  Object.defineProperty(Array.prototype, 'flat', {
    configurable: true,
    writable: true,
    value: function flat(this: unknown[], depth = 1): unknown[] {
      const out: unknown[] = []
      for (const item of this) {
        if (Array.isArray(item) && depth > 0) out.push(...(item as any).flat(depth - 1))
        else out.push(item)
      }
      return out
    },
  })
}
if (typeof Array.prototype.flatMap !== 'function') {
  Object.defineProperty(Array.prototype, 'flatMap', {
    configurable: true,
    writable: true,
    value: function flatMap(this: unknown[], fn: (v: unknown, i: number, a: unknown[]) => unknown, thisArg?: unknown) {
      return (this.map(fn, thisArg) as any).flat(1)
    },
  })
}

// Chrome 92 / Safari 15.4 / Firefox 90。three.js（落地页桌面端）用到。
if (typeof (Array.prototype as any).at !== 'function') {
  Object.defineProperty(Array.prototype, 'at', {
    configurable: true,
    writable: true,
    value: function at(this: unknown[], n: number) {
      const i = Math.trunc(n) || 0
      const k = i < 0 ? this.length + i : i
      return k < 0 || k >= this.length ? undefined : this[k]
    },
  })
}

// Chrome 85 / Safari 13.1 / Firefox 77。代码里当前没有直接调用，依赖升级后常会出现。
if (typeof (String.prototype as any).replaceAll !== 'function') {
  Object.defineProperty(String.prototype, 'replaceAll', {
    configurable: true,
    writable: true,
    value: function replaceAll(this: string, search: string | RegExp, replacement: any) {
      if (search instanceof RegExp) {
        if (!search.flags.includes('g')) throw new TypeError('replaceAll must be called with a global RegExp')
        return this.replace(search, replacement)
      }
      return this.split(String(search)).join(typeof replacement === 'function' ? replacement(String(search)) : String(replacement))
    },
  })
}

// Chrome 92 / Safari 15.4 / Firefox 95。管理后台的平台策略面板给新条目生成 id。
// getRandomValues 从 Chrome 11 起就有。/ Admin panel ids; getRandomValues is ancient.
if (typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID !== 'function' && typeof crypto.getRandomValues === 'function') {
  ;(crypto as any).randomUUID = function randomUUID(): string {
    const b = crypto.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40 // version 4
    b[8] = (b[8] & 0x3f) | 0x80 // variant
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }
}

export {}
