import {isAddress, isHex, type Address, type Hex} from "viem";
import {deserializeOrder, type Order} from "@hypefuel/sdk";

import {badRequest} from "./http.js";

/** Largest order the API will consider, regardless of contract limits. */
const ABSOLUTE_MAX_USDC = 1_000_000_000n; // $1,000

export function parseAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw badRequest("invalid_address", `${field} must be a checksummed EVM address`);
  }
  return value;
}

export function parseHex(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !isHex(value)) {
    throw badRequest("invalid_hex", `${field} must be a 0x-prefixed hex string`);
  }
  return value;
}

/**
 * Parses an unsigned integer supplied as a decimal string, hex string or JS number.
 *
 * Amounts arrive as strings because they exceed `Number.MAX_SAFE_INTEGER`; accepting a number
 * as well keeps small integers like `usdcIn` convenient for hand-written requests.
 */
export function parseUint(value: unknown, field: string): bigint {
  let parsed: bigint;
  try {
    if (typeof value === "bigint") parsed = value;
    else if (typeof value === "number") {
      if (!Number.isInteger(value)) throw new Error("not an integer");
      parsed = BigInt(value);
    } else if (typeof value === "string" && value.trim() !== "") {
      parsed = BigInt(value.trim());
    } else {
      throw new Error("unsupported type");
    }
  } catch {
    throw badRequest("invalid_amount", `${field} must be an unsigned integer`);
  }
  if (parsed < 0n) throw badRequest("invalid_amount", `${field} must not be negative`);
  return parsed;
}

export function parseUsdcIn(value: unknown): bigint {
  const usdcIn = parseUint(value, "usdcIn");
  if (usdcIn === 0n) throw badRequest("invalid_amount", "usdcIn must be greater than zero");
  if (usdcIn > ABSOLUTE_MAX_USDC) {
    throw badRequest("amount_too_large", "usdcIn exceeds the maximum this service supports");
  }
  return usdcIn;
}

/** Validates and normalises an order supplied by a client. */
export function parseOrder(value: unknown): Order {
  if (typeof value !== "object" || value === null) {
    throw badRequest("invalid_order", "order must be an object");
  }
  const raw = value as Record<string, unknown>;

  const order = deserializeOrder({
    user: parseAddress(raw.user, "order.user"),
    usdcIn: parseUint(raw.usdcIn, "order.usdcIn").toString(),
    minHypeOut: parseUint(raw.minHypeOut, "order.minHypeOut").toString(),
    validAfter: parseUint(raw.validAfter, "order.validAfter").toString(),
    validBefore: parseUint(raw.validBefore, "order.validBefore").toString(),
    salt: parseHex(raw.salt, "order.salt"),
  });

  if (order.salt.length !== 66) {
    throw badRequest("invalid_order", "order.salt must be 32 bytes");
  }
  if (order.validBefore <= order.validAfter) {
    throw badRequest("invalid_order", "order.validBefore must be after order.validAfter");
  }

  // Reject expiry we cannot act on before spending gas on a simulation.
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (order.validBefore <= now + 2n) {
    throw badRequest("order_expired", "This order has expired. Request a fresh quote.");
  }
  if (order.validAfter >= now) {
    throw badRequest("order_not_yet_valid", "This order is not valid yet");
  }

  return order;
}

export function parseSignature(value: unknown): Hex {
  const signature = parseHex(value, "signature");
  // 65-byte ECDSA, or longer for an ERC-1271 contract wallet.
  if (signature.length < 132) {
    throw badRequest("invalid_signature", "signature is too short to be valid");
  }
  return signature;
}
