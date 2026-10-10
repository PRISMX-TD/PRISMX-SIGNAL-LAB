// CSP 内联脚本哈希校验 / 生成。
//
// vercel.json 的 script-src 不再有 'unsafe-inline'，内联脚本靠 sha256 逐条放行。任何一段内联
// 脚本（index.html 里的、或 scripts/inline-scripts.mjs 里构建时注入的）改了一个字符（含注释、
// 空格），哈希就变，线上那段脚本会被浏览器静默拦掉——像素、首页防闪、已登录预载全部失效。
// 所以：
//   node scripts/check-csp-hashes.mjs            校验（不一致退出码 1；vitest 里也跑同一套）
//   node scripts/check-csp-hashes.mjs --write    按当前源码重写 vercel.json 里的哈希
//   node scripts/check-csp-hashes.mjs --dist dist 校验构建产物里每一个内联脚本都已放行
//
// 哈希按 HTML 解析后的脚本文本算：解析器会把 CRLF / 单独的 CR 归一成 LF，所以这里也先归一
// （Windows 工作区检出的是 CRLF，线上从 git 构建是 LF，浏览器看到的都是 LF）。
//
// The CSP in vercel.json allows inline scripts by sha256 instead of 'unsafe-inline'. Any
// change to an inline script (index.html, or the build-injected ones in
// scripts/inline-scripts.mjs) — comments and whitespace included — changes its hash and the
// browser silently blocks it in production. Run without flags to check (also run by
// vitest), --write to regenerate the hashes, or --dist <dir> to verify a build's output.
// Hashes are over the parsed script text; the HTML parser normalises CRLF / CR to LF, so
// we do too (a Windows checkout has CRLF, the git-based production build has LF).
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILD_INJECTED_SCRIPTS } from './inline-scripts.mjs'

export const FRONTEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CSP_HEADER = 'Content-Security-Policy'

// 执行型脚本的 type：缺省 / 空 / JS MIME / module。其余（application/json、ld+json）是数据块。
// Executing script types; anything else (application/json, ld+json) is a data block.
const EXEC_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module'])

export function sha256Source(text) {
  const normalized = text.replace(/\r\n?/g, '\n')
  return `'sha256-${createHash('sha256').update(normalized, 'utf8').digest('base64')}'`
}

/** HTML 里所有执行型内联脚本的文本 / text of every executing inline script in an HTML document */
export function inlineScripts(html) {
  const out = []
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '')
  for (const m of noComments.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1]
    if (/\bsrc\s*=/i.test(attrs)) continue
    const type = (/\btype\s*=\s*["']?([^"'\s>]*)/i.exec(attrs)?.[1] || '').toLowerCase()
    if (!EXEC_TYPES.has(type)) continue
    out.push(m[2])
  }
  return out
}

/** 源码应有的哈希集合（index.html + 构建注入的脚本），已排序 / expected hashes from source, sorted */
export function expectedHashes(root = FRONTEND_ROOT) {
  const html = readFileSync(join(root, 'index.html'), 'utf8')
  const all = [...inlineScripts(html), ...BUILD_INJECTED_SCRIPTS].map(sha256Source)
  return [...new Set(all)].sort()
}

function cspEntry(vercel) {
  for (const block of vercel.headers || []) {
    for (const h of block.headers || []) {
      if (h.key === CSP_HEADER) return h
    }
  }
  throw new Error('vercel.json 里找不到 Content-Security-Policy 头 / no CSP header in vercel.json')
}

function scriptSrcTokens(csp) {
  const dir = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => /^script-src\s/i.test(d))
  if (!dir) throw new Error('CSP 里没有 script-src / CSP has no script-src')
  return dir.split(/\s+/).slice(1)
}

export function readVercel(root = FRONTEND_ROOT) {
  return JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'))
}

/** vercel.json 当前 script-src 的 { hashes, tokens } / current script-src hashes and tokens */
export function cspScriptSrc(vercel) {
  const tokens = scriptSrcTokens(cspEntry(vercel).value)
  return { tokens, hashes: tokens.filter((t) => /^'sha(256|384|512)-/.test(t)).sort() }
}

/** 用给定哈希替换 script-src 里的哈希，并去掉 'unsafe-inline' / swap the hashes in, drop 'unsafe-inline' */
export function withHashes(vercel, hashes) {
  const entry = cspEntry(vercel)
  entry.value = entry.value
    .split(';')
    .map((d) => {
      const t = d.trim()
      if (!/^script-src\s/i.test(t)) return t
      const keep = t
        .split(/\s+/)
        .slice(1)
        .filter((x) => x !== "'unsafe-inline'" && !/^'sha(256|384|512)-/.test(x))
      // 哈希紧跟 'self'，外部主机放后面 / hashes right after 'self', hosts after
      const selfIdx = keep.indexOf("'self'")
      keep.splice(selfIdx + 1, 0, ...hashes)
      return ['script-src', ...keep].join(' ')
    })
    .join('; ')
  return vercel
}

function walkHtml(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walkHtml(p))
    else if (name.endsWith('.html')) out.push(p)
  }
  return out
}

/** 构建产物里没被放行的内联脚本 / inline scripts in a build that the CSP doesn't allow */
export function unlistedInDist(distDir, allowed) {
  const allow = new Set(allowed)
  const missing = []
  for (const file of walkHtml(distDir)) {
    for (const s of inlineScripts(readFileSync(file, 'utf8'))) {
      const h = sha256Source(s)
      if (!allow.has(h)) missing.push({ file, hash: h, head: s.trim().slice(0, 60) })
    }
  }
  return missing
}

function main(argv) {
  const vercel = readVercel()
  const want = expectedHashes()
  const { tokens, hashes } = cspScriptSrc(vercel)

  if (argv.includes('--write')) {
    writeFileSync(join(FRONTEND_ROOT, 'vercel.json'), JSON.stringify(withHashes(vercel, want), null, 2) + '\n')
    console.log(`vercel.json script-src 已更新 / updated: ${want.join(' ')}`)
    return 0
  }

  let bad = 0
  if (tokens.includes("'unsafe-inline'")) {
    console.error("✗ script-src 仍含 'unsafe-inline' / script-src still has 'unsafe-inline'")
    bad++
  }
  if (JSON.stringify(hashes) !== JSON.stringify(want)) {
    console.error('✗ vercel.json 的 CSP 哈希与内联脚本不一致 / CSP hashes out of date')
    console.error(`  应为 / expected: ${want.join(' ')}`)
    console.error(`  现为 / actual:   ${hashes.join(' ')}`)
    console.error('  运行 / run: node scripts/check-csp-hashes.mjs --write')
    bad++
  }
  const di = argv.indexOf('--dist')
  if (di !== -1) {
    const distDir = resolve(argv[di + 1] || join(FRONTEND_ROOT, 'dist'))
    const missing = unlistedInDist(distDir, hashes)
    for (const m of missing) console.error(`✗ ${m.file}: ${m.hash} 未放行 / not allowed — ${m.head}`)
    bad += missing.length
    if (!missing.length) console.log(`✓ ${distDir} 里的内联脚本全部在 CSP 里 / all inline scripts allowed`)
  }
  if (!bad) console.log(`✓ CSP script-src 哈希最新 / up to date (${want.length})`)
  return bad ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)))
}
