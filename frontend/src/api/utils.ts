// 通用工具 / Common utilities

// 生成幂等下单 ID / generate idempotent client order id
export function clientOrderId(): string {
  return 'co_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

// 格式化时间 / format timestamp
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}
