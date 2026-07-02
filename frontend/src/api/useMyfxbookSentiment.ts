// Myfxbook 社区情绪 hook / Myfxbook community sentiment hook
import { useState, useEffect, useRef } from 'react'
import { fetchMyfxbookSentiment, type MyfxSentiment } from './myfxbook'

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
        const data = await fetchMyfxbookSentiment()
        if (mountedRef.current) {
          setSentiment(data)
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
