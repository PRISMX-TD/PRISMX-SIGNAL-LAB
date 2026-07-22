import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import AuroraBackground from "../components/AuroraBackground";
import { useAuth } from "../store/auth";
import { paymentApi, userApi } from "../api/client";
import { localizeApiError, fmtDate } from "../api/utils";
import type { TrialStatus } from "../api/types";

type Plan = { id: string; name: string; price_usd: number; original_price_usd?: number | null; days: number; tag?: string };
type SaleInfo = { percent: number; badge: string; end_at: string; monthly: number; yearly: number } | null;
type PaymentState =
  | { step: "select" }
  | { step: "pay"; paymentId: string; payAddress: string; payAmount: number; payCurrency: string; amountUsd: number; plan: string; validUntil: string | null }
  | { step: "processing" }
  | { step: "done" }
  // partialAmount：过期/失败时若已收到部分金额（>0），一并带出来在错误页
  // 提示用户"钱到了一部分"，而不是让人以为已转的钱凭空消失。
  // partialAmount: if a nonzero partial amount was received before the
  // payment expired/failed, carried along so the error screen can tell the
  // user "part of it arrived" instead of leaving them thinking it vanished.
  | { step: "error"; msg: string; partialAmount?: number; payCurrency?: string };

// 只接受 USDT，且仅保留低网络费的链（去掉最贵的 ERC-20 / Arbitrum）
// accept USDT only, keeping just the low-network-fee chains (dropped pricey ERC-20 / Arbitrum)
const USDT_NETWORKS: Array<{ code: string; label: string; note: string }> = [
  { code: "usdttrc20", label: "TRC-20", note: "Tron" },
  { code: "usdtbsc", label: "BEP-20", note: "BSC" },
  { code: "usdtsol", label: "Solana", note: "SOL" },
  { code: "usdtmatic", label: "Polygon", note: "MATIC" },
  { code: "usdtton", label: "TON", note: "Ton" },
];

const USDT_META: Record<string, { label: string; note: string }> = Object.fromEntries(
  USDT_NETWORKS.map((n) => [n.code, { label: n.label, note: n.note }]),
);

// 权益对比行（键指向 i18n）/ feature comparison rows (keys point to i18n)
const FEATURES: Array<{ key: string; free: string; pro: string }> = [
  { key: "featSignals", free: "featSignalsFree", pro: "featSignalsPro" },
  { key: "featWinrate", free: "featWinrateFree", pro: "featWinratePro" },
  { key: "featMt5", free: "featMt5Free", pro: "featMt5Pro" },
  { key: "featTrade", free: "featTradeFree", pro: "featTradePro" },
  { key: "featAuto", free: "featAutoFree", pro: "featAutoPro" },
  { key: "featPush", free: "featPushFree", pro: "featPushPro" },
  { key: "featSupport", free: "featSupportFree", pro: "featSupportPro" },
];

// CheckIcon / DashIcon 内联图标 / inline icons
function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

// 未完成支付的本地持久化：用户扫码转账后切走/刷新/锁屏太久回来，页面状态
// 全在内存里会直接丢回选套餐页——此时 USDT 可能已经转出去了，界面却像是
// 要重新下单。存一份到 localStorage，挂载时用它先恢复界面，再用真实状态核实。
// Persist an in-flight payment locally: if the user navigates away, refreshes,
// or their phone locks mid-scan, in-memory-only state would drop them back to
// plan selection — even though the USDT may already be on its way. Cache it in
// localStorage so the page can restore on mount, then verify against the
// server's actual status.
const PENDING_PAYMENT_KEY = "prismx_pending_payment";
type PendingPayment = Extract<PaymentState, { step: "pay" }>;

function loadPendingPayment(): PendingPayment | null {
  try {
    const raw = localStorage.getItem(PENDING_PAYMENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingPayment>;
    if (parsed && parsed.step === "pay" && typeof parsed.paymentId === "string") {
      return parsed as PendingPayment;
    }
    return null;
  } catch {
    return null;
  }
}

function savePendingPayment(s: PendingPayment) {
  try {
    localStorage.setItem(PENDING_PAYMENT_KEY, JSON.stringify(s));
  } catch { /* ignore */ }
}

function clearPendingPayment() {
  try {
    localStorage.removeItem(PENDING_PAYMENT_KEY);
  } catch { /* ignore */ }
}

export default function UpgradePage() {
  const { t } = useTranslation();
  const { user, refreshUser } = useAuth();

  const [plans, setPlans] = useState<Plan[]>([]);
  const [sale, setSale] = useState<SaleInfo>(null);
  const [currencies, setCurrencies] = useState<string[]>([]);
  const [chosenPlan, setChosenPlan] = useState<string>("pro_monthly");
  const [chosenCoin, setChosenCoin] = useState<string>("usdttrc20");
  const [state, setState] = useState<PaymentState>({ step: "select" });
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  // 支付窗口仍开着时，NOWPayments 已确认收到的部分金额（低于应付金额即为
  // 少转）；null = 还没有数据。用于在倒计时期间就提示"钱到了一部分"。
  // Amount NOWPayments has confirmed receiving while the payment window is
  // still open (less than the full amount means an under-send); null = no
  // data yet. Powers the "partial amount received" notice during the countdown.
  const [actuallyPaid, setActuallyPaid] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clockRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 免费试用状态：独立请求 + 独立 catch，失败只当"不可用"处理，绝不能因为
  // 这一个次要请求失败就拖垮套餐/支付区的渲染（2026-07-16 账户页的部署时序
  // 教训——见产品需求文档 6.17 节"上线注意"）。
  // Free-trial status: its own request with its own catch — a failure here
  // only means "treat as unavailable", it must never take down the plans/
  // payment area's rendering (the 2026-07-16 Account-page deploy-timing
  // lesson, see the product spec's 6.17 "上线注意").
  const [trialStatus, setTrialStatus] = useState<TrialStatus | null>(null);
  const [claimingTrial, setClaimingTrial] = useState(false);
  const [trialClaimError, setTrialClaimError] = useState<string | null>(null);
  const [trialClaimedUntil, setTrialClaimedUntil] = useState<string | null>(null);
  // 试用中提示要展示到期日期，AccountPage 同样是直接调 userApi.me() 取
  // planExpiresAt（该字段不在全局 user store 里），此处照抄同一模式而不是
  // 为了这一个日期扩大全局状态。/ The trial-active notice needs the expiry
  // date; AccountPage sources it the same way (planExpiresAt isn't in the
  // global user store) — mirrored here rather than growing global state for
  // one date field.
  const [planExpiresAt, setPlanExpiresAt] = useState<string | null>(null);

  useEffect(() => {
    document.title = t("upgrade.title");
    paymentApi.getPlans().then((r) => {
      setPlans(r.plans);
      setSale(r.sale ?? null);
    }).catch(() => {});
    paymentApi.getCurrencies().then((r) => {
      const usdtOnly = USDT_NETWORKS.filter((n) => r.currencies.some((c) => c.toLowerCase() === n.code));
      const available = usdtOnly.length ? usdtOnly.map((n) => n.code) : USDT_NETWORKS.map((n) => n.code);
      setCurrencies(available);
      const preferred = available.find((c) => c.toLowerCase() === "usdttrc20");
      if (preferred) setChosenCoin(preferred);
      else if (available.length) setChosenCoin(available[0]);
    }).catch(() => {});
    paymentApi.getTrial().then(setTrialStatus).catch(() => setTrialStatus(null));
    userApi.me().then((r) => setPlanExpiresAt(r.planExpiresAt)).catch(() => {});
  }, [t]);

  const handleClaimTrial = useCallback(async () => {
    setClaimingTrial(true);
    setTrialClaimError(null);
    try {
      const res = await paymentApi.claimTrial();
      setTrialClaimedUntil(res.planExpiresAt);
      setPlanExpiresAt(res.planExpiresAt);
      await refreshUser();
    } catch (e: unknown) {
      const msg = e instanceof Error ? localizeApiError(e.message) : "Unknown error";
      setTrialClaimError(msg);
    } finally {
      setClaimingTrial(false);
    }
  }, [refreshUser]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (clockRef.current) clearInterval(clockRef.current);
    };
  }, []);

  const selectedPlan = plans.find((p) => p.id === chosenPlan);

  const startCountdown = useCallback((validUntil: string | null) => {
    if (clockRef.current) clearInterval(clockRef.current);
    if (!validUntil) { setRemaining(null); return; }
    const deadline = new Date(validUntil).getTime();
    const tick = () => {
      const secs = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      setRemaining(secs);
      if (secs <= 0 && clockRef.current) clearInterval(clockRef.current);
    };
    tick();
    clockRef.current = setInterval(tick, 1000);
  }, []);

  // 轮询单笔支付状态直到终态；抽成独立函数供 handlePay 与挂载恢复共用。
  // Poll one payment's status to a terminal state; shared by handlePay and the
  // mount-time recovery effect below.
  const pollPayment = useCallback((paymentId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const s = await paymentApi.status(paymentId);
        if (s.status === "FINISHED") {
          if (pollRef.current) clearInterval(pollRef.current);
          if (clockRef.current) clearInterval(clockRef.current);
          clearPendingPayment();
          setState({ step: "done" });
          // 立即刷新本地 user.plan：之前用一个没人监听的自定义事件通知全局
          // 刷新，付款成功后仪表盘/导航仍显示 FREE，需要用户手动切页才会更新。
          // Refresh the cached user.plan right away — this used to dispatch a
          // custom event nobody listened for, so the dashboard/nav kept
          // showing FREE right after a successful payment until the user
          // navigated to a page that happened to refetch it.
          void refreshUser();
        } else if (s.status === "EXPIRED" || s.status === "FAILED") {
          if (pollRef.current) clearInterval(pollRef.current);
          if (clockRef.current) clearInterval(clockRef.current);
          clearPendingPayment();
          setState({
            step: "error",
            msg: t("upgrade.paymentExpired"),
            partialAmount: s.actually_paid ?? undefined,
            payCurrency: s.pay_currency,
          });
        } else {
          // 仍在处理中：同步已到账的部分金额，供支付页在倒计时期间提示。
          // Still processing: sync the partial amount received so far, shown
          // on the pay screen during the countdown.
          setActuallyPaid(s.actually_paid ?? null);
        }
      } catch { /* silently skip poll errors */ }
    }, 5000);
  }, [t, refreshUser]);

  // 恢复未完成的支付：挂载时若本地存着一笔未完成的支付，先用它乐观恢复
  // 支付页（不让用户以为要重新下单），再向后端核实真实状态。
  // Recover an in-flight payment on mount: optimistically restore the pay
  // screen from the local cache (so the user doesn't think they must start
  // over), then confirm the real status with the backend.
  useEffect(() => {
    const pending = loadPendingPayment();
    if (!pending) return;
    let cancelled = false;
    setState(pending);
    startCountdown(pending.validUntil);
    paymentApi.status(pending.paymentId).then((s) => {
      if (cancelled) return;
      if (s.status === "FINISHED") {
        clearPendingPayment();
        setState({ step: "done" });
        void refreshUser();
      } else if (s.status === "EXPIRED" || s.status === "FAILED") {
        clearPendingPayment();
        setState({
          step: "error",
          msg: t("upgrade.paymentExpired"),
          partialAmount: s.actually_paid ?? undefined,
          payCurrency: s.pay_currency,
        });
      } else {
        setActuallyPaid(s.actually_paid ?? null);
        pollPayment(pending.paymentId);
      }
    }).catch(() => {
      // 查询失败（网络问题）：保留乐观恢复的支付页，轮询会继续重试确认。
      // Status check failed (network): keep the optimistically-restored pay
      // screen; polling keeps retrying to confirm.
      if (!cancelled) pollPayment(pending.paymentId);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount only
  }, []);

  const handlePay = useCallback(async () => {
    setLoading(true);
    setActuallyPaid(null);
    try {
      const res = await paymentApi.create(chosenPlan, chosenCoin);
      const payState: PendingPayment = {
        step: "pay",
        paymentId: res.payment_id,
        payAddress: res.pay_address,
        payAmount: res.pay_amount,
        payCurrency: res.pay_currency,
        amountUsd: res.amount_usd,
        plan: res.plan,
        validUntil: res.valid_until,
      };
      setState(payState);
      savePendingPayment(payState);
      startCountdown(res.valid_until);
      pollPayment(res.payment_id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? localizeApiError(e.message) : "Unknown error";
      setState({ step: "error", msg });
    } finally {
      setLoading(false);
    }
  }, [chosenPlan, chosenCoin, startCountdown, pollPayment]);

  const handleRetry = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (clockRef.current) clearInterval(clockRef.current);
    clearPendingPayment();
    setRemaining(null);
    setActuallyPaid(null);
    setState({ step: "select" });
  };

  const copyAddress = (addr: string) => {
    navigator.clipboard.writeText(addr).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const fmtCountdown = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <AuroraBackground />
      <div className="relative mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        {state.step === "select" && renderSelect()}
        {state.step === "pay" && renderPay()}
        {state.step === "done" && renderDone()}
        {state.step === "error" && renderError()}
      </div>
    </div>
  );

  function renderSelect() {
    const isPro = user?.plan === "PRO";
    // 试用中的用户 plan 也是 "PRO"（等级判断全部复用既有权益逻辑），但他们
    // 不是"已经付费"——支付区必须继续对他们展示（他们是最该被转化的人），
    // 只有真正付费/管理员赠送的 PRO 才隐藏支付区、显示"已是 PRO"。
    // A trialing user's plan is also "PRO" (all entitlement checks are reused
    // as-is), but they haven't paid — the payment area must stay visible for
    // them (they're the prime conversion target). Only a genuinely paid or
    // admin-granted PRO hides the payment area and shows "already PRO".
    const isPaidPro = isPro && !user?.planIsTrial;
    const monthly = plans.find((p) => p.days === 30);
    const yearly = plans.find((p) => p.days === 365);
    // 年付折扣角标此前写死 "-20%"，不管后台把价格改成多少都不变。改成按
    // 月付价格 ×12 与年付价格的真实差算出百分比，后台改价立刻联动。
    // The yearly-discount badge used to be hardcoded "-20%" regardless of
    // whatever price the admin actually set. Compute the real percentage
    // from monthly price × 12 vs. the yearly price so it stays in sync with
    // whatever the admin configures.
    const yearlyDiscountPct =
      monthly && yearly && monthly.price_usd > 0
        ? Math.round((1 - yearly.price_usd / (monthly.price_usd * 12)) * 100)
        : null;
    return (
      <div className="animate-fade-in-up">
        {/* 标题 / hero header */}
        <div className="mx-auto max-w-2xl text-center">
          <span className="chip mx-auto animate-glow-pulse">
            <span className="h-1.5 w-1.5 rounded-full bg-prism-400 animate-breathe" />
            PRO
          </span>
          <h1 className="mt-6 font-display text-4xl font-black leading-tight tracking-tight text-slate-50 sm:text-5xl">
            {t("upgrade.title")}
          </h1>
          <p className="mx-auto mt-4 max-w-lg text-base leading-relaxed text-slate-400">
            {t("upgrade.subtitle")}
          </p>
        </div>

        {/* 促销横幅 / sale banner */}
        {sale?.badge && (
          <div className="glass mx-auto mt-8 max-w-md px-5 py-3 text-center">
            <span className="font-display text-lg font-bold text-prism-300">{sale.badge} · {sale.percent}% OFF</span>
            {sale.end_at && <div className="mt-0.5 text-xs text-slate-500">{t("upgrade.saleEnds")}: {sale.end_at.slice(0, 10)}</div>}
          </div>
        )}

        {/* 计费周期切换 / billing cycle toggle */}
        <div className="mt-10 flex justify-center">
          <div className="seg">
            <button className={chosenPlan === "pro_monthly" ? "on" : ""} onClick={() => setChosenPlan("pro_monthly")}>
              {t("upgrade.monthly")}
            </button>
            <button className={chosenPlan === "pro_yearly" ? "on" : ""} onClick={() => setChosenPlan("pro_yearly")}>
              {t("upgrade.yearly")}
              {!sale && yearlyDiscountPct != null && yearlyDiscountPct > 0 && (
                <span className="ml-1.5 text-[10px] font-bold text-prism-300">-{yearlyDiscountPct}%</span>
              )}
            </button>
          </div>
        </div>

        {/* 免费试用横幅：仅当后台开放且该用户从未用过时展示 / free-trial banner,
            shown only while the admin switch is on and this user hasn't claimed yet */}
        {trialStatus?.eligible && !trialClaimedUntil && (
          <div className="glass mx-auto mt-8 max-w-md p-6 text-center">
            <h3 className="font-display text-lg font-bold text-prism-200">{t("upgrade.trialTitle")}</h3>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">
              {t("upgrade.trialDesc", { n: trialStatus.days })}
            </p>
            {trialClaimError && (
              <p className="mt-3 text-xs text-down">{trialClaimError}</p>
            )}
            <button
              onClick={handleClaimTrial}
              disabled={claimingTrial}
              className="btn-primary mt-4 w-full py-2.5 disabled:opacity-60"
            >
              {claimingTrial ? (
                <span className="mx-auto h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              ) : (
                t("upgrade.trialCta")
              )}
            </button>
          </div>
        )}
        {trialClaimedUntil && (
          <div className="glass mx-auto mt-8 max-w-md p-6 text-center font-semibold text-up">
            {t("upgrade.trialStarted", { date: fmtDate(trialClaimedUntil) })}
          </div>
        )}

        {/* 双卡定价并排 / two pricing cards */}
        <div className="mx-auto mt-8 grid max-w-4xl grid-cols-1 gap-5 md:grid-cols-2">
          {/* FREE 卡 */}
          <div className="glass flex flex-col p-7">
            <div className="flex items-center justify-between">
              <span className="font-display text-lg font-bold text-slate-200">{t("upgrade.planFree")}</span>
              {!isPro && <span className="tag bg-white/5 text-slate-400 ring-1 ring-white/10">{t("upgrade.currentPlan")}</span>}
            </div>
            <div className="mt-4 h-[70px]">
              <div className="flex items-baseline gap-1">
                <span className="font-display text-5xl font-black text-slate-100">$0</span>
              </div>
              <p className="mt-1.5 text-sm text-slate-500">{t("upgrade.freeTagline")}</p>
            </div>
            <div className="my-5 h-px bg-white/10" />
            <ul className="flex flex-col gap-3">
              {FEATURES.map((f) => (
                <li key={f.key} className="flex items-start gap-3 text-sm">
                  <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-white/5 text-slate-600">
                    <span className="text-xs">·</span>
                  </span>
                  <span className="text-slate-400">
                    <span className="text-slate-300">{t(`upgrade.${f.key}`)}</span>
                    <span className="text-slate-500"> — {t(`upgrade.${f.free}`)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* PRO 卡（高亮）*/}
          <div className="glass-neon relative flex flex-col p-7 ring-1 ring-prism-500/40"
               style={{ boxShadow: "0 24px 60px rgba(0,0,0,0.55), 0 0 40px rgba(139,92,246,0.18)" }}>
            {/* 光晕 / glow orb */}
            <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-prism-600/25 blur-[90px]" />
            <div className="relative flex items-center justify-between">
              <span className="font-display text-lg font-bold text-prism-200">{t("upgrade.planPro")}</span>
              <span className="tag bg-prism-600/20 text-prism-200 ring-1 ring-prism-500/40">
                {isPro ? t("upgrade.currentPlan") : t("upgrade.mostPopular")}
              </span>
            </div>
            <div className="relative mt-4 h-[70px]">
              <div className="flex items-baseline gap-2">
                <span className="font-display text-5xl font-black text-white">${selectedPlan?.price_usd ?? monthly?.price_usd ?? "—"}</span>
                {selectedPlan?.original_price_usd != null && selectedPlan.original_price_usd !== selectedPlan.price_usd && (
                  <span className="font-display text-xl text-slate-500 line-through">${selectedPlan.original_price_usd}</span>
                )}
                <span className="text-sm text-slate-400">/ {chosenPlan === "pro_yearly" ? t("upgrade.yearly") : t("upgrade.monthly")}</span>
              </div>
              <p className="mt-1.5 text-sm text-prism-300">
                {chosenPlan === "pro_yearly" && yearly
                  ? t("upgrade.perMonth", { price: (yearly.price_usd / 12).toFixed(0) })
                  : t("upgrade.proTagline")}
              </p>
            </div>
            <div className="relative my-5 h-px bg-prism-500/20" />
            <ul className="relative flex flex-col gap-3">
              {FEATURES.map((f) => (
                <li key={f.key} className="flex items-start gap-3 text-sm">
                  <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full bg-prism-600/25 text-prism-300 ring-1 ring-prism-500/40">
                    <CheckIcon />
                  </span>
                  <span>
                    <span className="font-medium text-slate-100">{t(`upgrade.${f.key}`)}</span>
                    <span className="text-slate-400"> — {t(`upgrade.${f.pro}`)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* 支付区 / payment area */}
        {isPaidPro ? (
          <div className="glass mx-auto mt-10 max-w-md px-6 py-5 text-center font-semibold text-up">
            {t("upgrade.alreadyPro")}
          </div>
        ) : (
          <div className="glass-neon relative mx-auto mt-12 max-w-2xl overflow-hidden p-7 sm:p-8"
               style={{ boxShadow: "0 24px 60px rgba(0,0,0,0.5)" }}>
            <div className="pointer-events-none absolute -left-20 -bottom-20 h-52 w-52 rounded-full bg-prism-600/15 blur-[90px]" />

            {/* 试用中提示：订阅后付费时长从付款日起算，不叠加试用剩余天数
                (与后端 _sync_payment_status 的规则一致) / trial-active notice:
                subscribing now starts paid time from the payment date, not
                stacked on top of remaining trial days (matches the backend rule) */}
            {user?.planIsTrial && user?.plan === "PRO" && (
              <div className="relative mb-6 rounded-inner border border-amber-400/20 bg-amber-400/5 p-3.5 text-xs leading-relaxed text-amber-200/90">
                {t("upgrade.trialActiveNotice", { date: fmtDate(planExpiresAt) })}
              </div>
            )}

            {/* 步骤标题 / step label */}
            <div className="relative flex items-center gap-2.5">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-prism-600/25 text-xs font-bold text-prism-200 ring-1 ring-prism-500/40">1</span>
              <h3 className="text-sm font-bold text-slate-200">{t("upgrade.chooseCoin")}</h3>
            </div>

            {/* 币种网格 / coin grid */}
            <div className="relative mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {currencies.map((code) => {
                const meta = USDT_META[code] ?? { label: code.toUpperCase(), note: "" };
                const active = chosenCoin === code;
                const isTrc = code === "usdttrc20";
                return (
                  <button
                    key={code}
                    onClick={() => setChosenCoin(code)}
                    className={`relative flex flex-col items-start rounded-inner border p-3 text-left transition ${
                      active
                        ? "border-prism-500/70 bg-prism-600/10 ring-1 ring-prism-500/40"
                        : "border-line bg-black/20 hover:border-prism-500/40 hover:bg-white/5"
                    }`}
                  >
                    {active && (
                      <span className="absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded-full bg-prism-500 text-white">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-2.5 w-2.5"><path d="M20 6L9 17l-5-5" /></svg>
                      </span>
                    )}
                    <div className="flex items-center gap-1.5">
                      <span className="font-display text-sm font-bold text-slate-100">USDT</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${active ? "bg-prism-600/30 text-prism-200" : "bg-white/5 text-slate-400"}`}>{meta.label}</span>
                    </div>
                    <span className={`mt-1 text-[11px] ${isTrc ? "text-prism-300" : "text-slate-500"}`}>{isTrc ? t("upgrade.recommended") : meta.note}</span>
                  </button>
                );
              })}
            </div>

            {/* 分割线 / divider */}
            <div className="relative my-6 h-px bg-white/10" />

            {/* 总价行 / total row */}
            <div className="relative flex items-end justify-between">
              <div>
                <div className="text-xs font-medium uppercase tracking-wider text-slate-500">{t("upgrade.totalDue")}</div>
                <div className="mt-1 text-xs text-slate-500">
                  {chosenPlan === "pro_yearly" ? t("upgrade.yearly") : t("upgrade.monthly")} · USDT {USDT_META[chosenCoin]?.label ?? ""}
                </div>
              </div>
              <div className="text-right">
                <span className="font-display text-3xl font-black text-white">${selectedPlan?.price_usd ?? "—"}</span>
                <span className="ml-1 text-sm text-slate-400">USDT</span>
              </div>
            </div>

            {/* 主按钮 / CTA */}
            <button
              onClick={handlePay}
              disabled={loading || !selectedPlan}
              className="btn-primary relative mt-6 flex w-full items-center justify-center gap-2 py-3.5 text-base disabled:opacity-60"
            >
              {loading ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              ) : (
                t("upgrade.payButton", { price: selectedPlan ? `$${selectedPlan.price_usd}` : "" })
              )}
            </button>
            <p className="relative mt-4 flex items-center justify-center gap-1.5 text-center text-xs leading-relaxed text-slate-500">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5 flex-none"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
              {t("upgrade.secureNote")}
            </p>
          </div>
        )}
      </div>
    );
  }

  function renderPay() {
    if (state.step !== "pay") return null;
    const meta = USDT_META[state.payCurrency] ?? { label: state.payCurrency.toUpperCase(), note: "" };
    const expired = remaining !== null && remaining <= 0;
    return (
      <div className="mx-auto max-w-lg animate-fade-in-up">
        {/* 标题 / header */}
        <div className="text-center">
          <h1 className="font-display text-3xl font-black tracking-tight text-slate-50">{t("upgrade.payTitle")}</h1>
          <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-slate-400">{t("upgrade.payHint")}</p>
        </div>

        {/* 倒计时 / countdown */}
        {remaining !== null && (
          <div className="mt-6 flex justify-center">
            <div className={`inline-flex items-center gap-2.5 rounded-pill px-4 py-2 ring-1 ${expired ? "bg-down/10 ring-down/40" : "bg-amber-400/10 ring-amber-400/30"}`}>
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{t("upgrade.timeLeft")}</span>
              <span className={`font-mono text-lg font-bold ${expired ? "text-down" : "text-amber-300"}`}>
                {expired ? "0:00" : fmtCountdown(remaining)}
              </span>
            </div>
          </div>
        )}

        {expired ? (
          <div className="glass mt-6 p-8 text-center">
            <p className="text-sm leading-relaxed text-slate-400">{t("upgrade.expiredRetry")}</p>
            <button onClick={handleRetry} className="btn-primary mt-5 px-7 py-2.5">{t("upgrade.retry")}</button>
          </div>
        ) : (
          <>
            {/* 二维码卡 / QR card */}
            <div className="glass relative mt-6 overflow-hidden p-7 text-center">
              <div className="pointer-events-none absolute -right-16 -top-16 h-40 w-40 rounded-full bg-prism-600/20 blur-[80px]" />
              <div className="relative mx-auto flex h-52 w-52 items-center justify-center rounded-card bg-white p-4 shadow-glass-lg">
                <QRCodeSVG value={state.payAddress} size={176} level="M" />
              </div>
              <div className="relative mt-5 font-medium text-slate-100">{t("upgrade.scanToPay")}</div>
              <div className="relative mt-1 text-xs text-slate-500">{t("upgrade.orCopyManually")}</div>
            </div>

            {/* 金额卡 / amount card */}
            <div className="glass mt-4 p-6 text-center">
              <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">{t("upgrade.sendAmount")}</div>
              <div className="mt-2 break-all font-display text-3xl font-black text-white">{state.payAmount}</div>
              <div className="mt-3 inline-flex items-center gap-1.5 rounded-pill bg-prism-600/15 px-3 py-1 ring-1 ring-prism-500/30">
                <span className="text-sm font-bold text-slate-100">USDT</span>
                <span className="text-xs font-bold text-prism-300">{meta.label}</span>
              </div>
              <div className="mt-3 text-xs text-slate-500">≈ ${state.amountUsd} USD</div>
              <div className="mt-2.5 text-xs leading-relaxed text-amber-300/90">{t("upgrade.amountExact")}</div>
            </div>

            {/* 部分到账提示：转账已收到一部分但不够，还没到终态（过期/失败），
                钱不是凭空消失，补上差额即可完成。/ Partial-payment notice: some
                funds arrived but not enough, still not terminal (expired/
                failed) — the funds aren't lost, sending the remainder finishes it. */}
            {actuallyPaid != null && actuallyPaid > 0 && actuallyPaid < state.payAmount && (
              <div className="glass mt-4 border border-amber-400/30 bg-amber-400/5 p-4 text-center">
                <p className="text-sm font-semibold text-amber-200">
                  {t("upgrade.partialPaymentNotice", {
                    paid: actuallyPaid,
                    remaining: (state.payAmount - actuallyPaid).toFixed(6).replace(/0+$/, "").replace(/\.$/, ""),
                  })}
                </p>
              </div>
            )}

            {/* 地址卡 / address card */}
            <div className="glass mt-4 p-6">
              <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">
                {t("upgrade.sendTo")} · <span className="text-prism-300">{meta.label}</span>
              </div>
              <div className="mt-3 break-all rounded-inner border border-line bg-black/20 p-3.5 font-mono text-sm leading-relaxed text-slate-200">
                {state.payAddress}
              </div>
              <button onClick={() => copyAddress(state.payAddress)} className="btn-ghost mt-3.5 w-full py-2.5">
                {copied ? t("upgrade.copied") : t("common.copy")}
              </button>
            </div>

            {/* 截图提示 / screenshot tip */}
            <div className="mt-4 flex items-start gap-2.5 rounded-inner border border-sky-400/20 bg-sky-400/5 p-3.5">
              <span className="text-base leading-tight">📸</span>
              <span className="text-xs leading-relaxed text-slate-400">{t("upgrade.screenshotTip")}</span>
            </div>

            {/* 轮询提示 / polling hint */}
            <div className="mt-6 flex items-center justify-center gap-2.5 text-sm text-slate-400">
              <span className="h-2 w-2 rounded-full bg-amber-400 shadow-[0_0_8px_theme(colors.amber.400)] animate-breathe" />
              {t("upgrade.pollingHint")}
            </div>

            <div className="mt-5 text-center">
              <button onClick={handleRetry} className="btn-ghost px-6 py-2">{t("common.cancel")}</button>
            </div>
          </>
        )}
      </div>
    );
  }

  function renderDone() {
    return (
      <div className="mx-auto max-w-md animate-fade-in-up py-16 text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-up/10 text-up ring-1 ring-up/40">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="h-9 w-9">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        </div>
        <h1 className="mt-6 font-display text-2xl font-black text-slate-50">{t("upgrade.successTitle")}</h1>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-slate-400">{t("upgrade.successDesc")}</p>
        <button onClick={() => { window.location.href = "/dashboard"; }} className="btn-primary mt-7 px-8 py-3">
          {t("upgrade.goDashboard")}
        </button>
      </div>
    );
  }

  function renderError() {
    if (state.step !== "error") return null;
    // 有部分到账金额时改用专门的提示：告知用户钱已经到了一部分、没有消失，
    // 应联系客服处理，而不是让"重试"看起来像是要重新掏一遍全款。
    // With a nonzero partial amount, swap in a dedicated notice: tell the
    // user part of the funds arrived and weren't lost, and to contact
    // support — instead of letting "retry" read as "pay the full amount again".
    const hasPartial = state.partialAmount != null && state.partialAmount > 0;
    return (
      <div className="mx-auto max-w-md animate-fade-in-up py-16 text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-down/10 text-down ring-1 ring-down/40">
          <span className="font-display text-4xl">!</span>
        </div>
        <h1 className="mt-6 font-display text-2xl font-black text-slate-50">{t("upgrade.errorTitle")}</h1>
        <p className="mx-auto mt-3 max-w-sm break-words text-sm leading-relaxed text-slate-400">{state.msg}</p>
        {hasPartial && (
          <div className="glass mx-auto mt-5 max-w-sm border border-amber-400/30 bg-amber-400/5 p-4 text-left">
            <p className="text-sm leading-relaxed text-amber-200">
              {t("upgrade.partialPaymentExpiredNotice", {
                paid: state.partialAmount,
                currency: (USDT_META[state.payCurrency ?? ""] ?? { label: (state.payCurrency ?? "").toUpperCase() }).label,
              })}
            </p>
          </div>
        )}
        <button onClick={handleRetry} className="btn-primary mt-7 px-8 py-3">{t("upgrade.retry")}</button>
      </div>
    );
  }
}
