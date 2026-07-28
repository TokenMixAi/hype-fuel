import {SwapCard} from "../components/SwapCard";
import {useRelayerConfig} from "../hooks/useRelayerConfig";

export function Swap() {
  const {config, error, reload} = useRelayerConfig();

  return (
    <main className="container swap-wrap">
      <div style={{width: "100%", maxWidth: 460}}>
        <SwapCard config={config} configError={error} onFilled={reload} />

        {config ? (
          <p
            style={{
              marginTop: 16,
              textAlign: "center",
              fontSize: 13.5,
              color: "var(--text-dim)",
            }}
          >
            {config.inventory.hypeFormatted} HYPE available ·{" "}
            <a
              href={`https://hyperevmscan.io/address/${config.contract}`}
              target="_blank"
              rel="noreferrer"
            >
              contract
            </a>
          </p>
        ) : null}
      </div>
    </main>
  );
}
