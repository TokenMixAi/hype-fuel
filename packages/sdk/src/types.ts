import type {Address, Hex} from "viem";

/** Re-exported so consumers need not depend on viem's types directly. */
export type {Address, Hex} from "viem";

/**
 * A HypeFuel order.
 *
 * Every field is committed to by the single EIP-3009 signature, via the derived nonce.
 * See {@link orderNonce}.
 */
export interface Order {
  /** Signer of the authorization. Pays the USDC and receives the HYPE. */
  user: Address;
  /** USDC to spend, in base units (6 decimals). */
  usdcIn: bigint;
  /** Minimum acceptable HYPE in wei. Protects the signer against price movement. */
  minHypeOut: bigint;
  /** Unix seconds after which the authorization becomes valid. */
  validAfter: bigint;
  /** Unix seconds at which the authorization expires. */
  validBefore: bigint;
  /** Random 32 bytes. Makes otherwise-identical orders distinct. */
  salt: Hex;
}

/** An order plus the signature authorising it. */
export interface SignedOrder {
  order: Order;
  signature: Hex;
}

/** On-chain configuration, as returned by `HypeFuel.config()`. */
export interface FuelConfig {
  usdc: Address;
  feeBps: number;
  minFeeUsdc: bigint;
  minOrderUsdc: bigint;
  maxOrderUsdc: bigint;
  maxOracleDeviationBps: number;
  maxFeeBps: number;
  paused: boolean;
  hypeBalance: bigint;
}

/** Rebalancing configuration, as returned by `HypeFuel.rebalanceConfig()`. */
export interface RebalanceConfig {
  /** Uniswap V3 pool the contract buys HYPE from. Zero when rebalancing is not set up. */
  pool: Address;
  /** True when USDC is the pool's `token0`. Derived on-chain, not configured. */
  usdcIsToken0: boolean;
  /** Inventory level a rebalance aims to restore, in wei. */
  hypeTarget: bigint;
  /** Inventory level at or below which a rebalance is permitted, in wei. */
  hypeFloor: bigint;
  /** Smallest swap worth making, in USDC base units. */
  minRebalanceUsdc: bigint;
  /** Tolerance against the HyperCore price, in basis points. */
  maxRebalanceSlippageBps: number;
  /** USDC the contract currently holds, in base units. */
  usdcBalance: bigint;
}

/** The result of pricing an order. */
export interface Quote {
  /** USDC the user pays, in base units. */
  usdcIn: bigint;
  /** Fee retained by the protocol, in USDC base units. */
  feeUsdc: bigint;
  /** HYPE the user receives, in wei. */
  hypeOut: bigint;
  /** HYPE price used, USD scaled by 1e8. */
  priceUsd1e8: bigint;
  /** Effective total cost as a fraction of the input, for display. */
  effectiveFeePct: number;
}

/** Order fields serialised as strings, for JSON transport. */
export interface SerializedOrder {
  user: Address;
  usdcIn: string;
  minHypeOut: string;
  validAfter: string;
  validBefore: string;
  salt: Hex;
}
