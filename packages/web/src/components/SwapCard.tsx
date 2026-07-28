import {useCallback, useEffect, useMemo, useState} from "react";
import {useAccount, useConnect, useSignTypedData, useSwitchChain} from "wagmi";
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
  onRetryConfig?: () => void;
}

export function SwapCard({config, configError, onFilled, onRetryConfig}: Props) {
  /**
   * `chainId` here is the wallet's actual chain. `useChainId()` cannot be used for this: wagmi
   * ignores any chain outside its configured list, so it would keep reporting HyperEVM while the
   * wallet sat on Ethereum, and signing would then fail inside the wallet instead.
   */
  const {address, isConnected, chainId} = useAccount();
  const {connect, connectors, isPending: isConnecting} = useConnect();
  const {switchChainAsync} = useSwitchChain();
  const {signTypedDataAsync} = useSignTypedData();

  const [amount, setAmount] = useState(DEFAULT_AMOUNT);
  const [amountTouched, setAmountTouched] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [quoted, setQuoted] = useState<QuoteResponse | null>(null);
  /**
   * Survives every outcome once the relayer has broadcast, including a revert, because the explorer
   * link is the only thing that can tell the user what really happened to their USDC.
   */
  const [result, setResult] = useState<{
    hash: string;
    url: string;
    hype: string;
    outcome: "settled" | "unconfirmed" | "reverted";
  } | null>(null);

  const onWrongChain = isConnected && chainId !== HYPEREVM_CHAIN_ID;
  const busy = phase !== "idle" && phase !== "done";

  /**
   * The relayer reports a null price when the perp and spot feeds disagree beyond tolerance. Every
   * quote will refuse for as long as that holds, so the action is blocked here instead of letting
   * the user sign into a guaranteed failure.
   */
  const pricingUnavailable = config !== null && config.hypePriceUsd1e8 === null;

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
      // A wallet will not sign typed data for a chain it is not on, and the user can switch
      // networks after the button renders, so re-check rather than trusting the earlier guard.
      if (chainId !== HYPEREVM_CHAIN_ID) {
        await switchChainAsync({chainId: HYPEREVM_CHAIN_ID});
      }

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

      // Recorded before polling. The transaction is already broadcast at this point, so whatever
      // happens next the user must still be able to reach it on the explorer.
      const broadcast = {
        hash: fill.transactionHash,
        url: fill.explorerUrl,
        hype: fill.hypeOutFormatted,
      };
      setResult({...broadcast, outcome: "unconfirmed"});

      setPhase("confirming");
      const confirmed = await waitForConfirmation(fill.transactionHash);

      // A revert is reported in place rather than thrown, so the hash stays on screen.
      if (confirmed === "failed") {
        setResult({...broadcast, outcome: "reverted"});
        setPhase("idle");
        return;
      }

      setResult({...broadcast, outcome: confirmed === "confirmed" ? "settled" : "unconfirmed"});
      setPhase("done");
      if (confirmed === "confirmed") onFilled?.();
    } catch (caught) {
      setPhase("idle");
      setError(describeError(caught));
    }
  }, [address, usdcIn, config, chainId, switchChainAsync, signTypedDataAsync, onFilled]);

  if (configError) {
    return (
      <div className="swap-card">
        <div className="notice notice-error" role="alert">
          {configError}
        </div>
        {onRetryConfig ? (
          <button type="button" className="btn btn-primary btn-block" onClick={onRetryConfig}>
            Try again
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="swap-card">
      {/* The card is this route's main heading, so it carries the h1 rather than starting at h2. */}
      <h1>Get HYPE for gas</h1>
      <p className="hint">
        Pay in USDC, receive native HYPE. You never need gas to start.
      </p>

      <div className="field">
        <div className="field-label">
          <span>You pay</span>
          {limits ? (
            <span className="mono">
              ${formatUsdc(limits.min)} to ${formatUsdc(limits.max)}
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
            aria-invalid={amountError ? true : undefined}
            aria-describedby={amountError ? "amount-error" : undefined}
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
              : "0.0000"}
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
                    : "..."}
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

      {error ? (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      ) : null}
      {amountError ? (
        <div className="notice notice-info" id="amount-error">
          {amountError}
        </div>
      ) : null}

      {result ? (
        <div
          className={`notice notice-${result.outcome === "settled" ? "success" : result.outcome === "reverted" ? "error" : "info"}`}
          role={result.outcome === "reverted" ? "alert" : "status"}
          aria-live="polite"
        >
          <div>
            {result.outcome === "settled" ? (
              <>Sent {result.hype} HYPE to your wallet. </>
            ) : result.outcome === "reverted" ? (
              <>
                The transaction reverted, so your USDC was not taken. Prices move quickly, so
                trying again usually works.{" "}
              </>
            ) : (
              <>
                Submitted, but it has not confirmed yet. Your USDC is only taken if it succeeds, so
                check the transaction before trying again.{" "}
              </>
            )}
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
          onClick={async () => {
            setError(null);
            try {
              await switchChainAsync({chainId: HYPEREVM_CHAIN_ID});
            } catch (caught) {
              setError(describeError(caught));
            }
          }}
        >
          Switch to HyperEVM
        </button>
      ) : config?.paused ? (
        <button type="button" className="btn btn-primary btn-block" disabled>
          Temporarily paused
        </button>
      ) : pricingUnavailable ? (
        <button type="button" className="btn btn-primary btn-block" disabled>
          Pricing unavailable
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={busy || !config || !usdcIn || Boolean(amountError)}
          onClick={run}
        >
          {phase === "done" ? "Buy more HYPE" : busy ? phaseLabel(phase) : "Get HYPE"}
        </button>
      )}

      {pricingUnavailable ? (
        <div className="notice notice-info" role="status">
          The HYPE price feeds do not currently agree, so we will not quote a rate. Nothing has been
          taken from your wallet. This usually clears within a few minutes.
        </div>
      ) : null}

      <div className="status-line-slot" role="status" aria-live="polite">
        {busy ? (
          <div className="status-line">
            <span className="spinner" />
            <span>{phaseHint(phase)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Polls for a receipt. Fills usually land within a couple of one-second blocks.
 *
 * Runs out to `"unknown"` rather than assuming success. A transaction that never confirms and one
 * that confirmed while we were not looking are indistinguishable from here, and claiming HYPE
 * arrived when it may not have is the more expensive mistake: the user goes off to spend gas they
 * do not have. A polling error is treated the same way, since the transaction is already broadcast
 * and the hash is the useful thing to hand back.
 */
async function waitForConfirmation(
  hash: `0x${string}`,
): Promise<"confirmed" | "failed" | "unknown"> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const {status} = await fetchStatus(hash);
      if (status === "confirmed" || status === "failed") return status;
    } catch {
      return "unknown";
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return "unknown";
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
    // Wallets word this many different ways, hence matching on the shared parts.
    if (
      caught.name === "ChainMismatchError" ||
      message.includes("chainid should be same") ||
      (message.includes("chain") && message.includes("mismatch")) ||
      message.includes("does not match the target chain")
    ) {
      return "Your wallet is on a different network. Switch it to HyperEVM and try again.";
    }
    if (message.includes("does not support") || message.includes("unsupported")) {
      return "Your wallet could not sign this message. Try MetaMask or Rabby.";
    }
    // viem appends its own version and a docs link, which means nothing to a user.
    return caught.message.split("\n")[0] ?? "Something went wrong. Please try again.";
  }
  return "Something went wrong. Please try again.";
}
