// 构建时注入页面的内联脚本：内容必须**每次构建都一样**，因为 vercel.json 的 CSP 用 sha256
// 哈希放行内联脚本（不再用 'unsafe-inline'）。随构建变化的数据（带哈希的 chunk 文件名）放进
// 不执行的 <script type="application/json"> 数据块，CSP 不管它；执行的那段只负责读它。
// 改这里的脚本文本 → 运行 node scripts/check-csp-hashes.mjs --write 更新 vercel.json。
//
// Inline scripts injected at build time. Their text must be identical on every build,
// because the CSP in vercel.json allows inline scripts by sha256 hash (no more
// 'unsafe-inline'). Per-build data (hashed chunk names) goes in a non-executing
// <script type="application/json"> block, which CSP ignores; the executing script just
// reads it. After editing a script here, run node scripts/check-csp-hashes.mjs --write.

export const SHELL_PRELOAD_DATA_ID = 'shell-preload'

// app.html：已登录（localStorage 有 prismx_token）才 modulepreload Layout / Dashboard 与上次语言的
// 按需语言包。读 localStorage 必须 try/catch（隐私模式会抛）。
// app.html: modulepreload Layout / Dashboard and the remembered language's lazy locale only
// when signed in; try/catch because localStorage throws in private mode.
export const SHELL_PRELOAD_SCRIPT =
  "try{if(localStorage.getItem('prismx_token')){var d=JSON.parse(document.getElementById('" +
  SHELL_PRELOAD_DATA_ID +
  "').textContent);d.base.concat(localStorage.getItem('prismx_lang')==='en'?d.en:d.zh).forEach(function(h){var l=document.createElement('link');l.rel='modulepreload';l.crossOrigin='';l.href=h;document.head.appendChild(l)})}}catch(e){}"

/** 数据块：JSON 里的 < 转义，防止文件名之类的值提前闭合 </script>。
 *  Data block; "<" is escaped so no value can close the element early. */
export function shellPreloadDataTag(data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  return `<script type="application/json" id="${SHELL_PRELOAD_DATA_ID}">${json}</script>`
}

/** 所有由构建脚本注入、需要放进 CSP 的执行型内联脚本 / every executing inline script the build injects */
export const BUILD_INJECTED_SCRIPTS = [SHELL_PRELOAD_SCRIPT]
