import {
  DEFAULT_ORDER_TTL_SECONDS,
  buildAuthorizationTypedData,
  buildOrder,
  createHyperEvmClient,
  fetchConfig,
  fetchHypePrice,
  fetchQuote,
  fetchUsdcBalance,
  formatHype,
  formatPrice,
  formatUsdc,
  maxFillableUsdc,
  minHypeOutFor,
  orderNonce,
  serializeOrder,
  HYPEREVM_RPC_URL,
  type Order,
} from "@hypefuel/sdk";
import {isAddress, type Address, type Hex, type PublicClient} from "viem";

import type {Env} from "./env.js";
import {
  ApiError,
  badRequest,
  corsHeaders,
  errorResponse,
  json,
  readJsonObject,
} from "./http.js";
import {createRelayer, submitFill} from "./relayer.js";
import {parseAddress, parseOrder, parseSignature, parseUint, parseUsdcIn} from "./validate.js";

/** Default slippage applied to quotes, in basis points. */
const DEFAULT_SLIPPAGE_BPS = 100;

function fuelAddress(env: Env): Address {
  const address = env.FUEL_ADDRESS;
  if (!address || !isAddress(address)) {
    throw new ApiError(500, "misconfigured", "The relayer is not configured with a contract address");
  }
  return address;
}

async function enforceRateLimit(request: Request, env: Env): Promise<void> {
  if (!env.RATE_LIMITER) return;
  const key = request.headers.get("CF-Connecting-IP") ?? "anonymous";
  const {success} = await env.RATE_LIMITER.limit({key});
  if (!success) {
    throw new ApiError(429, "rate_limited", "Too many requests. Please slow down.");
  }
}

/** GET /v1/config - contract parameters, live inventory and the current HYPE price. */
async function handleConfig(client: PublicClient, env: Env) {
  const address = fuelAddress(env);
  const config = await fetchConfig(client, address);

  // Reading the oracle can revert when the two feeds disagree. That should degrade the
  // price preview, not take the whole config endpoint down.
  let priceUsd1e8: bigint | null = null;
  try {
    priceUsd1e8 = await fetchHypePrice(client, address);
  } catch {
    priceUsd1e8 = null;
  }

  const fillable = priceUsd1e8 === null ? null : maxFillableUsdc(config, priceUsd1e8);

  return {
    chainId: 999,
    hypePriceUsd1e8: priceUsd1e8?.toString() ?? null,
    hypePriceFormatted: priceUsd1e8 ? formatPrice(priceUsd1e8) : null,
    contract: address,
    usdc: config.usdc,
    fee: {
      bps: config.feeBps,
      percent: config.feeBps / 100,
      minUsdc: config.minFeeUsdc.toString(),
      minUsdcFormatted: formatUsdc(config.minFeeUsdc),
      maxBpsEverAllowed: config.maxFeeBps,
      description: `${config.feeBps / 100}% of the amount, with a minimum of $${formatUsdc(config.minFeeUsdc)}`,
    },
    limits: {
      minUsdc: config.minOrderUsdc.toString(),
      maxUsdc: config.maxOrderUsdc.toString(),
      minUsdcFormatted: formatUsdc(config.minOrderUsdc),
      maxUsdcFormatted: formatUsdc(config.maxOrderUsdc),
      // The contract's configured ceiling is only reachable while inventory covers it, so
      // quote against this instead to avoid signing orders that must revert.
      maxFillableUsdc: fillable?.toString() ?? null,
      maxFillableUsdcFormatted: fillable === null ? null : formatUsdc(fillable),
    },
    inventory: {
      hypeWei: config.hypeBalance.toString(),
      hypeFormatted: formatHype(config.hypeBalance),
    },
    paused: config.paused,
  };
}

/**
 * POST /v1/quote - price an amount and return the exact payload to sign.
 *
 * Numeric fields in `typedData` are strings so the response is valid JSON. That is also the
 * format `eth_signTypedData_v4` expects, so the payload can be passed straight to a wallet.
 */
async function handleQuote(request: Request, client: PublicClient, env: Env) {
  const body = await readJsonObject(request);
  const address = fuelAddress(env);

  const usdcIn = parseUsdcIn(body.usdcIn);
  const user = parseAddress(body.user, "user");
  const slippageBps = body.slippageBps === undefined
    ? DEFAULT_SLIPPAGE_BPS
    : Number(parseUint(body.slippageBps, "slippageBps"));
  if (slippageBps > 5_000) {
    throw badRequest("invalid_slippage", "slippageBps must be 5000 or less");
  }
  const ttlSeconds = body.ttlSeconds === undefined
    ? DEFAULT_ORDER_TTL_SECONDS
    : Number(parseUint(body.ttlSeconds, "ttlSeconds"));
  if (ttlSeconds < 30 || ttlSeconds > 3_600) {
    throw badRequest("invalid_ttl", "ttlSeconds must be between 30 and 3600");
  }

  const config = await fetchConfig(client, address);
  if (config.paused) {
    throw new ApiError(503, "paused", "The service is paused.");
  }
  if (usdcIn < config.minOrderUsdc || usdcIn > config.maxOrderUsdc) {
    throw badRequest(
      "order_size",
      `Amount must be between $${formatUsdc(config.minOrderUsdc)} and $${formatUsdc(config.maxOrderUsdc)}`,
      {minUsdc: config.minOrderUsdc.toString(), maxUsdc: config.maxOrderUsdc.toString()},
    );
  }

  // Price on-chain so the preview reflects the same oracle read the fill will perform.
  const {hypeOut, feeUsdc, priceUsd1e8} = await fetchQuote(client, address, usdcIn);

  if (hypeOut > config.hypeBalance) {
    const fillable = maxFillableUsdc(config, priceUsd1e8);
    throw new ApiError(
      503,
      "insufficient_liquidity",
      `We only hold enough HYPE for about $${formatUsdc(fillable)} right now. Please try less.`,
      {
        availableHypeWei: config.hypeBalance.toString(),
        maxFillableUsdc: fillable.toString(),
      },
    );
  }

  const usdcBalance = await fetchUsdcBalance(client, user, config.usdc);
  if (usdcBalance < usdcIn) {
    throw badRequest(
      "insufficient_usdc",
      `That wallet holds $${formatUsdc(usdcBalance)} USDC, which is less than the $${formatUsdc(usdcIn)} requested.`,
      {balance: usdcBalance.toString()},
    );
  }

  const order = buildOrder({
    user,
    usdcIn,
    minHypeOut: minHypeOutFor(hypeOut, slippageBps),
    ttlSeconds,
  });
  const typedData = buildAuthorizationTypedData(order, address);

  return {
    order: serializeOrder(order),
    nonce: orderNonce(order),
    quote: {
      usdcIn: usdcIn.toString(),
      usdcInFormatted: formatUsdc(usdcIn),
      feeUsdc: feeUsdc.toString(),
      feeUsdcFormatted: formatUsdc(feeUsdc),
      hypeOut: hypeOut.toString(),
      hypeOutFormatted: formatHype(hypeOut),
      minHypeOut: order.minHypeOut.toString(),
      priceUsd1e8: priceUsd1e8.toString(),
      slippageBps,
      expiresAt: Number(order.validBefore),
    },
    typedData: {
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: {
        from: typedData.message.from,
        to: typedData.message.to,
        value: typedData.message.value.toString(),
        validAfter: typedData.message.validAfter.toString(),
        validBefore: typedData.message.validBefore.toString(),
        nonce: typedData.message.nonce,
      },
    },
  };
}

/** POST /v1/fill - broadcast a signed order. */
async function handleFill(request: Request, env: Env, rpcUrl: string) {
  const body = await readJsonObject(request);
  const address = fuelAddress(env);

  const order: Order = parseOrder(body.order);
  const signature: Hex = parseSignature(body.signature);

  const relayer = createRelayer(env.RELAYER_PRIVATE_KEY, rpcUrl);
  const {transactionHash, hypeOut} = await submitFill(relayer, address, order, signature);

  return {
    transactionHash,
    explorerUrl: `https://hyperevmscan.io/tx/${transactionHash}`,
    user: order.user,
    usdcIn: order.usdcIn.toString(),
    hypeOut: hypeOut.toString(),
    hypeOutFormatted: formatHype(hypeOut),
    nonce: orderNonce(order),
  };
}

/** GET /v1/status/:hash - receipt lookup so clients can confirm delivery. */
async function handleStatus(client: PublicClient, hash: string) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw badRequest("invalid_hash", "Expected a 32-byte transaction hash");
  }

  try {
    const receipt = await client.getTransactionReceipt({hash: hash as Hex});
    return {
      status: receipt.status === "success" ? "confirmed" : "failed",
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      transactionHash: receipt.transactionHash,
    };
  } catch {
    // No receipt yet means it is still queued rather than missing.
    return {status: "pending", transactionHash: hash};
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const headers = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, {status: 204, headers});
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const rpcUrl = env.RPC_URL ?? HYPEREVM_RPC_URL;

    try {
      const client = createHyperEvmClient(rpcUrl);

      if (request.method === "GET" && (path === "/" || path === "/v1")) {
        return json(
          {
            name: "HypeFuel relayer",
            description: "Swap USDC for native HYPE on HyperEVM without holding any gas.",
            docs: "https://hypefuel.xyz/docs",
            endpoints: {
              "GET /v1/config": "Fee schedule, order limits and HYPE inventory",
              "POST /v1/quote": "Price an amount and get the payload to sign",
              "POST /v1/fill": "Broadcast a signed order",
              "GET /v1/status/:hash": "Check a transaction",
            },
          },
          {headers},
        );
      }

      if (request.method === "GET" && path === "/v1/health") {
        const blockNumber = await client.getBlockNumber();
        return json({status: "ok", blockNumber: blockNumber.toString()}, {headers});
      }

      if (request.method === "GET" && path === "/v1/config") {
        return json(await handleConfig(client, env), {headers});
      }

      if (request.method === "POST" && path === "/v1/quote") {
        await enforceRateLimit(request, env);
        return json(await handleQuote(request, client, env), {headers});
      }

      if (request.method === "POST" && path === "/v1/fill") {
        await enforceRateLimit(request, env);
        return json(await handleFill(request, env, rpcUrl), {headers});
      }

      if (request.method === "GET" && path.startsWith("/v1/status/")) {
        return json(await handleStatus(client, path.slice("/v1/status/".length)), {headers});
      }

      throw new ApiError(404, "not_found", `No route for ${request.method} ${path}`);
    } catch (error) {
      return errorResponse(error, headers);
    }
  },
};
