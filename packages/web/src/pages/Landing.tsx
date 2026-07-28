import {Link} from "react-router-dom";

import {useRelayerConfig} from "../hooks/useRelayerConfig";
import {PRODUCT_NAME} from "../config";

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

const FAQ = [
  {
    q: "How can I do this without any HYPE for gas?",
    a: "You never send a transaction. You sign a message, which happens entirely inside your wallet and touches no blockchain. We broadcast the resulting transaction and pay the gas from our own wallet.",
  },
  {
    q: "What exactly am I authorising?",
    a: "A single EIP-3009 transfer authorisation for the precise USDC amount you chose. It names our contract as the only possible recipient, expires in a few minutes, and can be used once. It is not a blanket approval, so we cannot come back for more later.",
  },
  {
    q: "How is the HYPE price decided?",
    a: "On-chain, by the contract itself. It reads HYPE's price directly from Hyperliquid's HyperCore oracle precompiles at the moment of execution and cross-checks the perp oracle against the spot market. We cannot choose the rate you get.",
  },
  {
    q: "What stops the price moving against me?",
    a: "Your signature commits to a minimum amount of HYPE. If the market moves so far that you would receive less than that, the transaction reverts and your USDC stays exactly where it is.",
  },
  {
    q: "Do I have to use this website?",
    a: "No. The contract is permissionless and the relayer is a plain HTTP API, so any wallet or app can integrate it directly. The docs cover the whole flow.",
  },
  {
    q: "Is this affiliated with Hyperliquid?",
    a: "No. HypeFuel is an independent project that happens to build on HyperEVM and read Hyperliquid's public oracle precompiles.",
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
              {config ? `${config.fee.percent}%` : "—"}
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
                ? `$${config.limits.minUsdcFormatted} – $${config.limits.maxUsdcFormatted}`
                : "—"}
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
              swap. The fee is a public contract setting with a hard ceiling that cannot be
              raised past it.
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
