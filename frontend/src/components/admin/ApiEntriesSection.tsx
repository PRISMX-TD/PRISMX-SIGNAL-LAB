// 运营设置里的「备用入口」（2026-11-11）：管理员追加的后端入口，一行一个。
//
// App / 网页在还能连上的时候每 6 小时拉一次这份列表、记在本地，排在内置入口前面
// （src/api/apiBase.ts）。某个地区把现有的域名或 IP 封了时，事先加在这里的新入口就能直接
// 接上，不用发版本、不用热更新。新入口必须先在服务器上搭好（证书、nginx，见《运维手册》
// §11.5「按域名拦截与 IP 入口」），再填进来——填一个打不通的地址只会被跳过，不会坏事。
//
// "Extra API entries" in Ops settings (2026-11-11): admin-added backend bases, one per line.
// Clients fetch this every 6 hours while they can connect, keep it locally and try it ahead of
// their built-in entries (src/api/apiBase.ts), so when a region blocks the existing domains or
// IPs a new entry added here takes over with no release or hot update. Set the server up first
// (cert, nginx); an unreachable address is simply skipped.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../api/client'
import { sanitizeEntries } from '../../api/apiBase'
import { localizeApiError } from '../../api/utils'

export default function ApiEntriesSection({
  onError,
  onSaved,
}: {
  onError: (msg: string) => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [text, setText] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    adminApi
      .getApiEntries()
      .then((r) => {
        if (alive) setText(r.entries.join('\n'))
      })
      .catch((e) => {
        if (alive) onError(e instanceof Error ? localizeApiError(e.message) : String(e))
      })
    return () => {
      alive = false
    }
  }, [onError])

  if (text === null) return null

  const save = async () => {
    // 逐行本地先校验：后端也校验，但它的 422 说不清是哪一行。
    // Validate line by line first: the backend checks too, but its 422 can't say which line.
    const lines = text
      .split('\n')
      .map((l) => l.trim().replace(/\/+$/, ''))
      .filter(Boolean)
    const bad = lines.find((l) => sanitizeEntries([l]).length !== 1)
    if (bad) {
      onError(t('admin.apiEntriesInvalid', { line: bad }))
      return
    }
    if (lines.length > 20) {
      onError(t('admin.apiEntriesTooMany'))
      return
    }
    setSaving(true)
    try {
      const r = await adminApi.updateApiEntries({ entries: lines })
      setText(r.entries.join('\n'))
      onSaved()
    } catch (e) {
      onError(e instanceof Error ? localizeApiError(e.message) : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="glass mb-5 p-5">
      <h3 className="mb-1.5 font-display text-lg font-semibold text-neutral-100">{t('admin.apiEntriesTitle')}</h3>
      <p className="mb-4 text-xs text-neutral-500">{t('admin.apiEntriesHint')}</p>
      <textarea
        className="input min-h-28 font-mono text-xs"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={'https://1.2.3.4/_b\nhttps://api.example.com'}
      />
      <button
        className="btn-primary mt-4 px-5 py-2 text-sm disabled:opacity-40"
        disabled={saving}
        onClick={save}
      >
        {saving ? t('common.loading') : t('common.save')}
      </button>
    </div>
  )
}
