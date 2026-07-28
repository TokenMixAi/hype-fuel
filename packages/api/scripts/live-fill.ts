/**
 * Live end-to-end smoke test against HyperEVM mainnet.
 *
 * Spends real USDC. Exercises the same path a browser takes: build an order with the SDK,
 * sign the EIP-3009 authorization, then relay it. Because the signature comes from the
 * TypeScript SDK and is verified by the deployed contract and Circle's token, a passing run
 * proves the SDK's nonce derivation and typed-data construction match the chain.
 *
 * Usage: PRIVATE_KEY=0x... FUEL_ADDRESS=0x... bun packages/api/scripts/live-fill.ts [usdcAmount]
 */
import {createWalletClient, formatEther, http, publicActions} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {
  buildAuthorizationTypedData,
  buildOrder,
  createHyperEvmClient,
  fetchConfig,
  fetchQuote,
  fetchUsdcBalance,
  formatHype,
  formatPrice,
  formatUsdc,
  hyperEvm,
  hypeFuelAbi,
  minHypeOutFor,
  orderNonce,
  parseUsdc,
  type Address,
} from "@hypefuel/sdk";

const privateKey = process.env.PRIVATE_KEY;
const fuelAddress = process.env.FUEL_ADDRESS as Address | undefined;
if (!privateKey || !fuelAddress) {
  throw new Error("PRIVATE_KEY and FUEL_ADDRESS are required");
}

const usdcIn = parseUsdc(process.argv[2] ?? "2");

const account = privateKeyToAccount(privateKey as `0x${string}`);
const wallet = createWalletClient({account, chain: hyperEvm, transport: http()}).extend(
  publicActions,
);
const client = createHyperEvmClient();

console.log(`account   : ${account.address}`);
console.log(`contract  : ${fuelAddress}`);

const config = await fetchConfig(client, fuelAddress);
console.log(
  `config    : fee ${config.feeBps / 100}% (min $${formatUsdc(config.minFeeUsdc)}), ` +
    `limits $${formatUsdc(config.minOrderUsdc)}-$${formatUsdc(config.maxOrderUsdc)}, ` +
    `inventory ${formatHype(config.hypeBalance)} HYPE`,
);

const quoted = await fetchQuote(client, fuelAddress, usdcIn);
console.log(
  `quote     : $${formatUsdc(usdcIn)} -> ${formatHype(quoted.hypeOut)} HYPE ` +
    `(fee $${formatUsdc(quoted.feeUsdc)}, HYPE @ $${formatPrice(quoted.priceUsd1e8)})`,
);

const usdcBefore = await fetchUsdcBalance(client, account.address, config.usdc);
const hypeBefore = await client.getBalance({address: account.address});

const order = buildOrder({
  user: account.address,
  usdcIn,
  minHypeOut: minHypeOutFor(quoted.hypeOut, 100),
});
console.log(`nonce     : ${orderNonce(order)}`);

// Exactly what a wallet would be asked to sign; no transaction, no gas.
const typedData = buildAuthorizationTypedData(order, fuelAddress);
const signature = await account.signTypedData({
  domain: typedData.domain,
  types: typedData.types,
  primaryType: typedData.primaryType,
  message: typedData.message,
});
console.log(`signature : ${signature.slice(0, 26)}…`);

// Simulate before broadcasting so a mistake costs nothing.
const {result: simulated} = await client.simulateContract({
  address: fuelAddress,
  abi: hypeFuelAbi,
  functionName: "fill",
  args: [order, signature],
  account: account.address,
});
console.log(`simulated : ${formatHype(simulated)} HYPE`);

const hash = await wallet.writeContract({
  address: fuelAddress,
  abi: hypeFuelAbi,
  functionName: "fill",
  args: [order, signature],
});
console.log(`submitted : ${hash}`);

const receipt = await wallet.waitForTransactionReceipt({hash});
console.log(`status    : ${receipt.status} in block ${receipt.blockNumber}`);
console.log(`gas used  : ${receipt.gasUsed}`);

const gasCost = receipt.gasUsed * receipt.effectiveGasPrice;
console.log(`gas cost  : ${formatEther(gasCost)} HYPE`);

const usdcAfter = await fetchUsdcBalance(client, account.address, config.usdc);
const hypeAfter = await client.getBalance({address: account.address});

console.log("");
console.log(`USDC      : ${formatUsdc(usdcBefore)} -> ${formatUsdc(usdcAfter)}`);
console.log(`HYPE      : ${formatHype(hypeBefore)} -> ${formatHype(hypeAfter)}`);
// The signer is also the relayer here, so its HYPE delta nets off the gas it just paid.
console.log(`HYPE recv : ${formatHype(hypeAfter - hypeBefore + gasCost)} (net of gas)`);

if (receipt.status !== "success") process.exit(1);
