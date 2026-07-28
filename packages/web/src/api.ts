import {deserializeOrder, serializeOrder, type Address, type Hex, type Order} from "@hypefuel/sdk";

import {API_URL} from "./config";

/** An error carrying the relayer's machine-readable code alongside its message. */
export class RelayerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "RelayerError";
  }
}

interface ErrorBody {
  error?: {code?: string; message?: string; details?: unknown};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {"Content-Type": "application/json", ...init?.headers},
    });
  } catch {
    throw new RelayerError("network", "Could not reach the relayer. Check your connection.");
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new RelayerError("bad_response", "The relayer returned an unreadable response.");
  }

  if (!response.ok) {
    const {error} = body as ErrorBody;
    throw new RelayerError(
      error?.code ?? "http_error",
      error?.message ?? `Request failed with status ${response.status}`,
      error?.details,
    );
  }

  return body as T;
}

export interface ConfigResponse {
  contract: Address;
  usdc: Address;
  /** Null when the oracle feeds disagree and pricing is temporarily unavailable. */
  hypePriceUsd1e8: string | null;
  hypePriceFormatted: string | null;
  fee: {
    bps: number;
    percent: number;
    minUsdc: string;
    minUsdcFormatted: string;
    description: string;
  };
  limits: {
    minUsdc: string;
    maxUsdc: string;
    /** Configured max clamped by live HYPE inventory. Null when the oracle is unavailable. */
    maxFillableUsdc: string | null;
    maxFillableUsdcFormatted: string | null;
    minUsdcFormatted: string;
    maxUsdcFormatted: string;
  };
  inventory: {hypeWei: string; hypeFormatted: string};
  paused: boolean;
}

export interface QuoteResponse {
  order: Order;
  quote: {
    usdcIn: bigint;
    feeUsdc: bigint;
    hypeOut: bigint;
    minHypeOut: bigint;
    priceUsd1e8: bigint;
    expiresAt: number;
  };
}

interface RawQuoteResponse {
  order: {
    user: Address;
    usdcIn: string;
    minHypeOut: string;
    validAfter: string;
    validBefore: string;
    salt: Hex;
  };
  quote: {
    usdcIn: string;
    feeUsdc: string;
    hypeOut: string;
    minHypeOut: string;
    priceUsd1e8: string;
    expiresAt: number;
  };
}

export function fetchRelayerConfig(): Promise<ConfigResponse> {
  return request<ConfigResponse>("/v1/config");
}

export async function fetchQuote(params: {
  user: Address;
  usdcIn: bigint;
  slippageBps?: number;
}): Promise<QuoteResponse> {
  const raw = await request<RawQuoteResponse>("/v1/quote", {
    method: "POST",
    body: JSON.stringify({
      user: params.user,
      usdcIn: params.usdcIn.toString(),
      slippageBps: params.slippageBps,
    }),
  });

  return {
    order: deserializeOrder(raw.order),
    quote: {
      usdcIn: BigInt(raw.quote.usdcIn),
      feeUsdc: BigInt(raw.quote.feeUsdc),
      hypeOut: BigInt(raw.quote.hypeOut),
      minHypeOut: BigInt(raw.quote.minHypeOut),
      priceUsd1e8: BigInt(raw.quote.priceUsd1e8),
      expiresAt: raw.quote.expiresAt,
    },
  };
}

export interface FillResponse {
  transactionHash: Hex;
  explorerUrl: string;
  hypeOut: string;
  hypeOutFormatted: string;
}

export function submitFill(order: Order, signature: Hex): Promise<FillResponse> {
  return request<FillResponse>("/v1/fill", {
    method: "POST",
    body: JSON.stringify({order: serializeOrder(order), signature}),
  });
}

export interface StatusResponse {
  status: "pending" | "confirmed" | "failed";
  transactionHash: Hex;
}

export function fetchStatus(hash: Hex): Promise<StatusResponse> {
  return request<StatusResponse>(`/v1/status/${hash}`);
}
