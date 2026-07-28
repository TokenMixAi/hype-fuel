import {isAddress, type Address} from "viem";

import {ApiError} from "./http.js";

export interface Env {
  /** Relayer EOA private key. Set with `wrangler secret put RELAYER_PRIVATE_KEY`. */
  RELAYER_PRIVATE_KEY: string;
  /** Deployed HypeFuel contract. */
  FUEL_ADDRESS: string;
  /** HyperEVM JSON-RPC endpoint. */
  RPC_URL?: string;
  /** Comma-separated allowed origins, or `*`. */
  ALLOWED_ORIGINS?: string;
  /**
   * Optional Cloudflare rate limiter. Absent in local dev, so all uses are guarded.
   */
  RATE_LIMITER?: {limit(options: {key: string}): Promise<{success: boolean}>};
}

export function fuelAddress(env: Env): Address {
  const address = env.FUEL_ADDRESS;
  if (!address || !isAddress(address)) {
    throw new ApiError(500, "misconfigured", "The relayer is not configured with a contract address");
  }
  return address;
}
