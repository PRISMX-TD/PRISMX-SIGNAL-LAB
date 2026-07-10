import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import AuroraBackground from "../components/AuroraBackground";
import { useAuth } from "../store/auth";
import { paymentApi } from "../api/client";

type Plan = { id: string; name: string; price_usd: number; original_price_usd?: number | null; days: number; tag?: string };
type SaleInfo = { percent: number; badge: string; end_at: string; monthly: number; yearly: number } | null;
type PaymentState =
  | { step: "select" }
  | { step: "pay"; paymentId: string; payAddress: string; payAmount: number; payCurrency: string; amountUsd: number; plan: string; validUntil: string | null }
  | { step: "processing" }
  | { step: "done" }
  | { step: "error"; msg: string };

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

export default function UpgradePage() {
  const { t } = useTranslation();
  const { user } = useAuth();

  const [plans, setPlans] = useState<Plan[]>([]);
  const [sale, setSale] = useState<SaleInfo>(null);
  const [currencies, setCurrencies] = useState<string[]>([]);
  const [chosenPlan, setChosenPlan] = useState<string>("pro_monthly");
  const [chosenCoin, setChosenCoin] = useState<string>("usdttrc20");
  const [state, setState] = useState<PaymentState>({ step: "select" });
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clockRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
  }, [t]);

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

  const handlePay = useCallback(async () => {
    setLoading(true);
    try {
      const res = await paymentApi.create(chosenPlan, chosenCoin);
      setState({
        step: "pay",
        paymentId: res.payment_id,
        payAddress: res.pay_address,
        payAmount: res.pay_amount,
        payCurrency: res.pay_currency,
        amountUsd: res.amount_usd,
        plan: res.plan,
        validUntil: res.valid_until,
      });
      startCountdown(res.valid_until);
      const pid = res.payment_id;
      pollRef.current = setInterval(async () => {
        try {
          const s = await paymentApi.status(pid);
          if (s.status === "FINISHED") {
            if (pollRef.current) clearInterval(pollRef.current);
            if (clockRef.current) clearInterval(clockRef.current);
            setState({ step: "done" });
            window.dispatchEvent(new Event("auth-refresh"));
          } else if (s.status === "EXPIRED" || s.status === "FAILED") {
            if (pollRef.current) clearInterval(pollRef.current);
            if (clockRef.current) clearInterval(clockRef.current);
            setState({ step: "error", msg: t("upgrade.paymentExpired") });
          }
        } catch { /* silently skip poll errors */ }
      }, 5000);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setState({ step: "error", msg });
    } finally {
      setLoading(false);
    }
  }, [chosenPlan, chosenCoin, t, startCountdown]);

  const handleRetry = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (clockRef.current) clearInterval(clockRef.current);
    setRemaining(null);
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
      <div className="relative mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
        {state.step === "select" && renderSelect()}
        {state.step === "pay" && renderPay()}
        {state.step === "done" && renderDone()}
        {state.step === "error" && renderError()}
      </div>
    </div>
  );

  function renderSelect() {
    const isPro = user?.plan === "PRO";
    const monthly = plans.find((p) => p.days === 30);
    const yearly = plans.find((p) => p.days === 365);
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
              {yearly && !sale && <span className="ml-1.5 text-[10px] font-bold text-prism-300">-20%</span>}
            </button>
          </div>
        </div>

        {/* 双卡定价并排 / two pricing cards */}
        <div className="mx-auto mt-8 grid max-w-4xl grid-cols-1 gap-5 md:grid-cols-2">
          {/* FREE 卡 */}
          <div className="glass flex flex-col p-7">
            <div className="flex items-center justify-between">
              <span className="font-display text-lg font-bold text-slate-200">{t("upgrade.planFree")}</span>
              {!isPro && <span className="tag bg-white/5 text-slate-400 ring-1 ring-white/10">{t("upgrade.currentPlan")}</span>}
            </div>
            <div className="mt-4 flex items-baseline gap-1">
              <span className="font-display text-4xl font-black text-slate-100">$0</span>
            </div>
            <p className="mt-1 text-sm text-slate-500">{t("upgrade.freeTagline")}</p>
            <div className="my-6 h-px bg-white/10" />
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
            <div className="relative mt-4 flex items-baseline gap-2">
              <span className="font-display text-5xl font-black text-white">${selectedPlan?.price_usd ?? monthly?.price_usd ?? "—"}</span>
              {selectedPlan?.original_price_usd != null && selectedPlan.original_price_usd !== selectedPlan.price_usd && (
                <span className="font-display text-xl text-slate-500 line-through">${selectedPlan.original_price_usd}</span>
              )}
              <span className="text-sm text-slate-400">/ {chosenPlan === "pro_yearly" ? t("upgrade.yearly") : t("upgrade.monthly")}</span>
            </div>
            {chosenPlan === "pro_yearly" && yearly && (
              <p className="relative mt-1 text-sm text-prism-300">{t("upgrade.perMonth", { price: (yearly.price_usd / 12).toFixed(0) })}</p>
            )}
            <div className="relative my-6 h-px bg-prism-500/20" />
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
        {isPro ? (
          <div className="glass mx-auto mt-10 max-w-md px-6 py-5 text-center font-semibold text-up">
            {t("upgrade.alreadyPro")}
          </div>
        ) : (
          <div className="mx-auto mt-12 max-w-2xl">
            <h3 className="mb-4 text-center text-xs font-bold uppercase tracking-[0.15em] text-slate-500">{t("upgrade.chooseCoin")}</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {currencies.map((code) => {
                const meta = USDT_META[code] ?? { label: code.toUpperCase(), note: "" };
                const active = chosenCoin === code;
                const isTrc = code === "usdttrc20";
                return (
                  <button
                    key={code}
                    onClick={() => setChosenCoin(code)}
                    className={`glass flex flex-col items-start p-3.5 text-left transition ${active ? "ring-2 ring-prism-500/60" : "hover:border-prism-500/30"}`}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="font-display text-sm font-bold text-slate-100">USDT</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${active ? "bg-prism-600/25 text-prism-200" : "bg-white/5 text-slate-400"}`}>{meta.label}</span>
                    </div>
                    <span className="mt-1 text-[11px] text-slate-500">{isTrc ? t("upgrade.recommended") : meta.note}</span>
                  </button>
                );
              })}
            </div>

            <button
              onClick={handlePay}
              disabled={loading || !selectedPlan}
              className="btn-primary mt-7 w-full py-3.5 text-base"
            >
              {loading ? "…" : t("upgrade.payButton", { price: selectedPlan ? `$${selectedPlan.price_usd}` : "" })}
            </button>
            <p className="mt-4 text-center text-xs leading-relaxed text-slate-500">{t("upgrade.secureNote")}</p>
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

            {/* 地址卡 / address card */}
            <div className="glass mt-4 p-6">
              <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">{t("upgrade.sendTo")} · {meta.label}</div>
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
    return (
      <div className="mx-auto max-w-md animate-fade-in-up py-16 text-center">
        <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-down/10 text-down ring-1 ring-down/40">
          <span className="font-display text-4xl">!</span>
        </div>
        <h1 className="mt-6 font-display text-2xl font-black text-slate-50">{t("upgrade.errorTitle")}</h1>
        <p className="mx-auto mt-3 max-w-sm break-words text-sm leading-relaxed text-slate-400">{state.msg}</p>
        <button onClick={handleRetry} className="btn-primary mt-7 px-8 py-3">{t("upgrade.retry")}</button>
      </div>
    );
  }
}
