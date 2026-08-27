/* 后台填写的 URL 在放进 href / src 之前统一过这一道。
 *
 * 这些字段只有管理员能写，但"只有管理员能写"不等于安全：一次配置失误（粘错、
 * 被诱导粘贴一段 `javascript:` 开头的串）就会从一处填错升级成一次真正的脚本
 * 执行。判据放在渲染侧而不是保存侧，是因为库里可能已经存着历史数据，保存侧的
 * 校验管不到它们。
 *
 * 只放行 http(s)。刻意不接受 `data:`：图片本体走后台的上传功能（存到对象存储、
 * 拿回一个 https 地址），没有任何正常路径需要往这个字段里粘几十 KB 的 base64。
 *
 * Admin-entered URLs pass through here before reaching an href or src.
 *
 * Only an admin can write these fields, but "admin-only" is not the same as
 * safe: one configuration slip — a mis-paste, or being talked into pasting a
 * `javascript:` string — turns a wrong value into actual script execution. The
 * check lives at the render site rather than at save time because rows already
 * in the database predate any save-time validation.
 *
 * http(s) only. `data:` is deliberately rejected: image bytes go through the
 * admin upload flow (stored in object storage, returning an https URL), so no
 * legitimate path needs tens of kilobytes of base64 in this field.
 */
export function safeHttpUrl(raw: string | undefined | null): string {
  const url = (raw || '').trim()
  return /^https?:\/\//i.test(url) ? url : ''
}
