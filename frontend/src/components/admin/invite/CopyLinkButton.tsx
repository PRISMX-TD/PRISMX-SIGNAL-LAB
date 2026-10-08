// 「复制」按钮。代理链接展开小菜单：邀请链接（/?ref=）/ 比赛链接（/c?ref=，固定指向
// 主推比赛，§1.2）；比赛推广链接复制本场公开页；平台链接复制首页。
// 菜单是绝对定位的：放它的容器不能 overflow 裁切（桌面表格外层因此不加 overflow-x-auto）。
// The Copy button. Agent links open a small menu (invite / competition link, §1.2);
// competition promo links copy their public page; platform links the landing page.
// The menu is absolutely positioned, so its container must not clip overflow.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { InviteLink } from '../../../api/types'
import { agentCompetitionUrl, inviteUrl, promoLinkUrl } from '../../../utils/promoLinkUrl'
import { linkKind } from './inviteLinkLogic'

// navigator.clipboard 在非安全上下文整体不存在（同步抛 TypeError 而不是返回被拒绝的
// promise），所以整段包在 try 里（照 UpgradePage 的处理）。
// navigator.clipboard is absent entirely outside secure contexts and throws
// synchronously — hence the whole call sits inside the try.
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export default function CopyLinkButton({ link, onFail }: { link: InviteLink; onFail: () => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const isAgent = linkKind(link) === 'agent'

  useEffect(() => () => window.clearTimeout(timer.current), [])

  // 点菜单外关闭。不接 Esc：放在抽屉里时 Esc 归抽屉（useDialogA11y），两边都接会一下关两层。
  // Close on outside pointer. No Escape: inside a drawer Escape belongs to the drawer.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const doCopy = async (url: string) => {
    setOpen(false)
    if (await copyText(url)) {
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 2000)
    } else {
      onFail()
    }
  }

  return (
    <div ref={rootRef} className="relative inline-block" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="btn-ghost whitespace-nowrap px-3 py-1.5 text-xs"
        aria-haspopup={isAgent ? 'menu' : undefined}
        aria-expanded={isAgent ? open : undefined}
        aria-label={isAgent ? t('admin.invite.copyMenu') : undefined}
        onClick={() => (isAgent ? setOpen((v) => !v) : void doCopy(promoLinkUrl(link)))}
      >
        {copied ? t('admin.invite.copied') : t('admin.invite.copy')}
        {isAgent && !copied && <span aria-hidden> ▾</span>}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 w-40 rounded-xl border border-white/10 bg-[var(--surface-2)] p-1 shadow-xl"
        >
          <button
            type="button"
            role="menuitem"
            className="block w-full rounded-lg px-3 py-2 text-left text-xs text-neutral-200 hover:bg-white/5"
            onClick={() => void doCopy(inviteUrl(link.code))}
          >
            {t('admin.invite.copyInvite')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="block w-full rounded-lg px-3 py-2 text-left text-xs text-neutral-200 hover:bg-white/5"
            onClick={() => void doCopy(agentCompetitionUrl(link.code))}
          >
            {t('admin.invite.copyCompetition')}
          </button>
        </div>
      )}
    </div>
  )
}
