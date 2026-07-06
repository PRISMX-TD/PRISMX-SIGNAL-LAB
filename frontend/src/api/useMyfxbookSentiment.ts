// Myfxbook 社区情绪 hook：读后端缓存接口，不再直连/代理 Myfxbook。
// Myfxbook community sentiment hook: reads the backend cache endpoint,
// no longer fetches/proxies Myfxbook directly.
import { useState, useEffect, useRef } from 'react'
import { myfxbookApi } from './client'
import type { MyfxSentiment } from './types'

const POLL_MS = 5 * 60 * 1000 // 每 5 分钟刷新一次 / refresh every 5 min

export function useMyfxbookSentiment() {
  const [sentiment, setSentiment] = useState<Record<string, MyfxSentiment>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    const refresh = async () => {
      try {
        const data = await myfxbookApi.sentiment()
        if (mountedRef.current) {
          setSentiment(data.sentiment)
          setError(null)
        }
      } catch (err: unknown) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        if (mountedRef.current) setLoading(false)
      }
    }

    refresh()
    const timer = setInterval(refresh, POLL_MS)
    return () => {
      mountedRef.current = false
      clearInterval(timer)
    }
  }, [])

  return { sentiment, loading, error }
}
