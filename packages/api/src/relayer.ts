import {
  BaseError,
  ContractFunctionRevertedError,
  createWalletClient,
  http,
  publicActions,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import {privateKeyToAccount} from "viem/accounts";
import {hyperEvmChain} from "./chain.js";
import {hypeFuelAbi, type Order} from "@hypefuel/sdk";

import {ApiError} from "./http.js";

/** Extra headroom over the estimate, since HYPE price reads happen at execution time. */
const GAS_LIMIT_MULTIPLIER = 130n;

/** Attempts to make when a nonce collides with a concurrent submission. */
const MAX_NONCE_ATTEMPTS = 3;

/**
 * Serialises submissions inside a single Worker isolate.
 *
 * Cloudflare may run many isolates concurrently, so this is not a global lock; it removes
 * the common case of self-collision and {@link submitFill} retries the rest. A Durable Object
 * would give a true global nonce allocator if volume ever warrants it.
 */
let submissionChain: Promise<unknown> = Promise.resolve();

export type Relayer = ReturnType<typeof createRelayer>;

export function createRelayer(privateKey: string, rpcUrl: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("RELAYER_PRIVATE_KEY must be a 32-byte hex string");
  }
  const account = privateKeyToAccount(privateKey as Hex);
  return createWalletClient({
    account,
    chain: hyperEvmChain(rpcUrl),
    transport: http(rpcUrl),
  }).extend(publicActions);
}

/** Translates a contract revert into an error the caller can act on. */
function toApiError(error: unknown): ApiError {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName ?? reverted.reason ?? "";
      const args = (reverted.data?.args ?? []) as unknown[];

      switch (name) {
        case "InsufficientLiquidity":
          return new ApiError(
            503,
            "insufficient_liquidity",
            "We are temporarily out of HYPE. Please try a smaller amount or come back shortly.",
          );
        case "InsufficientOutput":
          return new ApiError(
            409,
            "price_moved",
            "The HYPE price moved beyond your slippage tolerance. Request a fresh quote.",
            {hypeOut: args[0]?.toString(), minHypeOut: args[1]?.toString()},
          );
        case "OrderExpired":
          return new ApiError(409, "order_expired", "This order expired. Request a fresh quote.");
        case "OrderNotYetValid":
          return new ApiError(409, "order_not_yet_valid", "This order is not valid yet.");
        case "OrderSizeOutOfRange":
          return new ApiError(400, "order_size", "That amount is outside the supported range.", {
            usdcIn: args[0]?.toString(),
            min: args[1]?.toString(),
            max: args[2]?.toString(),
          });
        case "OracleDeviation":
          return new ApiError(
            503,
            "oracle_deviation",
            "HYPE price feeds disagree right now, so we have paused fills for safety. Try again shortly.",
          );
        case "OracleUnavailable":
          return new ApiError(503, "oracle_unavailable", "The HYPE price feed is unavailable.");
        case "Paused":
          return new ApiError(503, "paused", "The service is paused.");
        case "Reentrancy":
          return new ApiError(400, "reentrancy", "Re-entrant fills are not permitted.");
      }

      // The token's own require() strings surface here rather than as custom errors.
      const reason = reverted.reason ?? "";
      if (reason.includes("authorization is used or canceled")) {
        return new ApiError(
          409,
          "already_filled",
          "This order was already filled. Request a fresh quote to top up again.",
        );
      }
      if (reason.includes("invalid signature")) {
        return new ApiError(
          400,
          "invalid_signature",
          "The signature does not match this order. Sign the exact order returned by /v1/quote.",
        );
      }
      if (reason.includes("exceeds balance")) {
        return new ApiError(400, "insufficient_usdc", "Your wallet does not hold enough USDC.");
      }
      if (reason.includes("caller must be the payee")) {
        return new ApiError(400, "wrong_payee", "The authorization names a different payee.");
      }
      if (reason) {
        return new ApiError(400, "rejected", reason);
      }
    }
  }
  return new ApiError(502, "submission_failed", "Could not submit the transaction. Please retry.");
}

/**
 * Simulates a fill without spending gas.
 *
 * Runs before every broadcast so invalid orders, stale quotes and empty inventory cost the
 * relayer nothing and produce a precise error for the caller.
 */
export async function simulateFill(
  client: PublicClient,
  fuelAddress: Address,
  relayerAddress: Address,
  order: Order,
  signature: Hex,
): Promise<bigint> {
  try {
    const {result} = await client.simulateContract({
      address: fuelAddress,
      abi: hypeFuelAbi,
      functionName: "fill",
      args: [order, signature],
      account: relayerAddress,
    });
    return result;
  } catch (error) {
    throw toApiError(error);
  }
}

/**
 * Broadcasts a fill, retrying when a concurrent submission takes our nonce.
 *
 * @returns The transaction hash, plus the HYPE the simulation says will be delivered.
 */
export async function submitFill(
  relayer: Relayer,
  fuelAddress: Address,
  order: Order,
  signature: Hex,
): Promise<{transactionHash: Hex; hypeOut: bigint}> {
  const run = async () => {
    const hypeOut = await simulateFill(
      relayer as unknown as PublicClient,
      fuelAddress,
      relayer.account.address,
      order,
      signature,
    );

    let gasLimit: bigint;
    try {
      const estimate = await relayer.estimateContractGas({
        address: fuelAddress,
        abi: hypeFuelAbi,
        functionName: "fill",
        args: [order, signature],
        account: relayer.account,
      });
      gasLimit = (estimate * GAS_LIMIT_MULTIPLIER) / 100n;
    } catch {
      // Simulation already succeeded, so fall back to a generous fixed ceiling. This stays
      // well inside HyperEVM's 2M small-block limit.
      gasLimit = 400_000n;
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_NONCE_ATTEMPTS; attempt++) {
      try {
        const nonce = await relayer.getTransactionCount({
          address: relayer.account.address,
          blockTag: "pending",
        });
        const transactionHash = await relayer.writeContract({
          address: fuelAddress,
          abi: hypeFuelAbi,
          functionName: "fill",
          args: [order, signature],
          gas: gasLimit,
          nonce,
        });
        return {transactionHash, hypeOut};
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message.toLowerCase() : "";
        const nonceCollision =
          message.includes("nonce") ||
          message.includes("already known") ||
          message.includes("replacement transaction underpriced");
        if (!nonceCollision) break;
        // Brief, increasing backoff so the competing transaction can land first.
        await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
      }
    }
    throw toApiError(lastError);
  };

  // Chain onto any in-flight submission in this isolate, but never let one failure
  // poison the queue for the next caller.
  const queued = submissionChain.then(run, run);
  submissionChain = queued.catch(() => undefined);
  return queued;
}

export {toApiError};
