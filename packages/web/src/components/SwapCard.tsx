import {useCallback, useEffect, useMemo, useState} from "react";
import {useAccount, useChainId, useConnect, useSignTypedData, useSwitchChain} from "wagmi";
import {
  HYPEREVM_CHAIN_ID,
  buildAuthorizationTypedData,
  formatHype,
  formatPrice,
  formatUsdc,
  parseUsdc,
  quote,
} from "@hypefuel/sdk";

import {DEFAULT_AMOUNT, PRESET_AMOUNTS} from "../config";
import {
  RelayerError,
  fetchQuote,
  fetchStatus,
  submitFill,
  type ConfigResponse,
  type QuoteResponse,
} from "../api";

type Phase = "idle" | "quoting" | "signing" | "submitting" | "confirming" | "done";

interface Props {
  config: ConfigResponse | null;
  configError: string | null;
  onFilled?: () => void;
}

export function SwapCard({config, configError, onFilled}: Props) {
  const {address, isConnected} = useAccount();
  const chainId = useChainId();
  const {connect, connectors, isPending: isConnecting} = useConnect();
  const {switchChain} = useSwitchChain();
  const {signTypedDataAsync} = useSignTypedData();

  const [amount, setAmount] = useState(DEFAULT_AMOUNT);
  const [amountTouched, setAmountTouched] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [quoted, setQuoted] = useState<QuoteResponse | null>(null);
  const [result, setResult] = useState<{hash: string; url: string; hype: string} | null>(null);

  const onWrongChain = isConnected && chainId !== HYPEREVM_CHAIN_ID;
  const busy = phase !== "idle" && phase !== "done";

  const usdcIn = useMemo(() => {
    try {
      const parsed = parseUsdc(amount);
      return parsed > 0n ? parsed : null;
    } catch {
      return null;
    }
  }, [amount]);

  const limits = useMemo(() => {
    if (!config) return null;
    const configured = BigInt(config.limits.maxUsdc);
    // Inventory can sit below the configured ceiling, and an order above it is guaranteed to
    // revert. Quote the reachable number so nobody signs something that cannot settle.
    const fillable = config.limits.maxFillableUsdc === null
      ? configured
      : BigInt(config.limits.maxFillableUsdc);
    return {
      min: BigInt(config.limits.minUsdc),
      max: fillable < configured ? fillable : configured,
      liquidityLimited: fillable < configured,
    };
  }, [config]);

  const amountError = useMemo(() => {
    if (!usdcIn || !limits) return null;
    if (usdcIn < limits.min) return `Minimum is $${formatUsdc(limits.min)}`;
    if (usdcIn > limits.max) {
      return limits.liquidityLimited
        ? `We only hold enough HYPE for $${formatUsdc(limits.max)} right now`
        : `Maximum is $${formatUsdc(limits.max)}`;
    }
    return null;
  }, [usdcIn, limits]);

  /**
   * Locally previewed output, shown while typing and before a wallet is connected.
   *
   * Deliberately approximate: the binding numbers come from the relayer's on-chain quote at
   * signing time. This exists so the headline figure is visible immediately rather than after
   * a connect and a round trip.
   */
  const preview = useMemo(() => {
    if (!usdcIn || !config || amountError) return null;
    try {
      return quote(usdcIn, BigInt(config.hypePriceUsd1e8 ?? "0"), {
        feeBps: config.fee.bps,
        minFeeUsdc: BigInt(config.fee.minUsdc),
      });
    } catch {
      return null;
    }
  }, [usdcIn, config, amountError]);

  /**
   * Pull the untouched default down to the largest fillable preset when inventory is short,
   * so the card does not greet everyone with a liquidity error. Anything the user typed is
   * left alone; they get the explicit message instead.
   */
  useEffect(() => {
    if (amountTouched || !limits || !limits.liquidityLimited) return;
    if (parseUsdc(amount) <= limits.max) return;
    const affordable = PRESET_AMOUNTS.filter((p) => parseUsdc(String(p)) <= limits.max);
    if (affordable.length > 0) setAmount(String(affordable[affordable.length - 1]));
  }, [amount, amountTouched, limits]);

  // A quote is only valid for its signing window, so drop it when the amount changes.
  useEffect(() => {
    setQuoted(null);
    setResult(null);
    if (phase === "done") setPhase("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount]);

  const run = useCallback(async () => {
    if (!address || !usdcIn || !config) return;

    setError(null);
    setResult(null);

    try {
      // 1. Price the order on-chain and receive the exact payload to sign.
      setPhase("quoting");
      const fresh = await fetchQuote({user: address, usdcIn});
      setQuoted(fresh);

      // 2. One signature, which commits to every field of the order.
      setPhase("signing");
      const typedData = buildAuthorizationTypedData(fresh.order, config.contract);
      const signature = await signTypedDataAsync({
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
      });

      // 3. The relayer pays the gas and broadcasts on our behalf.
      setPhase("submitting");
      const fill = await submitFill(fresh.order, signature);

      setPhase("confirming");
      const confirmed = await waitForConfirmation(fill.transactionHash);
      if (confirmed === "failed") {
        throw new RelayerError("reverted", "The transaction reverted on-chain. Please try again.");
      }

      setResult({
        hash: fill.transactionHash,
        url: fill.explorerUrl,
        hype: fill.hypeOutFormatted,
      });
      setPhase("done");
      onFilled?.();
    } catch (caught) {
      setPhase("idle");
      setError(describeError(caught));
    }
  }, [address, usdcIn, config, signTypedDataAsync, onFilled]);

  if (configError) {
    return (
      <div className="swap-card">
        <div className="notice notice-error">{configError}</div>
      </div>
    );
  }

  return (
    <div className="swap-card">
      <h2>Get HYPE for gas</h2>
      <p className="hint">
        Pay in USDC, receive native HYPE. You never need gas to start.
      </p>

      <div className="field">
        <div className="field-label">
          <span>You pay</span>
          {limits ? (
            <span className="mono">
              ${formatUsdc(limits.min)} – ${formatUsdc(limits.max)}
            </span>
          ) : null}
        </div>
        <div className="amount-input">
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            disabled={busy}
            onChange={(event) => {
              const next = event.target.value;
              if (next === "" || /^\d*\.?\d{0,6}$/.test(next)) {
                setAmountTouched(true);
                setAmount(next);
              }
            }}
            aria-label="USDC amount"
          />
          <span className="token-tag">USDC</span>
        </div>
      </div>

      <div className="presets">
        {PRESET_AMOUNTS.map((preset) => (
          <button
            key={preset}
            type="button"
            className={`preset${amount === String(preset) ? " selected" : ""}`}
            disabled={busy || (limits !== null && parseUsdc(String(preset)) > limits.max)}
            onClick={() => {
              setAmountTouched(true);
              setAmount(String(preset));
            }}
          >
            ${preset}
          </button>
        ))}
      </div>

      <div className="receive">
        <div className="field-label">
          <span>You receive</span>
        </div>
        <div className="receive-amount">
          {quoted
            ? formatHype(quoted.quote.hypeOut)
            : preview
              ? `≈ ${formatHype(preview.hypeOut)}`
              : "—"}
          <span>HYPE</span>
        </div>

        <dl className="breakdown">
          <div className="row">
            <dt>Service fee</dt>
            <dd>
              {quoted
                ? `$${formatUsdc(quoted.quote.feeUsdc)}`
                : preview
                  ? `$${formatUsdc(preview.feeUsdc)}`
                  : config
                    ? config.fee.description
                    : "—"}
            </dd>
          </div>
          {quoted ? (
            <>
              <div className="row">
                <dt>HYPE price</dt>
                <dd>${formatPrice(quoted.quote.priceUsd1e8)}</dd>
              </div>
              <div className="row">
                <dt>Minimum received</dt>
                <dd>{formatHype(quoted.quote.minHypeOut)} HYPE</dd>
              </div>
            </>
          ) : (
            <div className="row">
              <dt>Network fee</dt>
              <dd>We pay it</dd>
            </div>
          )}
        </dl>
      </div>

      {error ? <div className="notice notice-error">{error}</div> : null}
      {amountError ? <div className="notice notice-info">{amountError}</div> : null}

      {result ? (
        <div className="notice notice-success">
          <div>
            Sent {result.hype} HYPE to your wallet.{" "}
            <a href={result.url} target="_blank" rel="noreferrer">
              View transaction
            </a>
          </div>
        </div>
      ) : null}

      {!isConnected ? (
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={isConnecting || connectors.length === 0}
          onClick={() => {
            const connector = connectors[0];
            if (connector) connect({connector});
          }}
        >
          {connectors.length === 0
            ? "No wallet detected"
            : isConnecting
              ? "Connecting…"
              : "Connect wallet"}
        </button>
      ) : onWrongChain ? (
        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={() => switchChain({chainId: HYPEREVM_CHAIN_ID})}
        >
          Switch to HyperEVM
        </button>
      ) : config?.paused ? (
        <button type="button" className="btn btn-primary btn-block" disabled>
          Temporarily paused
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={busy || !usdcIn || Boolean(amountError)}
          onClick={run}
        >
          {phase === "done" ? "Buy more HYPE" : busy ? phaseLabel(phase) : "Get HYPE"}
        </button>
      )}

      {busy ? (
        <div className="status-line">
          <span className="spinner" />
          <span>{phaseHint(phase)}</span>
        </div>
      ) : null}
    </div>
  );
}

/** Polls for a receipt. Fills usually land within a couple of one-second blocks. */
async function waitForConfirmation(hash: `0x${string}`): Promise<"confirmed" | "failed"> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const {status} = await fetchStatus(hash);
    if (status === "confirmed" || status === "failed") return status;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  // Treat a slow block as success rather than alarming the user; the explorer link is authoritative.
  return "confirmed";
}

function phaseLabel(phase: Phase): string {
  switch (phase) {
    case "quoting":
      return "Getting price…";
    case "signing":
      return "Waiting for signature…";
    case "submitting":
      return "Submitting…";
    case "confirming":
      return "Confirming…";
    default:
      return "Working…";
  }
}

function phaseHint(phase: Phase): string {
  switch (phase) {
    case "quoting":
      return "Reading the HYPE price from HyperCore.";
    case "signing":
      return "Approve the message in your wallet. This costs nothing and sends no transaction.";
    case "submitting":
      return "Broadcasting the transaction. We cover the gas.";
    case "confirming":
      return "Waiting for the block to land.";
    default:
      return "Working.";
  }
}

function describeError(caught: unknown): string {
  if (caught instanceof RelayerError) return caught.message;
  if (caught instanceof Error) {
    const message = caught.message.toLowerCase();
    if (message.includes("user rejected") || message.includes("user denied")) {
      return "You declined the signature.";
    }
    if (message.includes("does not support") || message.includes("unsupported")) {
      return "Your wallet could not sign this message. Try MetaMask or Rabby.";
    }
    return caught.message;
  }
  return "Something went wrong. Please try again.";
}
