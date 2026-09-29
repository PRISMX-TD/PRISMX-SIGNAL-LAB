// 语言包「核心 + 按需」拆分的守门测试。
//
// 拆分方式见 i18n/index.ts 的文件头：zh.json / en.json 是核心包（打进入口、预渲染也用），
// zh.more.json / en.more.json 是按需包（App.tsx 的 lazyPage 在页面 chunk 旁一起拉）。
// 拆错的后果是「界面上冒出一行裸 key」——而且只在某个登录后页面、某种语言下才出现，
// 人眼很难在评审里发现。这里按**代码里实际的引用关系**核对：
//   ① 入口 / Layout / 公开页（落地、登录、法务、FAQ）/ 预渲染入口的模块闭包里出现过的键，
//      必须在核心包里（否则这些地方渲染时按需包可能还没到）；
//   ② 页面里 t('字面量') 调用的键，必须能在 核心 ∪ 按需 里找到（不存在的键会原样显示）；
//   ③ 核心与按需不重叠；中英两侧的划分一致。
// 「引用」的口径偏保守：模块里出现的任何字符串字面量，等于某个键（含复数后缀）、或是键的
// 前缀（以 . 结尾的拼接 / 模板串头、或某个非叶子路径）都算用到。宁可把键留在核心包。
//
// Guard for the locale core + on-demand split (see the header of i18n/index.ts).
// A wrong split shows up as a raw key on some signed-in page in one language only, which is
// hard to spot in review, so placement is checked against real references in the code:
//   1. keys mentioned anywhere in the module closure of the entry / Layout / public pages /
//      prerender entry must be in the core bundle;
//   2. literal t('...') calls must resolve in core ∪ more;
//   3. core and more don't overlap, and zh / en split identically.
// "Mentioned" is deliberately conservative: any string literal equal to a key (plural
// suffixes ignored) or that is a key prefix (trailing-dot concatenation / template head, or
// a non-leaf path) counts. Better to keep a key in core than to lose it.
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import zhCore from './zh.json'
import zhMore from './zh.more.json'
import enCore from './en.json'
import enMore from './en.more.json'

function flat(o: object, p = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(o)) {
    const kk = p ? `${p}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, kk, out)
    else out[kk] = v
  }
  return out
}

const strip = (k: string) => k.replace(/_(zero|one|two|few|many|other)$/, '')

const zc = flat(zhCore)
const zm = flat(zhMore)
const ec = flat(enCore)
const em = flat(enMore)
const coreKeys = new Set([...Object.keys(zc), ...Object.keys(ec)])
const moreKeys = new Set([...Object.keys(zm), ...Object.keys(em)])
const allKeys = new Set([...coreKeys, ...moreKeys])
const allBase = new Set([...allKeys].map(strip))

// ---- 源码：模块图 + 字符串字面量 / module graph + string literals ----
const sources = import.meta.glob(['/src/**/*.ts', '/src/**/*.tsx', '!/src/**/*.test.ts', '!/src/**/*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const parts = from.split('/').slice(0, -1)
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  const base = parts.join('/')
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (c in sources) return c
  }
  return null
}

const edges = new Map<string, Set<string>>()
const literals = new Map<string, Set<string>>()
const tCalls = new Map<string, string[]>()
for (const [file, text] of Object.entries(sources)) {
  const deps = new Set<string>()
  const lits = new Set<string>()
  const calls: string[] = []
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const r = resolveImport(file, n.moduleSpecifier.text)
      if (r) deps.add(r)
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const r = resolveImport(file, n.moduleSpecifier.text)
      if (r) deps.add(r)
    } else if (
      ts.isCallExpression(n) &&
      n.expression.kind === ts.SyntaxKind.ImportKeyword &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0])
    ) {
      const r = resolveImport(file, n.arguments[0].text)
      if (r) deps.add(r)
    }
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      lits.add(n.text)
    }
    if (ts.isCallExpression(n) && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
      const callee = n.expression
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : ''
      // t('key') / i18n.t('key')；第二个参数带 defaultValue 的不算「必须存在」
      // Only t('key') / i18n.t('key'); a call with a defaultValue opts out of the existence check.
      if (name === 't' && n.arguments.length < 2) calls.push(n.arguments[0].text)
      else if (name === 't' && n.arguments[1] && !/defaultValue/.test(n.arguments[1].getText())) calls.push(n.arguments[0].text)
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  edges.set(file, deps)
  literals.set(file, lits)
  tCalls.set(file, calls)
}

// App.tsx 里 lazyPage(() => import('./pages/X'), 'X', { core: true }) 的页面算核心根；
// 没写 core 的页面是「按需」页面：不从 App.tsx 顺着走进它们的闭包。
// Pages flagged { core: true } in App.tsx are core roots; unflagged pages are on-demand and
// their closure is not entered from App.tsx.
const APP = '/src/App.tsx'
const appText = sources[APP]
const lazyPageRe = /lazyPage\(\s*\(\)\s*=>\s*import\('([^']+)'\)\s*,\s*'[^']+'\s*(,\s*\{\s*core:\s*true\s*\})?\s*\)/g
const corePageFiles: string[] = []
const onDemandPageFiles = new Set<string>()
for (const m of appText.matchAll(lazyPageRe)) {
  const r = resolveImport(APP, m[1])
  if (!r) continue
  if (m[2]) corePageFiles.push(r)
  else onDemandPageFiles.add(r)
}

function closure(roots: string[]): Set<string> {
  const seen = new Set<string>()
  const stack = [...roots]
  while (stack.length) {
    const f = stack.pop()!
    if (seen.has(f)) continue
    seen.add(f)
    for (const n of edges.get(f) ?? []) {
      if (f === APP && onDemandPageFiles.has(n)) continue
      stack.push(n)
    }
  }
  return seen
}

const coreFiles = closure(['/src/main.tsx', APP, '/src/seo/entry-server.tsx', ...corePageFiles])

function mentioned(files: Iterable<string>): Set<string> {
  const lits = new Set<string>()
  for (const f of files) for (const l of literals.get(f) ?? []) lits.add(l)
  const nonLeaf = new Set<string>()
  for (const k of allKeys) {
    const parts = k.split('.')
    for (let i = 1; i < parts.length; i++) nonLeaf.add(parts.slice(0, i).join('.'))
  }
  const prefixes: string[] = []
  for (const l of lits) {
    if (l.endsWith('.') && l.length > 2) prefixes.push(l)
    else if (l.includes('.') && nonLeaf.has(l)) prefixes.push(`${l}.`)
  }
  const out = new Set<string>()
  for (const k of allKeys) {
    if (lits.has(strip(k))) out.add(k)
    else if (prefixes.some((p) => k.startsWith(p))) out.add(k)
  }
  return out
}

describe('locale core + on-demand split', () => {
  it('finds the page roots in App.tsx', () => {
    // 防止正则失效后下面的校验空转 / guards against the regex silently matching nothing
    expect(corePageFiles.length).toBeGreaterThanOrEqual(6)
    expect(onDemandPageFiles.size).toBeGreaterThanOrEqual(15)
    expect(coreFiles.size).toBeGreaterThan(50)
    expect(coreFiles.has('/src/components/Layout.tsx')).toBe(true)
    expect(coreFiles.has('/src/pages/LandingPage.tsx')).toBe(true)
    expect(coreFiles.has('/src/pages/AdminPage.tsx')).toBe(false)
  })

  it('core and on-demand halves do not overlap', () => {
    expect(Object.keys(zm).filter((k) => k in zc)).toEqual([])
    expect(Object.keys(em).filter((k) => k in ec)).toEqual([])
  })

  it('zh and en split the same way', () => {
    const base = (o: Record<string, unknown>) => new Set(Object.keys(o).map(strip))
    expect([...base(zc)].filter((k) => !base(ec).has(k))).toEqual([])
    expect([...base(ec)].filter((k) => !base(zc).has(k))).toEqual([])
    expect([...base(zm)].filter((k) => !base(em).has(k))).toEqual([])
    expect([...base(em)].filter((k) => !base(zm).has(k))).toEqual([])
  })

  it('every key the entry / Layout / public pages can mention is in the core bundle', () => {
    const missing = [...mentioned(coreFiles)].filter((k) => !coreKeys.has(k))
    // 报错信息里是要挪进 zh.json + en.json（核心）的键
    // The keys listed here must move into zh.json + en.json (core).
    expect(missing).toEqual([])
  })

  it('every literal t() call in a page resolves in core or on-demand', () => {
    const bad: string[] = []
    for (const [file, calls] of tCalls) {
      for (const k of calls) {
        // 带前缀 / 模板拼接的不在这里查 / prefixes and concatenations are not checked here
        if (!k.includes('.')) continue
        if (!allBase.has(k) && !allKeys.has(k)) bad.push(`${file} -> ${k}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('keys every on-demand page mentions exist in both languages', () => {
    // 每个按需页面自己的闭包里引用到的键，中英两侧都要有（核心或按需，两者随页面一起到）
    // Keys mentioned by each on-demand page's closure must exist in zh and en (core or more).
    const zhBase = new Set([...Object.keys(zc), ...Object.keys(zm)].map(strip))
    const enBase = new Set([...Object.keys(ec), ...Object.keys(em)].map(strip))
    const bad: string[] = []
    for (const page of onDemandPageFiles) {
      for (const k of mentioned(closure([page]))) {
        if (!zhBase.has(strip(k)) || !enBase.has(strip(k))) bad.push(`${page} -> ${k}`)
      }
    }
    expect(bad).toEqual([])
  })
})
