# @hypefuel/sdk

Build, sign and price [HypeFuel](https://hypefuel.me) orders: swap USDC for native HYPE on
HyperEVM without holding any gas.

Runs in browsers, Node and Cloudflare Workers. `viem` is the only peer dependency.

```bash
pnpm add @hypefuel/sdk viem
```

## Usage

```ts
import {
  buildAuthorizationTypedData,
  deserializeOrder,
  serializeOrder,
} from "@hypefuel/sdk";

const API = "https://api.hypefuel.me";

// Failures come back as {error: {code, message}} with a 4xx or 5xx, so check the status
// before reading the body. Skipping this turns a clear "amount below the minimum" into an
// undefined further down.
async function call(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? response.statusText);
  return payload;
}

// 1. Price the top-up. The relayer reads HYPE's price on-chain and returns the order to sign.
const quoted = await call("/v1/quote", {user: account, usdcIn: "10000000"}); // $10, 6 decimals

const order = deserializeOrder(quoted.order);

// 2. Sign it. A signature is not a transaction, so this needs no gas. The response already
//    carries a ready payload in `quoted.typedData` if you would rather not rebuild it.
const typedData = buildAuthorizationTypedData(order, quoted.typedData.message.to);
const signature = await walletClient.signTypedData({account, ...typedData});

// 3. Relay it. The relayer pays the gas.
const {transactionHash} = await call("/v1/fill", {
  order: serializeOrder(order),
  signature,
});
```

**Never modify a quoted order.** Every field is committed to by the signature via the derived
nonce, so an edited order is rejected on-chain rather than silently repriced.

## Reading the chain directly

The relayer is a convenience, not a dependency. `fill` is permissionless, so you can price and
submit orders yourself:

```ts
import {
  HYPEFUEL_ADDRESS,
  createHyperEvmClient,
  fetchConfig,
  fetchQuote,
} from "@hypefuel/sdk";

const client = createHyperEvmClient();
const config = await fetchConfig(client, HYPEFUEL_ADDRESS);
const {hypeOut, feeUsdc, priceUsd1e8} = await fetchQuote(client, HYPEFUEL_ADDRESS, 10_000_000n);
```

## API

| Export | Purpose |
|---|---|
| `buildOrder` | Assemble an order with sensible validity bounds and a random salt. |
| `orderNonce` | Derive the EIP-3009 nonce. Matches `HypeFuel.orderNonce` byte for byte. |
| `buildAuthorizationTypedData` | The EIP-712 payload to sign. |
| `quote` / `feeFor` | Local mirrors of the contract's arithmetic, including truncation. |
| `minHypeOutFor` | Apply a slippage tolerance to a quoted amount. |
| `serializeOrder` / `deserializeOrder` | Convert between bigints and JSON-safe strings. |
| `formatUsdc` / `formatHype` / `formatPrice` / `parseUsdc` | Display and input helpers. |
| `HYPEFUEL_ADDRESS` / `NATIVE_USDC_ADDRESS` | Deployed addresses on HyperEVM mainnet. |
| `fetchConfig` / `fetchQuote` / `fetchHypePrice` / `isOrderUsed` | On-chain reads. |
| `hypeFuelAbi` / `usdcAbi` | Typed ABIs. |
| `hyperEvm` | viem chain definition. |

Amounts are always `bigint` in base units: USDC has 6 decimals, HYPE has 18, and prices are USD
scaled by 1e8.
