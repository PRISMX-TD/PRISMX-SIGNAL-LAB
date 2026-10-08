// useToast 那一条提示的渲染。面板顶部和抽屉里各放一份：抽屉打开时面板顶部被遮罩盖住，
// 抽屉里的保存结果必须在抽屉里看得到。
// Renders the useToast banner. One at the panel top and one inside each drawer: the
// overlay hides the panel top while a drawer is open.
import type { Toast } from '../../../utils/useToast'

export default function ToastBar({ toast, className = '' }: { toast: Toast | null; className?: string }) {
  if (!toast) return null
  return (
    <div
      role="status"
      className={`rounded-lg border px-4 py-2.5 text-sm ${
        toast.kind === 'err' ? 'border-down/40 bg-down/15 text-down' : 'border-up/40 bg-up/15 text-up'
      } ${className}`}
    >
      {toast.text}
    </div>
  )
}
