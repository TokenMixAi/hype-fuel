import {createPublicClient, defineChain, http, type Address, type PublicClient} from "viem";

import {hypeFuelAbi, usdcAbi} from "./abi.js";
import {HYPEREVM_CHAIN_ID, HYPEREVM_RPC_URL, NATIVE_USDC_ADDRESS} from "./constants.js";
import type {FuelConfig, Order, RebalanceConfig} from "./types.js";

/** HyperEVM mainnet, for viem. */
export const hyperEvm = defineChain({
  id: HYPEREVM_CHAIN_ID,
  name: "HyperEVM",
  nativeCurrency: {name: "HYPE", symbol: "HYPE", decimals: 18},
  rpcUrls: {default: {http: [HYPEREVM_RPC_URL]}},
  blockExplorers: {
    default: {name: "HyperEVMScan", url: "https://hyperevmscan.io"},
  },
});

export function createHyperEvmClient(rpcUrl = HYPEREVM_RPC_URL): PublicClient {
  return createPublicClient({chain: hyperEvm, transport: http(rpcUrl)});
}

/** Reads the contract's live configuration. */
export async function fetchConfig(
  client: PublicClient,
  fuelAddress: Address,
): Promise<FuelConfig> {
  const [
    usdc,
    feeBps,
    minFeeUsdc,
    minOrderUsdc,
    maxOrderUsdc,
    maxOracleDeviationBps,
    maxFeeBps,
    paused,
    hypeBalance,
  ] = await client.readContract({
    address: fuelAddress,
    abi: hypeFuelAbi,
    functionName: "config",
  });

  return {
    usdc,
    feeBps: Number(feeBps),
    minFeeUsdc,
    minOrderUsdc,
    maxOrderUsdc,
    maxOracleDeviationBps: Number(maxOracleDeviationBps),
    maxFeeBps: Number(maxFeeBps),
    paused,
    hypeBalance,
  };
}

/** Reads the HYPE price straight from the HyperCore precompiles, via the contract. */
export async function fetchHypePrice(
  client: PublicClient,
  fuelAddress: Address,
): Promise<bigint> {
  return client.readContract({
    address: fuelAddress,
    abi: hypeFuelAbi,
    functionName: "hypePriceUsd1e8",
  });
}

/**
 * Prices an order on-chain.
 *
 * Prefer this over the local {@link quote} when a value will be shown to a user, since it
 * reflects the contract's live fee settings as well as the current price.
 */
export async function fetchQuote(
  client: PublicClient,
  fuelAddress: Address,
  usdcIn: bigint,
): Promise<{hypeOut: bigint; feeUsdc: bigint; priceUsd1e8: bigint}> {
  const [hypeOut, feeUsdc, priceUsd1e8] = await client.readContract({
    address: fuelAddress,
    abi: hypeFuelAbi,
    functionName: "quote",
    args: [usdcIn],
  });
  return {hypeOut, feeUsdc, priceUsd1e8};
}

export async function fetchUsdcBalance(
  client: PublicClient,
  account: Address,
  usdcAddress: Address = NATIVE_USDC_ADDRESS,
): Promise<bigint> {
  return client.readContract({
    address: usdcAddress,
    abi: usdcAbi,
    functionName: "balanceOf",
    args: [account],
  });
}

/** Reads the contract's rebalancing configuration and current USDC holdings. */
export async function fetchRebalanceConfig(
  client: PublicClient,
  fuelAddress: Address,
): Promise<RebalanceConfig> {
  const [
    pool,
    usdcIsToken0,
    hypeTarget,
    hypeFloor,
    minRebalanceUsdc,
    maxRebalanceSlippageBps,
    usdcBalance,
  ] = await client.readContract({
    address: fuelAddress,
    abi: hypeFuelAbi,
    functionName: "rebalanceConfig",
  });

  return {
    pool,
    usdcIsToken0,
    hypeTarget,
    hypeFloor,
    minRebalanceUsdc,
    maxRebalanceSlippageBps: Number(maxRebalanceSlippageBps),
    usdcBalance,
  };
}

/**
 * USDC that a rebalance would spend right now, or zero when one is not warranted.
 *
 * Zero covers every reason a rebalance would be refused (inventory above the floor, no USDC to
 * spend, an amount below the minimum, a paused contract), so a keeper can treat this as its only
 * precondition. It still throws if the oracle itself is unusable, which is worth surfacing rather
 * than swallowing.
 */
export async function fetchPendingRebalanceUsdc(
  client: PublicClient,
  fuelAddress: Address,
): Promise<bigint> {
  return client.readContract({
    address: fuelAddress,
    abi: hypeFuelAbi,
    functionName: "pendingRebalanceUsdc",
  });
}

/** True once an order's authorization has been spent. */
export async function isOrderUsed(
  client: PublicClient,
  fuelAddress: Address,
  order: Order,
): Promise<boolean> {
  return client.readContract({
    address: fuelAddress,
    abi: hypeFuelAbi,
    functionName: "isOrderUsed",
    args: [order],
  });
}
