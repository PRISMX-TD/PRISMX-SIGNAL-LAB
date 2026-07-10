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
const USDT_NETWORKS: Array<{ code: string; label: string }> = [
  { code: "usdttrc20", label: "USDT · TRC-20 (Tron)" },
  { code: "usdterc20", label: "USDT · ERC-20 (Ethereum)" },
  { code: "usdtbsc", label: "USDT · BEP-20 (BSC)" },
  { code: "usdtsol", label: "USDT · Solana" },
  { code: "usdtmatic", label: "USDT · Polygon" },
  { code: "usdtarb", label: "USDT · Arbitrum" },
  { code: "usdtton", label: "USDT · TON" },
];

const USDT_LABELS: Record<string, string> = Object.fromEntries(
  USDT_NETWORKS.map((n) => [n.code, n.label]),
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
      // 优先选 usdttrc20（TRC-20 USDT 手续费低、速度快）
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

  // 获取已选套餐信息
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
      // 启动轮询 / start polling
      const pid = res.payment_id;
      pollRef.current = setInterval(async () => {
        try {
          const s = await paymentApi.status(pid);
          if (s.status === "FINISHED") {
            if (pollRef.current) clearInterval(pollRef.current);
            setState({ step: "done" });
            // 刷新用户信息/重新请求 me 让 App 更新 plan
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

  // 重试 / retry
  const handleRetry = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    setState({ step: "select" });
  };

  // 复制地址 / copy address
  const copyAddress = (addr: string) => {
    navigator.clipboard.writeText(addr).catch(() => {});
    alert(t("upgrade.copied"));
  };

  // ---- 选择套餐和币种 / select plan & coin ----
  if (state.step === "select") {
    return (
      <div style={{ maxWidth: 520, margin: "0 auto", padding: "32px 16px" }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>{t("upgrade.title")}</h2>
        <p style={{ color: "var(--ink-muted)", marginBottom: 24, fontSize: 14 }}>
          {t("upgrade.subtitle")}
        </p>

        {/* 促销横幅 / sale banner */}
        {sale?.badge && (
          <div style={{
            marginBottom: 20, padding: "12px 20px", borderRadius: 12,
            background: "linear-gradient(135deg, rgba(139,92,246,0.15), rgba(59,130,246,0.15))",
            border: "1px solid var(--neon)", textAlign: "center",
          }}>
            <span style={{ color: "var(--neon)", fontWeight: 700, fontSize: 15 }}>
              {sale.badge} — {sale.percent}% OFF
            </span>
            {sale.end_at && (
              <span style={{ display: "block", color: "var(--ink-muted)", fontSize: 12, marginTop: 2 }}>
                {t("upgrade.saleEnds")}: {sale.end_at.slice(0, 10)}
              </span>
            )}
          </div>
        )}

        {/* 套餐选择 / plan selector */}
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>{t("upgrade.choosePlan")}</h3>
          <div style={{ display: "flex", gap: 12 }}>
            {plans.map((p) => (
              <button
                key={p.id}
                onClick={() => setChosenPlan(p.id)}
                style={{
                  flex: 1,
                  padding: "16px",
                  borderRadius: 12,
                  border: chosenPlan === p.id ? "2px solid var(--neon)" : "1px solid var(--glass-border)",
                  background: chosenPlan === p.id ? "var(--glass)" : "var(--ink-deep)",
                  color: "var(--ink-primary)",
                  cursor: "pointer",
                  textAlign: "left",
                  position: "relative",
                }}
              >
                {(p.tag || sale?.badge) && (
                  <span style={{
                    position: "absolute", top: -8, right: -4,
                    background: sale?.badge ? "var(--neon)" : "var(--neon)",
                    color: "#000", fontSize: 11,
                    padding: "2px 8px", borderRadius: 8, fontWeight: 700,
                  }}>
                    {sale?.badge
                      ? `${sale.percent}% OFF`
                      : p.tag === "save_20"
                      ? t("upgrade.save20")
                      : p.tag}
                  </span>
                )}
                <div style={{ fontSize: 20, fontWeight: 700 }}>
                  ${p.price_usd}
                  {p.original_price_usd != null && p.original_price_usd !== p.price_usd && (
                    <span style={{
                      fontSize: 14, color: "var(--ink-muted)", textDecoration: "line-through",
                      marginLeft: 8, fontWeight: 400,
                    }}>
                      ${p.original_price_usd}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "var(--ink-muted)" }}>
                  {p.days === 30 ? t("upgrade.monthly") : t("upgrade.yearly")}
                </div>
                {p.days === 365 && !sale && (
                  <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 2 }}>
                    {t("upgrade.perMonth", { price: (p.price_usd / 12).toFixed(0) })}
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* 币种选择 / coin selector */}
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>{t("upgrade.chooseCoin")}</h3>
          {currencies.length === 0 ? (
            <span style={{ fontSize: 13, color: "var(--ink-muted)" }}>{t("common.loading")}</span>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {currencies.map((c) => (
                <button
                  key={c}
                  onClick={() => setChosenCoin(c)}
                  style={{
                    padding: "12px 16px",
                    borderRadius: 10,
                    border: chosenCoin === c ? "1px solid var(--neon)" : "1px solid var(--glass-border)",
                    background: chosenCoin === c ? "var(--glass)" : "transparent",
                    color: chosenCoin === c ? "var(--neon)" : "var(--ink-primary)",
                    cursor: "pointer",
                    fontSize: 14,
                    fontWeight: 600,
                    textAlign: "left",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span>{USDT_LABELS[c.toLowerCase()] ?? c.toUpperCase()}</span>
                  {c.toLowerCase() === "usdttrc20" && (
                    <span style={{ fontSize: 11, color: "var(--neon)", fontWeight: 700 }}>
                      {t("upgrade.recommended")}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={handlePay}
          disabled={loading || currencies.length === 0 || user?.plan === "PRO"}
          style={{
            width: "100%", padding: "14px",
            borderRadius: 12, border: "none",
            background: loading ? "var(--ink-muted)" : "var(--neon)",
            color: "#000", fontWeight: 700, fontSize: 16,
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {user?.plan === "PRO"
            ? t("upgrade.alreadyPro")
            : loading
            ? t("common.loading")
            : t("upgrade.payButton", { price: `$${selectedPlan?.price_usd ?? ""}` })}
        </button>
      </div>
    );
  }

  // ---- 支付中：展示地址和金额 / paying: show address & amount ----
  if (state.step === "pay") {
    return (
      <div style={{ maxWidth: 520, margin: "0 auto", padding: "32px 16px", textAlign: "center" }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>{t("upgrade.payTitle")}</h2>
        <p style={{ color: "var(--ink-muted)", marginBottom: 24, fontSize: 14 }}>
          {t("upgrade.payHint")}
        </p>

        {/* 金额 / amount */}
        <div style={{
          background: "var(--glass)", borderRadius: 12, padding: 20, marginBottom: 16,
          border: "1px solid var(--glass-border)",
        }}>
          <div style={{ color: "var(--ink-muted)", fontSize: 13, marginBottom: 4 }}>{t("upgrade.sendAmount")}</div>
          <div style={{ fontSize: 28, fontWeight: 700, color: "var(--neon)" }}>
            {state.payAmount} {state.payCurrency.toUpperCase()}
          </div>
          <div style={{ color: "var(--ink-muted)", fontSize: 13, marginTop: 4 }}>≈ ${state.amountUsd} USD</div>
        </div>

        {/* 地址 / address */}
        <div style={{
          background: "var(--glass)", borderRadius: 12, padding: 20, marginBottom: 24,
          border: "1px solid var(--glass-border)", wordBreak: "break-all",
        }}>
          <div style={{ color: "var(--ink-muted)", fontSize: 13, marginBottom: 4 }}>{t("upgrade.sendTo")}</div>
          <div style={{ fontSize: 15, fontFamily: "monospace", color: "var(--ink-primary)" }}>
            {state.payAddress}
          </div>
          <button
            onClick={() => copyAddress(state.payAddress)}
            style={{
              marginTop: 12, padding: "8px 20px", borderRadius: 8,
              border: "1px solid var(--glass-border)", background: "transparent",
              color: "var(--ink-primary)", cursor: "pointer", fontSize: 13,
            }}
          >
            {t("common.copy")}
          </button>
        </div>

        <p style={{ fontSize: 13, color: "var(--ink-muted)" }}>
          {t("upgrade.pollingHint")}
        </p>
      </div>
    );
  }

  // ---- 支付成功 / payment done ----
  if (state.step === "done") {
    return (
      <div style={{ maxWidth: 520, margin: "0 auto", padding: "64px 16px", textAlign: "center" }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🎉</div>
        <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>{t("upgrade.successTitle")}</h2>
        <p style={{ color: "var(--ink-muted)", marginBottom: 24, fontSize: 14 }}>
          {t("upgrade.successDesc")}
        </p>
        <button
          onClick={() => { window.location.href = "/dashboard"; }}
          style={{
            padding: "14px 32px", borderRadius: 12, border: "none",
            background: "var(--neon)", color: "#000", fontWeight: 700, fontSize: 16,
            cursor: "pointer",
          }}
        >
          {t("upgrade.goDashboard")}
        </button>
      </div>
    );
  }

  // ---- 错误 / error ----
  if (state.step === "error") {
    return (
      <div style={{ maxWidth: 520, margin: "0 auto", padding: "64px 16px", textAlign: "center" }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>{t("upgrade.errorTitle")}</h2>
        <p style={{ color: "var(--ink-muted)", marginBottom: 24, fontSize: 14 }}>{state.msg}</p>
        <button
          onClick={handleRetry}
          style={{
            padding: "14px 32px", borderRadius: 12, border: "none",
            background: "var(--neon)", color: "#000", fontWeight: 700, fontSize: 16,
            cursor: "pointer",
          }}
        >
          {t("upgrade.retry")}
        </button>
      </div>
    );
  }

  return null;
}
