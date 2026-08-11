// 推送链路诊断面板。折叠式，默认收起，放在账户页通知区块内。
//
// 存在理由：推送链路横跨浏览器能力、Service Worker、权限、订阅、后端上报、
// 实际派发六个环节，任一环断掉的表现都是同一个"收不到通知"。而其中若干环节
// 只在真机上、特别是只在 iOS 以独立模式启动时才成立，桌面调试器覆盖不到。
// 这个面板让任何一台手机打开就能看出断在哪一环。
//
// Push pipeline diagnostics panel — collapsible, collapsed by default, inside
// the account page's notification section.
//
// Why it exists: the pipeline spans six links (browser capability, service
// worker, permission, subscription, backend reporting, actual dispatch) and a
// break in any of them looks identical — "no notifications". Several links only
// hold on a real device, and on iOS only when launched standalone, which a
// desktop debugger can't reach. This panel makes the broken link visible from
// any phone.
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { pushApi } from "../api/client"
import { getPushDiag, type PushDiagStep } from "../utils/pushDiag"
import { detectPushEnv, isStandalone } from "../utils/pushEnv"

type Probe = { label: string; value: string; ok: boolean | null }

// 探测结果的三态：ok / 不 ok / 无法检测。无法检测与"否"必须分开——前者说明探测
// 本身出了问题，后者是确定的结论，排查方向不同。
// Three states: ok / not ok / undetectable. "Undetectable" must stay distinct
// from "no": the former means the probe itself failed, the latter is a definite
// finding, and they lead somewhere different.
export default function PushDiagnostics() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [probes, setProbes] = useState<Probe[]>([])
  // null 表示"还没测出结果"，与"测出来是从未收到过"区分开——超时兜底逻辑依赖这个区分。
  // null means "no result yet", distinct from "measured, never received" — the
  // timeout fallback relies on telling those apart.
  const [lastPush, setLastPush] = useState<string | null>(null)
  const [testMsg, setTestMsg] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true

    const run = async () => {
      const out: Probe[] = []
      const yes = t("account.notifDiagYes")
      const no = t("account.notifDiagNo")
      const unknown = t("account.notifDiagUnknown")

      // 每项独立 try/catch：一项探测失败不影响其余项。
      // Each probe is independently guarded so one failure doesn't hide the rest.
      try {
        out.push({ label: t("account.notifDiagEnv"), value: detectPushEnv(), ok: null })
      } catch {
        out.push({ label: t("account.notifDiagEnv"), value: unknown, ok: null })
      }

      try {
        const sa = isStandalone()
        out.push({ label: t("account.notifDiagStandalone"), value: sa ? yes : no, ok: sa })
      } catch {
        out.push({ label: t("account.notifDiagStandalone"), value: unknown, ok: null })
      }

      let endpoint: string | undefined
      try {
        const reg = await navigator.serviceWorker?.getRegistration()
        const active = !!reg?.active
        out.push({ label: t("account.notifDiagSw"), value: active ? yes : no, ok: active })
        try {
          const sub = await reg?.pushManager?.getSubscription()
          endpoint = sub?.endpoint
          out.push({
            label: t("account.notifDiagSubscription"),
            value: sub ? yes : no,
            ok: !!sub,
          })
        } catch {
          out.push({ label: t("account.notifDiagSubscription"), value: unknown, ok: null })
        }
      } catch {
        out.push({ label: t("account.notifDiagSw"), value: unknown, ok: null })
        out.push({ label: t("account.notifDiagSubscription"), value: unknown, ok: null })
      }

      try {
        const perm = typeof Notification !== "undefined" ? Notification.permission : "unavailable"
        out.push({
          label: t("account.notifDiagPermission"),
          value: perm,
          ok: perm === "granted",
        })
      } catch {
        out.push({ label: t("account.notifDiagPermission"), value: unknown, ok: null })
      }

      try {
        const st = await pushApi.getStatus(endpoint)
        out.push({
          label: t("account.notifDiagBackend"),
          value: `${st.current_endpoint_registered ? yes : no} (${st.count})`,
          ok: st.current_endpoint_registered,
        })
      } catch {
        out.push({ label: t("account.notifDiagBackend"), value: unknown, ok: null })
      }

      // 诊断记录里的失败项逐条列出。
      // List each recorded failure.
      try {
        for (const [step, entry] of getPushDiag()) {
          if (!entry.ok) {
            out.push({ label: step as PushDiagStep, value: entry.error ?? unknown, ok: false })
          }
        }
      } catch {
        // 忽略：诊断记录读取失败不该让面板失效。
        // Ignored: a failed diagnostics read must not break the panel.
      }

      if (alive) setProbes(out)
    }

    void run()

    // 向 SW 查询最后一次收到推送的时间（已有的 PING_PUSH_HEARTBEAT 机制）。
    // Ask the SW for the last push timestamp via the existing heartbeat channel.
    // controller 为 null 说明当前页面没有被任何 SW 接管——这正是本次故障的形态，
    // 也是面板最需要说清楚的情况。此时不能只是不回消息（那会让这一行永远空白），
    // 必须显式落到"无法检测"。
    // A null controller means no SW controls this page — exactly the failure this
    // panel exists to expose. Leaving the message unsent would leave the row
    // blank forever, so fall through to "cannot detect" explicitly.
    const ctrl = navigator.serviceWorker?.controller
    if (!ctrl) {
      setLastPush(t("account.notifDiagUnknown"))
    } else {
      try {
        const ch = new MessageChannel()
        ch.port1.onmessage = (ev) => {
          if (!alive) return
          const ts = ev.data?.lastPushAt
          setLastPush(ts ? new Date(ts).toLocaleString() : t("account.notifDiagNever"))
        }
        ctrl.postMessage({ type: "PING_PUSH_HEARTBEAT" }, [ch.port2])
        // SW 存在但不回消息也有可能（版本不匹配、消息处理器异常）。给一个超时，
        // 避免这一行无限停在初始状态。
        // An SW can exist yet never reply (version mismatch, handler error).
        // Time out so the row doesn't hang on its initial value.
        window.setTimeout(() => {
          if (alive) setLastPush((prev) => prev ?? t("account.notifDiagUnknown"))
        }, 1500)
      } catch {
        setLastPush(t("account.notifDiagUnknown"))
      }
    }

    return () => {
      alive = false
    }
  }, [open, t])

  const sendTest = async () => {
    setTesting(true)
    setTestMsg(null)
    try {
      const r = await pushApi.sendTest()
      if (r.sent === 0 && r.failed === 0) {
        setTestMsg(t("account.notifDiagSendTestNone"))
      } else if (r.failed > 0) {
        setTestMsg(t("account.notifDiagSendTestFail", { failed: r.failed }))
      } else {
        setTestMsg(t("account.notifDiagSendTestOk", { count: r.sent }))
      }
    } catch (err) {
      setTestMsg(err instanceof Error ? err.message : t("account.notifDiagUnknown"))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-xs font-semibold text-neutral-300 hover:text-white"
      >
        <span>{t("account.notifDiagTitle")}</span>
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-1.5">
          {probes.map((p, i) => (
            <div key={`${p.label}-${i}`} className="flex items-start justify-between gap-3 text-xs">
              <span className="text-neutral-400">{p.label}</span>
              <span
                className={
                  p.ok === null
                    ? "text-neutral-300"
                    : p.ok
                      ? "text-emerald-400"
                      : "text-amber-400"
                }
              >
                {p.value}
              </span>
            </div>
          ))}

          <div className="flex items-start justify-between gap-3 text-xs">
            <span className="text-neutral-400">{t("account.notifDiagLastPush")}</span>
            <span className="text-neutral-300">{lastPush || "…"}</span>
          </div>

          <button
            type="button"
            onClick={sendTest}
            disabled={testing}
            className="mt-3 w-full rounded-lg bg-prism-500/20 px-3 py-2 text-xs font-semibold text-prism-200 transition hover:bg-prism-500/30 disabled:opacity-50"
          >
            {t("account.notifDiagSendTest")}
          </button>
          {testMsg && <p className="mt-2 text-xs leading-relaxed text-neutral-300">{testMsg}</p>}
        </div>
      )}
    </div>
  )
}
