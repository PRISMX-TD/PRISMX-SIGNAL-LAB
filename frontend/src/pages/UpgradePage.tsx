import type { CSSProperties } from "react";
import { useEffect, useState, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
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

// 权益对比表数据（键指向 i18n）/ feature comparison rows (keys point to i18n)
const COMPARE_ROWS: Array<{ feat: string; free: string; pro: string }> = [
  { feat: "featSignals", free: "featSignalsFree", pro: "featSignalsPro" },
  { feat: "featWinrate", free: "featWinrateFree", pro: "featWinratePro" },
  { feat: "featMt5", free: "featMt5Free", pro: "featMt5Pro" },
  { feat: "featTrade", free: "featTradeFree", pro: "featTradePro" },
  { feat: "featAuto", free: "featAutoFree", pro: "featAutoPro" },
  { feat: "featPush", free: "featPushFree", pro: "featPushPro" },
  { feat: "featSupport", free: "featSupportFree", pro: "featSupportPro" },
];

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

  // 加载套餐和可用币种列表 / load plans and coin list
  useEffect(() => {
    document.title = t("upgrade.title");
    paymentApi.getPlans().then((r) => {
      setPlans(r.plans);
      setSale(r.sale ?? null);
    }).catch(() => {});
    paymentApi.getCurrencies().then((r) => {
      // 只接受白名单里的低费率 USDT 链；NP 未返回时退回完整白名单，绝不显示贵链
      const usdtOnly = USDT_NETWORKS.filter((n) => r.currencies.some((c) => c.toLowerCase() === n.code));
      const available = usdtOnly.length ? usdtOnly.map((n) => n.code) : USDT_NETWORKS.map((n) => n.code);
      setCurrencies(available);
      const preferred = available.find((c) => c.toLowerCase() === "usdttrc20");
      if (preferred) setChosenCoin(preferred);
      else if (available.length) setChosenCoin(available[0]);
    }).catch(() => {});
  }, [t]);

  // 清理定时器 / cleanup timers
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (clockRef.current) clearInterval(clockRef.current);
    };
  }, []);

  const selectedPlan = plans.find((p) => p.id === chosenPlan);

  // 启动支付有效期倒计时 / start the payment-validity countdown
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
      <div style={{ maxWidth: 620, margin: "0 auto", padding: "40px 16px 72px" }}>
        {/* 标题 / header */}
        <div style={{ textAlign: "center", marginBottom: 30 }}>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 14px",
            borderRadius: 999, background: "rgba(139,92,246,0.14)",
            border: "1px solid rgba(139,92,246,0.35)", marginBottom: 16,
          }}>
            <span style={{ color: "var(--purple-hi)", fontSize: 12, fontWeight: 700, letterSpacing: "0.08em" }}>PRO</span>
          </div>
          <h2 style={{ fontSize: 28, fontWeight: 800, color: "var(--text)", margin: "0 0 10px", letterSpacing: "-0.01em" }}>
            {t("upgrade.title")}
          </h2>
          <p style={{ color: "var(--text-2)", fontSize: 14.5, margin: "0 auto", maxWidth: 440, lineHeight: 1.65 }}>
            {t("upgrade.subtitle")}
          </p>
        </div>

        {/* 促销横幅 / sale banner */}
        {sale?.badge && (
          <div className="glass" style={{
            padding: "14px 20px", marginBottom: 22, textAlign: "center",
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

        {/* 权益对比表 / feature comparison */}
        {renderCompareTable(isPro)}

        {/* 套餐选择 / plan selector */}
        <div style={{ marginTop: 34, marginBottom: 26 }}>
          <h3 style={sectionLabel}>{t("upgrade.choosePlan")}</h3>
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
          <h3 style={sectionLabel}>{t("upgrade.chooseCoin")}</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {currencies.map((code) => {
              const meta = USDT_META[code] ?? { label: code.toUpperCase(), note: "" };
              const active = chosenCoin === code;
              const isTrc = code === "usdttrc20";
              return (
                <button
                  key={code}
                  onClick={() => setChosenCoin(code)}
                  className="glass"
                  style={{
                    padding: "14px 16px", cursor: "pointer", textAlign: "left",
                    border: active ? "1.5px solid var(--purple)" : "1px solid var(--line)",
                    background: active
                      ? "linear-gradient(180deg, rgba(139,92,246,0.14), rgba(139,92,246,0.04))"
                      : "var(--nest)",
                    transition: "all 0.2s",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 800, color: "var(--text)" }}>USDT</span>
                    <span style={{
                      fontSize: 11, fontWeight: 700, color: active ? "var(--purple-hi)" : "var(--text-2)",
                      background: active ? "rgba(139,92,246,0.16)" : "var(--card-b)",
                      padding: "2px 8px", borderRadius: 6,
                    }}>{meta.label}</span>
                  </div>
                  <div style={{ color: "var(--text-3)", fontSize: 12, marginTop: 6 }}>
                    {isTrc ? t("upgrade.recommended") : meta.note}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* 支付按钮 / pay button */}
        {isPro ? (
          <div className="glass" style={{ padding: 18, textAlign: "center", color: "var(--up)", fontWeight: 700 }}>
            {t("upgrade.alreadyPro")}
          </div>
        ) : (
          <>
            <button
              className="btn btn-primary"
              onClick={handlePay}
              disabled={loading || !selectedPlan}
              style={{ width: "100%", height: 54, fontSize: 16, fontWeight: 700 }}
            >
              {loading ? "…" : t("upgrade.payButton", { price: selectedPlan ? `$${selectedPlan.price_usd}` : "" })}
            </button>
            <p style={{ color: "var(--text-3)", fontSize: 12.5, textAlign: "center", marginTop: 16, lineHeight: 1.6 }}>
              {t("upgrade.secureNote")}
            </p>
          </>
        )}
      </div>
    );
  }

  function renderCompareTable(isPro: boolean) {
    return (
      <div>
        <h3 style={sectionLabel}>{t("upgrade.compareTitle")}</h3>
        <div className="glass" style={{ overflow: "hidden", padding: 0 }}>
          {/* 表头 / table header */}
          <div style={{
            display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", alignItems: "center",
            padding: "12px 16px", borderBottom: "1px solid var(--line)",
            background: "linear-gradient(180deg, rgba(139,92,246,0.06), transparent)",
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text-3)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {t("upgrade.compareFeature")}
            </div>
            <div style={{ textAlign: "center", fontSize: 12, fontWeight: 700, color: "var(--text-2)" }}>
              {t("upgrade.planFree")}
              {!isPro && <span style={badgeNow}>{t("upgrade.currentPlan")}</span>}
            </div>
            <div style={{ textAlign: "center", fontSize: 12, fontWeight: 800, color: "var(--purple-hi)" }}>
              {t("upgrade.planPro")}
              {isPro && <span style={badgeNow}>{t("upgrade.currentPlan")}</span>}
            </div>
          </div>
          {/* 表行 / rows */}
          {COMPARE_ROWS.map((row, i) => (
            <div key={row.feat} style={{
              display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", alignItems: "center",
              padding: "12px 16px",
              borderBottom: i < COMPARE_ROWS.length - 1 ? "1px solid var(--line)" : "none",
              background: i % 2 === 1 ? "rgba(255,255,255,0.015)" : "transparent",
            }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>{t(`upgrade.${row.feat}`)}</div>
              <div style={{ textAlign: "center", fontSize: 12.5, color: "var(--text-3)" }}>{t(`upgrade.${row.free}`)}</div>
              <div style={{ textAlign: "center", fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{t(`upgrade.${row.pro}`)}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  function renderPay() {
    if (state.step !== "pay") return null;
    const meta = USDT_META[state.payCurrency] ?? { label: state.payCurrency.toUpperCase(), note: "" };
    const expired = remaining !== null && remaining <= 0;
    // 二维码内容：优先纯地址，最大化钱包兼容性 / QR = plain address for best wallet compatibility
    const qrValue = state.payAddress;
    return (
      <div style={{ maxWidth: 480, margin: "0 auto", padding: "40px 16px 64px", textAlign: "center" }}>
        <h2 style={{ fontSize: 24, fontWeight: 800, color: "var(--text)", margin: "0 0 6px" }}>
          {t("upgrade.payTitle")}
        </h2>
        <p style={{ color: "var(--text-2)", fontSize: 14, margin: "0 0 22px", lineHeight: 1.6 }}>
          {t("upgrade.payHint")}
        </p>

        {/* 倒计时 / countdown */}
        {remaining !== null && (
          <div className="glass" style={{
            display: "inline-flex", alignItems: "center", gap: 10, padding: "8px 16px", marginBottom: 18,
            border: expired ? "1px solid rgba(255,77,103,0.4)" : "1px solid rgba(230,184,74,0.35)",
            background: expired ? "var(--down-bg)" : "rgba(230,184,74,0.08)",
          }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-2)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              {t("upgrade.timeLeft")}
            </span>
            <span className="num" style={{ fontSize: 18, fontWeight: 800, color: expired ? "var(--down)" : "var(--gold)" }}>
              {expired ? "0:00" : fmtCountdown(remaining)}
            </span>
          </div>
        )}

        {expired ? (
          <div className="glass" style={{ padding: 22, marginBottom: 20 }}>
            <p style={{ color: "var(--text-2)", fontSize: 14, margin: "0 0 18px", lineHeight: 1.6 }}>
              {t("upgrade.expiredRetry")}
            </p>
            <button className="btn btn-primary" onClick={handleRetry} style={{ height: 46, padding: "0 28px" }}>
              {t("upgrade.retry")}
            </button>
          </div>
        ) : (
          <>
            {/* 二维码卡 / QR card */}
            <div className="glass" style={{ padding: 24, marginBottom: 14 }}>
              <div style={{
                background: "#fff", borderRadius: 14, padding: 16, width: 208, height: 208,
                margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: "0 8px 30px rgba(0,0,0,0.35)",
              }}>
                <QRCodeSVG value={qrValue} size={176} level="M" />
              </div>
              <div style={{ color: "var(--text)", fontSize: 13.5, fontWeight: 600, marginTop: 16 }}>
                {t("upgrade.scanToPay")}
              </div>
              <div style={{ color: "var(--text-3)", fontSize: 12, marginTop: 4 }}>
                {t("upgrade.orCopyManually")}
              </div>
            </div>

            {/* 金额卡 / amount card */}
            <div className="glass" style={{ padding: 22, marginBottom: 14 }}>
              <div style={{ color: "var(--text-2)", fontSize: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 10 }}>
                {t("upgrade.sendAmount")}
              </div>
              <div className="num" style={{ fontSize: 32, fontWeight: 800, color: "var(--text)", lineHeight: 1.1, wordBreak: "break-all" }}>
                {state.payAmount}
              </div>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 10, padding: "4px 12px", borderRadius: 999, background: "rgba(139,92,246,0.14)", border: "1px solid rgba(139,92,246,0.3)" }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>USDT</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--purple-hi)" }}>{meta.label}</span>
              </div>
              <div style={{ color: "var(--text-3)", fontSize: 13, marginTop: 12 }}>≈ ${state.amountUsd} USD</div>
              <div style={{ color: "var(--gold)", fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
                {t("upgrade.amountExact")}
              </div>
            </div>

            {/* 地址卡 / address card */}
            <div className="glass" style={{ padding: 22, marginBottom: 16 }}>
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

            {/* 截图提示 / screenshot tip */}
            <div style={{
              display: "flex", alignItems: "flex-start", gap: 10, textAlign: "left",
              padding: "12px 14px", marginBottom: 18, borderRadius: 10,
              background: "rgba(96,165,250,0.06)", border: "1px solid rgba(96,165,250,0.22)",
            }}>
              <span style={{ fontSize: 15, lineHeight: 1.4 }}>📸</span>
              <span style={{ color: "var(--text-2)", fontSize: 12.5, lineHeight: 1.6 }}>
                {t("upgrade.screenshotTip")}
              </span>
            </div>

            {/* 轮询提示 / polling hint */}
            <div style={{ display: "inline-flex", alignItems: "center", gap: 10, color: "var(--text-2)", fontSize: 13 }}>
              <span style={{
                width: 8, height: 8, borderRadius: "50%", background: "var(--gold)",
                boxShadow: "0 0 8px var(--gold)", animation: "pulse 1.5s ease-in-out infinite",
              }} />
              {t("upgrade.pollingHint")}
            </div>

            <div style={{ marginTop: 22 }}>
              <button className="btn btn-ghost" onClick={handleRetry} style={{ height: 40 }}>
                {t("common.cancel")}
              </button>
            </div>
          </>
        )}
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

const sectionLabel: CSSProperties = {
  fontSize: 13, fontWeight: 700, color: "var(--text-2)", margin: "0 0 12px",
  textTransform: "uppercase", letterSpacing: "0.06em",
};

// 「当前套餐」小标签 / small "current plan" chip
const badgeNow: CSSProperties = {
  display: "inline-block", marginLeft: 6, padding: "1px 6px", borderRadius: 5,
  fontSize: 9, fontWeight: 700, verticalAlign: "middle",
  color: "var(--text-2)", background: "var(--card-b)", border: "1px solid var(--line)",
};

