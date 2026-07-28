/**
 * Live end-to-end test through the public HTTP API, mirroring exactly what a third-party
 * integrator does: quote, sign, fill, poll. Spends real USDC.
 *
 * Unlike `live-fill.ts`, the relayer pays the gas here, so the signer's HYPE balance shows
 * the pure amount received.
 *
 * Usage: PRIVATE_KEY=0x... API_URL=https://... bun packages/api/scripts/live-api-fill.ts [amount]
 */
import {privateKeyToAccount} from "viem/accounts";
import {
  buildAuthorizationTypedData,
  createHyperEvmClient,
  deserializeOrder,
  formatHype,
  formatUsdc,
  fetchUsdcBalance,
  orderNonce,
  parseUsdc,
  serializeOrder,
  NATIVE_USDC_ADDRESS,
} from "@hypefuel/sdk";

const privateKey = process.env.PRIVATE_KEY;
const apiUrl = (process.env.API_URL ?? "").replace(/\/+$/, "");
if (!privateKey || !apiUrl) throw new Error("PRIVATE_KEY and API_URL are required");

const usdcIn = parseUsdc(process.argv[2] ?? "3");
const account = privateKeyToAccount(privateKey as `0x${string}`);
const client = createHyperEvmClient();

async function call(path: string, body?: unknown) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: body ? "POST" : "GET",
    headers: {"Content-Type": "application/json"},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${text}`);
  return JSON.parse(text);
}

const usdcBefore = await fetchUsdcBalance(client, account.address, NATIVE_USDC_ADDRESS);
const hypeBefore = await client.getBalance({address: account.address});
console.log(`before    : ${formatUsdc(usdcBefore)} USDC, ${formatHype(hypeBefore)} HYPE`);

// 1. Quote.
const quoted = await call("/v1/quote", {user: account.address, usdcIn: usdcIn.toString()});
console.log(
  `quote     : $${quoted.quote.usdcInFormatted} -> ${quoted.quote.hypeOutFormatted} HYPE ` +
    `(fee $${quoted.quote.feeUsdcFormatted})`,
);

const order = deserializeOrder(quoted.order);
if (orderNonce(order) !== quoted.nonce) {
  throw new Error("SDK nonce disagrees with the relayer's");
}
console.log(`nonce     : ${quoted.nonce} (SDK agrees)`);

// 2. Sign. No gas, no transaction.
const typedData = buildAuthorizationTypedData(order, quoted.typedData.message.to);
const signature = await account.signTypedData({
  domain: typedData.domain,
  types: typedData.types,
  primaryType: typedData.primaryType,
  message: typedData.message,
});

// 3. Relay. The relayer pays the gas.
const filled = await call("/v1/fill", {order: serializeOrder(order), signature});
console.log(`submitted : ${filled.transactionHash}`);

// 4. Poll.
let status = "pending";
for (let attempt = 0; attempt < 30 && status === "pending"; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  ({status} = await call(`/v1/status/${filled.transactionHash}`));
}
console.log(`status    : ${status}`);

const usdcAfter = await fetchUsdcBalance(client, account.address, NATIVE_USDC_ADDRESS);
const hypeAfter = await client.getBalance({address: account.address});
console.log(`after     : ${formatUsdc(usdcAfter)} USDC, ${formatHype(hypeAfter)} HYPE`);
console.log("");
console.log(`USDC spent    : ${formatUsdc(usdcBefore - usdcAfter)}`);
console.log(`HYPE received : ${formatHype(hypeAfter - hypeBefore)}`);
console.log(`gas paid by user: 0 (relayer covered it)`);

if (status !== "confirmed") process.exit(1);
