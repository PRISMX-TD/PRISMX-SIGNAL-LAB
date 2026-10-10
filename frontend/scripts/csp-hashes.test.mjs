// vercel.json 的 CSP 哈希必须与内联脚本同步；index.html 像素清单必须与 TS 常量一致。
// `npm run build` 先跑 vitest，所以哪边漏改，构建就红掉，不会把被 CSP 拦掉的脚本发上线。
// The CSP hashes in vercel.json must match the inline scripts, and index.html's pixel
// denylist must match the TS constant. `npm run build` runs vitest first, so a missed
// update fails the build instead of shipping a script the CSP blocks.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FRONTEND_ROOT,
  cspScriptSrc,
  expectedHashes,
  inlineScripts,
  readVercel,
  sha256Source,
  withHashes,
} from './check-csp-hashes.mjs'
import { SHELL_PRELOAD_SCRIPT, shellPreloadDataTag } from './inline-scripts.mjs'
import { PIXEL_BLOCKED_PATHS } from '../src/utils/pixelPrivacy.ts'

const indexHtml = readFileSync(join(FRONTEND_ROOT, 'index.html'), 'utf8')

describe('CSP script-src', () => {
  it("vercel.json 的哈希最新且不含 'unsafe-inline' / hashes current, no 'unsafe-inline' (fix: node scripts/check-csp-hashes.mjs --write)", () => {
    const { tokens, hashes } = cspScriptSrc(readVercel())
    expect(tokens).not.toContain("'unsafe-inline'")
    expect(hashes).toEqual(expectedHashes())
    // 外部脚本主机仍在 / external script hosts still allowed
    expect(tokens).toContain("'self'")
    expect(tokens).toContain('https://connect.facebook.net')
    expect(tokens).toContain('https://accounts.google.com')
  })

  it('index.html 的执行型内联脚本都被统计到 / every executing inline script in index.html is counted', () => {
    const scripts = inlineScripts(indexHtml)
    expect(scripts.length).toBe(2)
    expect(scripts.some((s) => s.includes('fbq'))).toBe(true)
    expect(scripts.some((s) => s.includes('data-home-hold'))).toBe(true)
  })

  it('跳过外链与数据块，CRLF 与 LF 同哈希 / skips src and data blocks; CRLF hashes like LF', () => {
    const html = [
      '<!-- <script>commented()</script> -->',
      '<script src="/x.js"></script>',
      '<script type="application/ld+json">{"a":1}</script>',
      '<script type="application/json" id="d">[1]</script>',
      '<script>a()</script>',
      '<script type="module">b()</script>',
    ].join('\n')
    expect(inlineScripts(html)).toEqual(['a()', 'b()'])
    expect(sha256Source('a\r\nb')).toBe(sha256Source('a\nb'))
    // 已知向量：sha256("alert(1)") / known vector
    expect(sha256Source('alert(1)')).toBe("'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='")
  })

  it('withHashes 去掉 unsafe-inline、替换旧哈希、保留其余指令 / swaps hashes, keeps the rest', () => {
    const v = {
      headers: [
        {
          source: '/(.*)',
          headers: [{ key: 'Content-Security-Policy', value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'sha256-old=' https://a.example; img-src 'self'" }],
        },
      ],
    }
    const out = withHashes(v, ["'sha256-new='"]).headers[0].headers[0].value
    expect(out).toBe("default-src 'self'; script-src 'self' 'sha256-new=' https://a.example; img-src 'self'")
  })

  it('app.html 的预载脚本文本固定，数据进 JSON 块 / shell preload script is static, data goes in a JSON block', () => {
    expect(SHELL_PRELOAD_SCRIPT).not.toMatch(/assets\//)
    const tag = shellPreloadDataTag({ base: ['/assets/a.js'], en: [], zh: ['</script><script>x()'] })
    expect(tag).toMatch(/^<script type="application\/json" id="shell-preload">/)
    expect(tag).not.toContain('</script><script>')
    expect(inlineScripts(tag)).toEqual([])
  })
})

describe('Meta Pixel 敏感页清单 / pixel denylist', () => {
  it('index.html 内联清单与 PIXEL_BLOCKED_PATHS 一致 / index.html copy matches PIXEL_BLOCKED_PATHS', () => {
    const m = /\/\*PIXEL_BLOCKED_PATHS\*\/(\[[^\]]*\])/.exec(indexHtml)
    expect(m).not.toBeNull()
    const inline = JSON.parse(m[1].replace(/'/g, '"'))
    expect(inline).toEqual([...PIXEL_BLOCKED_PATHS])
  })

  it('清单检查在 fbq 安装之前 / the denylist check runs before fbq is installed', () => {
    const pixel = inlineScripts(indexHtml).find((s) => s.includes('fbq'))
    expect(pixel.indexOf('PIXEL_BLOCKED_PATHS')).toBeLessThan(pixel.indexOf('n=f.fbq='))
    expect(pixel.indexOf('token=')).toBeLessThan(pixel.indexOf("n('init'"))
    expect(pixel).toContain('n.disablePushState=!0')
  })
})
