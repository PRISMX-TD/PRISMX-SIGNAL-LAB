// 图片输入：上传按钮 + 手填 URL 输入框，两者写同一个字段。
//
// 保留手填 URL 而不是只给上传：后台未配置存储时上传端点返回 503，此时手填仍然
// 可用，配图功能不会整体不可用。已经放在别处的图片也不必重新上传一份。
//
// Image input: an upload button plus a URL field, both writing the same value.
//
// The URL field stays rather than upload-only: when storage isn't configured the
// upload endpoint returns 503, and pasting a URL still works, so illustrations
// never become wholly unavailable. Images already hosted elsewhere also don't
// need re-uploading.
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../api/client'
import { localizeApiError } from '../../api/utils'

export default function ImageField({
  label,
  value,
  onChange,
  compact = false,
}: {
  label?: string
  value: string
  onChange: (url: string) => void
  compact?: boolean
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const upload = async (file: File) => {
    setError(null)
    setBusy(true)
    try {
      const res = await adminApi.uploadImage(file)
      onChange(res.url)
    } catch (err) {
      setError(localizeApiError(err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(false)
      // 清空 input：不清的话再选同一个文件不触发 change，重试会像没反应
      // Reset the input: otherwise re-picking the same file fires no change event
      // and a retry looks unresponsive
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="block">
      {label && <span className="mb-1 block text-xs text-slate-400">{label}</span>}
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void upload(f)
          }}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="btn-ghost shrink-0 px-3 py-1 text-xs disabled:opacity-40"
        >
          {busy ? t('admin.strategyGuide.uploading') : t('admin.strategyGuide.upload')}
        </button>
        <input
          className="input min-w-0 flex-1 py-1 text-xs"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('admin.strategyGuide.imageUrlOrUpload')}
          maxLength={500}
        />
      </div>
      {error && <p className="mt-1 text-xs text-down">{error}</p>}
      {value && (
        <img
          src={value}
          alt=""
          className={`mt-2 rounded-lg border border-white/10 object-contain ${compact ? 'max-h-32' : 'max-h-40'}`}
        />
      )}
    </div>
  )
}
