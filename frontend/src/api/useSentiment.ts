// 社区多空情绪 hook：读后端缓存接口（数据源见后端 sentiment_store.py 说明）。
// Community sentiment hook: reads the backend cache endpoint (data source
// documented in the backend's sentiment_store.py).
import { useState, useEffect, useRef } from 'react'
import { sentimentApi } from './client'
import type { SentimentRatio } from './types'

const POLL_MS = 5 * 60 * 1000 // 每 5 分钟刷新一次 / refresh every 5 min

export function useSentiment() {
  const [sentiment, setSentiment] = useState<Record<string, SentimentRatio>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    const refresh = async () => {
      try {
        const data = await sentimentApi.get()
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
