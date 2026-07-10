import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../store/auth";
import { paymentApi } from "../api/client";

type Plan = { id: string; name: string; price_usd: number; original_price_usd?: number | null; days: number; tag?: string };
type SaleInfo = { percent: number; badge: string; end_at: string; monthly: number; yearly: number } | null;
type PaymentState =
  | { step: "select" }
  | { step: "pay"; paymentId: string; payAddress: string; payAmount: number; payCurrency: string; amountUsd: number; plan: string }
  | { step: "processing" }
  | { step: "done" }
  | { step: "error"; msg: string };

// 只接受 USDT，按手续费/速度优先排序展示不同链 / accept USDT only, networks ordered by fee & speed
const USDT_NETWORKS: Array<{ code: string; label: string; note: string }> = [
  { code: "usdttrc20", label: "TRC-20", note: "Tron" },
  { code: "usdterc20", label: "ERC-20", note: "Ethereum" },
  { code: "usdtbsc", label: "BEP-20", note: "BSC" },
  { code: "usdtsol", label: "Solana", note: "SOL" },
  { code: "usdtmatic", label: "Polygon", note: "MATIC" },
  { code: "usdtarb", label: "Arbitrum", note: "ARB" },
  { code: "usdtton", label: "TON", note: "Ton" },
];

const USDT_META: Record<string, { label: string; note: string }> = Object.fromEntries(
  USDT_NETWORKS.map((n) => [n.code, { label: n.label, note: n.note }]),
);

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
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 加载套餐和可用币种列表 / load plans and coin list
  useEffect(() => {
    document.title = t("upgrade.title");
    paymentApi.getPlans().then((r) => {
      setPlans(r.plans);
      setSale(r.sale ?? null);
    }).catch(() => {});
    paymentApi.getCurrencies().then((r) => {
      // 只接受 USDT（多链），按偏好顺序过滤 / accept USDT only (multi-chain), filtered by preference
      const usdtOnly = USDT_NETWORKS.filter((n) => r.currencies.some((c) => c.toLowerCase() === n.code));
      const available = usdtOnly.length ? usdtOnly.map((n) => n.code) : r.currencies.filter((c) => c.toLowerCase().startsWith("usdt"));
      setCurrencies(available);
      const preferred = available.find((c) => c.toLowerCase() === "usdttrc20");
      if (preferred) setChosenCoin(preferred);
      else if (available.length) setChosenCoin(available[0]);
    }).catch(() => {});
  }, [t]);

  // 清理轮询 / cleanup polling
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const selectedPlan = plans.find((p) => p.id === chosenPlan);

  // 发起支付 / create payment
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
      });
      const pid = res.payment_id;
      pollRef.current = setInterval(async () => {
        try {
          const s = await paymentApi.status(pid);
          if (s.status === "FINISHED") {
            if (pollRef.current) clearInterval(pollRef.current);
            setState({ step: "done" });
            window.dispatchEvent(new Event("auth-refresh"));
          } else if (s.status === "EXPIRED" || s.status === "FAILED") {
            if (pollRef.current) clearInterval(pollRef.current);
            setState({ step: "error", msg: t("upgrade.paymentExpired") });
          }
        } catch {
          /* 轮询失败静默跳过 / silently skip poll errors */
        }
      }, 5000);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setState({ step: "error", msg });
    } finally {
      setLoading(false);
    }
  }, [chosenPlan, chosenCoin, t]);

  const handleRetry = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    setState({ step: "select" });
  };

  const copyAddress = (addr: string) => {
    navigator.clipboard.writeText(addr).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // PRISMX_UPGRADE_RENDER
  return renderContent();

  function renderContent() {
    if (state.step === "select") return renderSelect();
    if (state.step === "pay") return renderPay();
    if (state.step === "done") return renderDone();
    if (state.step === "error") return renderError();
    return null;
  }

  function renderSelect() {
    const isPro = user?.plan === "PRO";
    return (
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "40px 16px 64px" }}>
        {/* 标题 / header */}
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 12px",
            borderRadius: 999, background: "rgba(139,92,246,0.14)",
            border: "1px solid rgba(139,92,246,0.35)", marginBottom: 14,
          }}>
            <span style={{ color: "var(--purple-hi)", fontSize: 12, fontWeight: 700, letterSpacing: "0.04em" }}>PRO</span>
          </div>
          <h2 style={{ fontSize: 26, fontWeight: 800, color: "var(--text)", margin: "0 0 8px" }}>
            {t("upgrade.title")}
          </h2>
          <p style={{ color: "var(--text-2)", fontSize: 14, margin: 0, lineHeight: 1.6 }}>
            {t("upgrade.subtitle")}
          </p>
        </div>

        {/* 促销横幅 / sale banner */}
        {sale?.badge && (
          <div className="glass" style={{
            padding: "14px 20px", marginBottom: 20, textAlign: "center",
            background: "linear-gradient(135deg, rgba(168,85,247,0.20), rgba(139,92,246,0.10))",
            border: "1px solid rgba(168,85,247,0.45)",
          }}>
            <div style={{ color: "var(--purple-hi)", fontWeight: 800, fontSize: 16, letterSpacing: "0.02em" }}>
              {sale.badge} · {sale.percent}% OFF
            </div>
            {sale.end_at && (
              <div style={{ color: "var(--text-2)", fontSize: 12, marginTop: 4 }}>
                {t("upgrade.saleEnds")}: {sale.end_at.slice(0, 10)}
              </div>
            )}
          </div>
        )}

        {/* 套餐选择 / plan selector */}
        <div style={{ marginBottom: 26 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, color: "var(--text-2)", margin: "0 0 12px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {t("upgrade.choosePlan")}
          </h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {plans.map((p) => {
              const active = chosenPlan === p.id;
              const badge = sale?.badge ? `${sale.percent}% OFF` : p.tag === "save_20" ? t("upgrade.save20") : p.tag;
              return (
                <button
                  key={p.id}
                  onClick={() => setChosenPlan(p.id)}
                  className="glass"
                  style={{
                    padding: "20px 18px", cursor: "pointer", textAlign: "left", position: "relative",
                    border: active ? "1.5px solid var(--purple)" : "1px solid var(--line)",
                    background: active
                      ? "linear-gradient(180deg, rgba(139,92,246,0.16), rgba(139,92,246,0.05))"
                      : "linear-gradient(180deg, var(--card-a), var(--card-b))",
                    boxShadow: active ? "0 0 0 3px rgba(139,92,246,0.15)" : "none",
                    transition: "all 0.2s",
                  }}
                >
                  {badge && (
                    <span style={{
                      position: "absolute", top: 12, right: 12,
                      background: "linear-gradient(92deg,#7c3aed,#a855f7)", color: "#fff",
                      fontSize: 10, fontWeight: 800, padding: "3px 8px", borderRadius: 6, letterSpacing: "0.02em",
                    }}>
                      {badge}
                    </span>
                  )}
                  <div style={{ color: "var(--text-2)", fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                    {p.days === 30 ? t("upgrade.monthly") : t("upgrade.yearly")}
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                    <span className="num" style={{ fontSize: 30, fontWeight: 800, color: "var(--text)" }}>
                      ${p.price_usd}
                    </span>
                    {p.original_price_usd != null && p.original_price_usd !== p.price_usd && (
                      <span className="num" style={{ fontSize: 15, color: "var(--text-3)", textDecoration: "line-through" }}>
                        ${p.original_price_usd}
                      </span>
                    )}
                  </div>
                  {p.days === 365 && !sale && (
                    <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 6 }}>
                      {t("upgrade.perMonth", { price: (p.price_usd / 12).toFixed(0) })}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* 币种选择 / coin selector */}
        <div style={{ marginBottom: 28 }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, color: "var(--text-2)", margin: "0 0 12px", textTransform: "uppercase", letterSpacing: "0.06em" }}>
            {t("upgrade.chooseCoin")}
          </h3>
          {currencies.length === 0 ? (
            <div className="glass" style={{ padding: 16, color: "var(--text-3)", fontSize: 13, textAlign: "center" }}>
              {t("common.loading")}
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {currencies.map((c) => {
                const meta = USDT_META[c.toLowerCase()] ?? { label: c.toUpperCase(), note: "" };
                const active = chosenCoin === c;
                const recommended = c.toLowerCase() === "usdttrc20";
                return (
                  <button
                    key={c}
                    onClick={() => setChosenCoin(c)}
                    className="glass"
                    style={{
                      padding: "14px 16px", cursor: "pointer", textAlign: "left", position: "relative",
                      border: active ? "1.5px solid var(--purple)" : "1px solid var(--line)",
                      background: active
                        ? "linear-gradient(180deg, rgba(139,92,246,0.16), rgba(139,92,246,0.05))"
                        : "linear-gradient(180deg, var(--card-a), var(--card-b))",
                      boxShadow: active ? "0 0 0 3px rgba(139,92,246,0.15)" : "none",
                      transition: "all 0.2s",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>USDT</span>
                      <span style={{
                        fontSize: 11, fontWeight: 700, color: active ? "var(--purple-hi)" : "var(--text-2)",
                        padding: "2px 7px", borderRadius: 5, background: active ? "rgba(139,92,246,0.18)" : "var(--nest)",
                      }}>
                        {meta.label}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 6 }}>
                      {recommended ? t("upgrade.recommended") : meta.note}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 支付按钮 / pay button */}
        <button
          className="btn btn-primary"
          onClick={handlePay}
          disabled={loading || currencies.length === 0 || isPro}
          style={{ width: "100%", height: 52, fontSize: 16 }}
        >
          {isPro
            ? t("upgrade.alreadyPro")
            : loading
            ? t("common.loading")
            : t("upgrade.payButton", { price: `$${selectedPlan?.price_usd ?? ""}` })}
        </button>
        <p style={{ textAlign: "center", color: "var(--text-3)", fontSize: 12, marginTop: 14, lineHeight: 1.6 }}>
          {t("upgrade.secureNote")}
        </p>
      </div>
    );
  }
  function renderPay() {
    if (state.step !== "pay") return null;
    const meta = USDT_META[state.payCurrency.toLowerCase()] ?? { label: state.payCurrency.toUpperCase(), note: "" };
    return (
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "40px 16px 64px", textAlign: "center" }}>
        <h2 style={{ fontSize: 24, fontWeight: 800, color: "var(--text)", margin: "0 0 6px" }}>
          {t("upgrade.payTitle")}
        </h2>
        <p style={{ color: "var(--text-2)", fontSize: 14, margin: "0 0 24px", lineHeight: 1.6 }}>
          {t("upgrade.payHint")}
        </p>

        {/* 金额卡 / amount card */}
        <div className="glass" style={{ padding: 24, marginBottom: 14 }}>
          <div style={{ color: "var(--text-2)", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
            {t("upgrade.sendAmount")}
          </div>
          <div className="num" style={{ fontSize: 34, fontWeight: 800, color: "var(--text)", lineHeight: 1.1 }}>
            {state.payAmount}
          </div>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 10, padding: "4px 12px", borderRadius: 999, background: "rgba(139,92,246,0.14)", border: "1px solid rgba(139,92,246,0.3)" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>USDT</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: "var(--purple-hi)" }}>{meta.label}</span>
          </div>
          <div style={{ color: "var(--text-3)", fontSize: 13, marginTop: 12 }}>≈ ${state.amountUsd} USD</div>
        </div>

        {/* 地址卡 / address card */}
        <div className="glass" style={{ padding: 24, marginBottom: 20 }}>
          <div style={{ color: "var(--text-2)", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 12 }}>
            {t("upgrade.sendTo")} · {meta.label}
          </div>
          <div style={{
            fontSize: 14, fontFamily: "'JetBrains Mono', ui-monospace, monospace", color: "var(--text)",
            wordBreak: "break-all", padding: "12px 14px", borderRadius: 10,
            background: "var(--nest)", border: "1px solid var(--line)", lineHeight: 1.5,
          }}>
            {state.payAddress}
          </div>
          <button
            className="btn btn-ghost"
            onClick={() => copyAddress(state.payAddress)}
            style={{ marginTop: 14, width: "100%", height: 44 }}
          >
            {copied ? t("upgrade.copied") : t("common.copy")}
          </button>
        </div>

        {/* 轮询提示 / polling hint */}
        <div style={{ display: "inline-flex", alignItems: "center", gap: 10, color: "var(--text-2)", fontSize: 13 }}>
          <span style={{
            width: 8, height: 8, borderRadius: "50%", background: "var(--gold)",
            boxShadow: "0 0 8px var(--gold)", animation: "pulse 1.5s ease-in-out infinite",
          }} />
          {t("upgrade.pollingHint")}
        </div>

        <div style={{ marginTop: 24 }}>
          <button className="btn btn-ghost" onClick={handleRetry} style={{ height: 40 }}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    );
  }

  function renderDone() {
    return (
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "72px 16px", textAlign: "center" }}>
        <div style={{
          width: 72, height: 72, borderRadius: "50%", margin: "0 auto 24px",
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "var(--up-bg)", border: "1px solid rgba(46,224,126,0.4)",
        }}>
          <span style={{ fontSize: 36 }}>✓</span>
        </div>
        <h2 style={{ fontSize: 24, fontWeight: 800, color: "var(--text)", margin: "0 0 10px" }}>
          {t("upgrade.successTitle")}
        </h2>
        <p style={{ color: "var(--text-2)", fontSize: 14, margin: "0 0 28px", lineHeight: 1.6 }}>
          {t("upgrade.successDesc")}
        </p>
        <button
          className="btn btn-primary"
          onClick={() => { window.location.href = "/dashboard"; }}
          style={{ height: 50, padding: "0 40px", fontSize: 16 }}
        >
          {t("upgrade.goDashboard")}
        </button>
      </div>
    );
  }

  function renderError() {
    if (state.step !== "error") return null;
    return (
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "72px 16px", textAlign: "center" }}>
        <div style={{
          width: 72, height: 72, borderRadius: "50%", margin: "0 auto 24px",
          display: "flex", alignItems: "center", justifyContent: "center",
          background: "var(--down-bg)", border: "1px solid rgba(255,77,103,0.4)",
        }}>
          <span style={{ fontSize: 36, color: "var(--down)" }}>!</span>
        </div>
        <h2 style={{ fontSize: 24, fontWeight: 800, color: "var(--text)", margin: "0 0 10px" }}>
          {t("upgrade.errorTitle")}
        </h2>
        <p style={{ color: "var(--text-2)", fontSize: 14, margin: "0 0 28px", lineHeight: 1.6, wordBreak: "break-word" }}>
          {state.msg}
        </p>
        <button
          className="btn btn-primary"
          onClick={handleRetry}
          style={{ height: 50, padding: "0 40px", fontSize: 16 }}
        >
          {t("upgrade.retry")}
        </button>
      </div>
    );
  }
}
