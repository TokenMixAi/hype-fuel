import type {Address} from "viem";

/** HyperEVM mainnet. */
export const HYPEREVM_CHAIN_ID = 999;

export const HYPEREVM_RPC_URL = "https://rpc.hyperliquid.xyz/evm";

/** Circle's native USDC on HyperEVM. Six decimals, EIP-2612 and EIP-3009 capable. */
export const NATIVE_USDC_ADDRESS: Address = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";

/**
 * The deployed HypeFuel proxy on HyperEVM mainnet.
 *
 * A proxy, so it survives upgrades and is the address to integrate against. Prefer the `contract`
 * field from the relayer's `/v1/config` when you have it; this constant is for callers talking
 * straight to the chain with no relayer in the loop.
 */
export const HYPEFUEL_ADDRESS: Address = "0x42b06b1d9a07Fc3925C518dbf9475E7cA80DC8DF";

export const USDC_DECIMALS = 6;

/** Native HYPE, the HyperEVM gas token. */
export const HYPE_DECIMALS = 18;

/**
 * EIP-712 domain of the native USDC contract.
 *
 * Verified against the token's own `DOMAIN_SEPARATOR()`. USDC does not implement ERC-5267,
 * so these fields cannot be discovered at runtime and must be stated explicitly.
 */
export const USDC_EIP712_DOMAIN = {
  name: "USDC",
  version: "2",
  chainId: HYPEREVM_CHAIN_ID,
  verifyingContract: NATIVE_USDC_ADDRESS,
} as const;

/** EIP-3009 struct signed by the user. */
export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    {name: "from", type: "address"},
    {name: "to", type: "address"},
    {name: "value", type: "uint256"},
    {name: "validAfter", type: "uint256"},
    {name: "validBefore", type: "uint256"},
    {name: "nonce", type: "bytes32"},
  ],
} as const;

/** How long a quote stays signable, in seconds. */
export const DEFAULT_ORDER_TTL_SECONDS = 300;

/** Price scale used throughout: USD per HYPE, multiplied by 1e8. */
export const PRICE_SCALE = 100_000_000n;

/**
 * Converts 6-decimal USDC into 18-decimal HYPE at a 1e8-scaled price.
 * 1e12 bridges the decimals and 1e8 undoes the price scale.
 */
export const USDC_TO_HYPE_SCALE = 10n ** 20n;

export const BPS = 10_000n;
