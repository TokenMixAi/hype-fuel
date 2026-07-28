import {API_URL} from "../config";
import {useRelayerConfig} from "../hooks/useRelayerConfig";

const SECTIONS = [
  ["overview", "Overview"],
  ["how-it-works", "How it works"],
  ["quickstart", "Quickstart"],
  ["api", "API reference"],
  ["contract", "Contract"],
  ["errors", "Errors"],
  ["security", "Security notes"],
] as const;

const QUICKSTART = `import {
  buildAuthorizationTypedData,
  deserializeOrder,
  serializeOrder,
} from "@hypefuel/sdk";

const API = "${API_URL}";

// 1. Ask the relayer to price the top-up. It reads the HYPE price on-chain and
//    returns the exact order to sign.
const quoteResponse = await fetch(\`\${API}/v1/quote\`, {
  method: "POST",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({user: account, usdcIn: "10000000"}), // $10, 6 decimals
}).then((response) => response.json());

const order = deserializeOrder(quoteResponse.order);

// 2. Have the user sign it. This is a signature, not a transaction, so it needs no gas.
const typedData = buildAuthorizationTypedData(order, quoteResponse.order.to);
const signature = await walletClient.signTypedData({
  account,
  domain: typedData.domain,
  types: typedData.types,
  primaryType: typedData.primaryType,
  message: typedData.message,
});

// 3. Hand it back to the relayer, which broadcasts it and pays the gas.
const {transactionHash} = await fetch(\`\${API}/v1/fill\`, {
  method: "POST",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({order: serializeOrder(order), signature}),
}).then((response) => response.json());`;

const CURL = `# What it costs and how much HYPE is in stock
curl ${API_URL}/v1/config

# Price a $5 top-up
curl -X POST ${API_URL}/v1/quote \\
  -H 'Content-Type: application/json' \\
  -d '{"user":"0xYourAddress","usdcIn":"5000000"}'`;

const CONTRACT_SNIPPET = `struct Order {
    address user;        // signer; pays the USDC and receives the HYPE
    uint256 usdcIn;      // USDC to spend, 6 decimals
    uint256 minHypeOut;  // slippage floor, 18 decimals
    uint256 validAfter;  // authorisation becomes valid after this timestamp
    uint256 validBefore; // authorisation expires at this timestamp
    bytes32 salt;        // makes repeat orders distinct
}

/// Anyone may relay a signed order.
function fill(Order calldata order, bytes calldata signature)
    external
    returns (uint256 hypeOut);`;

export function Docs() {
  const {config} = useRelayerConfig();

  return (
    <main className="container docs-layout">
      <nav className="toc" aria-label="Contents">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`}>
            {label}
          </a>
        ))}
      </nav>

      <div className="prose">
        <h2 id="overview">Overview</h2>
        <p>
          HypeFuel sells native HYPE to wallets that hold USDC but no gas. The user signs one
          message; a relayer submits the transaction and pays the gas. Integrating takes two HTTP
          calls and one signature prompt.
        </p>
        <p>
          Everything below works against the public relayer at <code>{API_URL}</code>. There are
          no API keys and no registration.
        </p>

        <h2 id="how-it-works">How it works</h2>
        <p>
          A wallet with no gas cannot send a transaction, so it cannot emit an on-chain event
          either. That rules out watching the chain for intent: the user's authorisation has to
          reach us off-chain, which is what the relayer API is for.
        </p>
        <p>
          The authorisation itself is an <strong>EIP-3009</strong>{" "}
          <code>ReceiveWithAuthorization</code> message over USDC. It is a better fit than{" "}
          <code>permit</code> here because it moves the tokens in a single atomic step, carries
          its own expiry, and refuses to execute unless the caller is the named payee — so the
          signature is safe to hand to a relayer.
        </p>
        <p>
          EIP-3009 signs over a fixed set of fields, none of which can carry order data such as{" "}
          <code>minHypeOut</code>. HypeFuel solves that by deriving the authorisation's{" "}
          <code>nonce</code> from a hash of the whole order. Because the token verifies the
          signature over that nonce, tampering with any field changes the nonce and invalidates
          the signature. One signature therefore commits to the entire order, and the token's own
          nonce bookkeeping provides replay protection.
        </p>

        <h2 id="quickstart">Quickstart</h2>
        <p>
          Install the SDK, which handles the order encoding and the typed-data construction:
        </p>
        <pre>
          <code>pnpm add @hypefuel/sdk viem</code>
        </pre>
        <pre>
          <code>{QUICKSTART}</code>
        </pre>
        <p>Or drive it straight from the command line:</p>
        <pre>
          <code>{CURL}</code>
        </pre>

        <h2 id="api">API reference</h2>

        <h3>GET /v1/config</h3>
        <p>
          Current fee schedule, order limits and HYPE inventory. Call this to render live pricing
          rather than hardcoding it, since the fee is an on-chain setting that can change within
          its hard ceiling.
        </p>

        <h3>POST /v1/quote</h3>
        <p>
          Prices an amount and returns the order to sign. Body fields:
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th>Type</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <code>user</code>
                </td>
                <td>address</td>
                <td>Wallet that will sign, pay the USDC and receive the HYPE.</td>
              </tr>
              <tr>
                <td>
                  <code>usdcIn</code>
                </td>
                <td>string</td>
                <td>Amount in USDC base units, 6 decimals. "5000000" is $5.</td>
              </tr>
              <tr>
                <td>
                  <code>slippageBps</code>
                </td>
                <td>number</td>
                <td>Optional tolerance used to set minHypeOut. Defaults to 100 (1%).</td>
              </tr>
              <tr>
                <td>
                  <code>ttlSeconds</code>
                </td>
                <td>number</td>
                <td>Optional signing window, 30 to 3600. Defaults to 300.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          The response contains <code>order</code>, a human-readable <code>quote</code>, and a
          ready-made <code>typedData</code> payload whose numeric fields are strings so it can be
          passed directly to <code>eth_signTypedData_v4</code>.
        </p>

        <h3>POST /v1/fill</h3>
        <p>
          Takes <code>{"{order, signature}"}</code> and broadcasts it. The relayer simulates the
          call first, so a bad order comes back as a precise error instead of a failed
          transaction. Returns the transaction hash.
        </p>

        <h3>GET /v1/status/:hash</h3>
        <p>
          Returns <code>pending</code>, <code>confirmed</code> or <code>failed</code>.
        </p>

        <h2 id="contract">Contract</h2>
        {config ? (
          <p>
            Deployed at{" "}
            <a
              href={`https://hyperevmscan.io/address/${config.contract}`}
              target="_blank"
              rel="noreferrer"
            >
              <code>{config.contract}</code>
            </a>{" "}
            on HyperEVM (chain 999), paying out against USDC at <code>{config.usdc}</code>.
          </p>
        ) : (
          <p>Contract address loads from the relayer config endpoint.</p>
        )}
        <pre>
          <code>{CONTRACT_SNIPPET}</code>
        </pre>
        <p>
          <code>fill</code> is permissionless. Every fill is profitable for the contract by
          construction, so anyone can relay one and you are not dependent on our relayer staying
          online. Running your own relayer needs nothing more than a funded HyperEVM wallet.
        </p>

        <h2 id="errors">Errors</h2>
        <p>
          Failures return an HTTP status plus a stable <code>error.code</code> you can branch on.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Meaning</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <code>insufficient_usdc</code>
                </td>
                <td>The wallet does not hold the requested amount.</td>
              </tr>
              <tr>
                <td>
                  <code>insufficient_liquidity</code>
                </td>
                <td>We are out of HYPE for that size. Retry smaller or later.</td>
              </tr>
              <tr>
                <td>
                  <code>price_moved</code>
                </td>
                <td>Price moved past minHypeOut. Request a fresh quote.</td>
              </tr>
              <tr>
                <td>
                  <code>order_expired</code>
                </td>
                <td>The signing window closed. Request a fresh quote.</td>
              </tr>
              <tr>
                <td>
                  <code>already_filled</code>
                </td>
                <td>That authorisation was already spent. Each one works once.</td>
              </tr>
              <tr>
                <td>
                  <code>invalid_signature</code>
                </td>
                <td>
                  The signature does not match the order. Sign the exact order returned by{" "}
                  <code>/v1/quote</code>, unmodified.
                </td>
              </tr>
              <tr>
                <td>
                  <code>oracle_deviation</code>
                </td>
                <td>Price feeds disagree, so fills are paused for safety.</td>
              </tr>
              <tr>
                <td>
                  <code>rate_limited</code>
                </td>
                <td>Too many requests from one address.</td>
              </tr>
            </tbody>
          </table>
        </div>

        <h2 id="security">Security notes</h2>
        <ul>
          <li>
            <strong>Never modify a quoted order.</strong> Every field is committed to by the
            signature, so an edited order is rejected on-chain rather than silently repriced.
          </li>
          <li>
            <strong>HYPE always goes to the signer.</strong> There is no separate recipient field,
            by design: it removes any way for an integrator to redirect a user's funds.
          </li>
          <li>
            <strong>Signatures are safe to transmit.</strong> USDC requires the caller to be the
            named payee, so an intercepted authorisation can only ever be spent at the HypeFuel
            contract, doing exactly what the user approved.
          </li>
          <li>
            <strong>Smart-contract wallets work.</strong> USDC validates signatures through a
            checker that understands ERC-1271, so Safe and 4337 accounts can sign too.
          </li>
        </ul>
      </div>
    </main>
  );
}
