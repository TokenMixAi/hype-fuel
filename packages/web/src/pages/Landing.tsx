import {Link} from "react-router-dom";

import {useRelayerConfig} from "../hooks/useRelayerConfig";
import {PRODUCT_NAME} from "../config";
import {FAQ} from "../content/site";

const STEPS = [
  {
    title: "Connect your wallet",
    body: "Nothing to install and no gas needed. We only read your USDC balance.",
  },
  {
    title: "Sign one message",
    body: "A signature is not a transaction, so it costs nothing. It authorises us to take a set amount of USDC and nothing more.",
  },
  {
    title: "HYPE arrives",
    body: "We submit the transaction and pay the gas ourselves. Native HYPE lands in the same wallet seconds later.",
  },
];

export function Landing() {
  const {config} = useRelayerConfig();

  return (
    <main>
      <div className="container hero">
        <span className="eyebrow">
          <span className="dot" /> Live on HyperEVM
        </span>
        <h1>
          Stuck with USDC and <span className="accent nowrap">no gas</span>?
        </h1>
        <p className="hero-sub">
          {PRODUCT_NAME} swaps your USDC for native HYPE without you ever paying gas. Sign one
          message and it arrives in seconds.
        </p>
        <div className="hero-actions">
          <Link to="/app" className="btn btn-primary">
            Get HYPE now
          </Link>
          <Link to="/docs" className="btn btn-secondary">
            Read the docs
          </Link>
        </div>
      </div>

      <section className="container" style={{paddingTop: 0}}>
        <div className="stats">
          <div className="stat">
            <div className="stat-label">Fee</div>
            <div className="stat-value">
              {config ? `${config.fee.percent}%` : "..."}
              {config ? (
                <span style={{fontSize: 14, color: "var(--text-muted)"}}>
                  {" "}
                  min ${config.fee.minUsdcFormatted}
                </span>
              ) : null}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Top-up range</div>
            <div className="stat-value">
              {config
                ? `$${config.limits.minUsdcFormatted} to $${config.limits.maxUsdcFormatted}`
                : "..."}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Gas you pay</div>
            <div className="stat-value">$0.00</div>
          </div>
        </div>
      </section>

      <section className="container">
        <div className="section-head">
          <h2>The chicken-and-egg problem</h2>
          <p>
            HyperEVM charges gas in HYPE. If you bridge in stablecoins and hold no HYPE, you
            cannot swap for HYPE, because swapping needs gas. The usual refuelling services do
            not cover HyperEVM, so people get stranded with a wallet full of money they cannot
            move.
          </p>
        </div>
        <div className="grid grid-3">
          {STEPS.map((step, index) => (
            <div className="panel" key={step.title}>
              <span className="step-number">{index + 1}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="container">
        <div className="section-head">
          <h2>Built so you keep control</h2>
        </div>
        <div className="grid grid-2">
          <div className="panel">
            <h3>Your signature sets the terms</h3>
            <p>
              The amount of USDC, the minimum HYPE you will accept and the expiry are all sealed
              into the signature. Change any one of them and the signature stops working, so the
              order we submit is the order you approved.
            </p>
          </div>
          <div className="panel">
            <h3>Pricing you can verify</h3>
            <p>
              Rates come from Hyperliquid's own oracle precompiles, read on-chain during the
              swap. The fee is a public contract setting, capped at 5% by the implementation that
              is live today. That cap is not eternal, because the contract can be upgraded, which
              is why the real promise is the minimum HYPE your signature commits to.
            </p>
          </div>
          <div className="panel">
            <h3>Single use, narrow scope</h3>
            <p>
              Each authorisation names our contract as the only party that can spend it, works
              exactly once, and expires within minutes. No lingering allowance is left behind.
            </p>
          </div>
          <div className="panel">
            <h3>Nothing custodial</h3>
            <p>
              USDC moves and HYPE arrives in the same transaction. If we cannot deliver the HYPE
              the whole thing reverts, so your funds are never left with us.
            </p>
          </div>
        </div>
      </section>

      <section className="container narrow">
        <div className="section-head">
          <h2>Questions</h2>
        </div>
        {FAQ.map((item) => (
          <details key={item.q}>
            <summary>{item.q}</summary>
            <p>{item.a}</p>
          </details>
        ))}
      </section>

      <section className="container" style={{textAlign: "center"}}>
        <h2 style={{fontSize: "clamp(24px, 4vw, 34px)", marginBottom: 14}}>
          Get moving on HyperEVM
        </h2>
        <p style={{color: "var(--text-muted)", marginBottom: 26}}>
          One signature is all it takes.
        </p>
        <Link to="/app" className="btn btn-primary">
          Get HYPE now
        </Link>
      </section>
    </main>
  );
}
