import {
  encodeAbiParameters,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";

import {
  DEFAULT_ORDER_TTL_SECONDS,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  USDC_EIP712_DOMAIN,
} from "./constants.js";
import type {Order, SerializedOrder} from "./types.js";

/**
 * `keccak256` of the order struct signature. Must match `HypeFuel.ORDER_TYPEHASH`.
 */
export const ORDER_TYPEHASH: Hex = keccak256(
  toHex(
    "HypeFuelOrder(address user,uint256 usdcIn,uint256 minHypeOut,uint256 validAfter,uint256 validBefore,bytes32 salt)",
  ),
);

const ORDER_ABI_PARAMETERS = [
  {type: "bytes32"},
  {type: "address"},
  {type: "uint256"},
  {type: "uint256"},
  {type: "uint256"},
  {type: "uint256"},
  {type: "bytes32"},
] as const;

/**
 * Derives the EIP-3009 nonce for an order.
 *
 * EIP-3009 signs over `(from, to, value, validAfter, validBefore, nonce)`, which has no room
 * for order data such as `minHypeOut`. Deriving the nonce from the order instead means the
 * token's signature check transitively covers every field: change anything and the nonce
 * changes, so the signature no longer validates.
 *
 * Must produce byte-identical output to `HypeFuel.orderNonce`.
 */
export function orderNonce(order: Order): Hex {
  return keccak256(
    encodeAbiParameters(ORDER_ABI_PARAMETERS, [
      ORDER_TYPEHASH,
      order.user,
      order.usdcIn,
      order.minHypeOut,
      order.validAfter,
      order.validBefore,
      order.salt,
    ]),
  );
}

/** Cryptographically random salt, so repeat orders get distinct nonces. */
export function randomSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export interface BuildOrderOptions {
  user: Address;
  usdcIn: bigint;
  minHypeOut: bigint;
  /** Seconds the order stays valid. Defaults to five minutes. */
  ttlSeconds?: number;
  /** Override the clock, mainly for tests. */
  nowSeconds?: number;
  salt?: Hex;
}

export function buildOrder(options: BuildOrderOptions): Order {
  const now = BigInt(options.nowSeconds ?? Math.floor(Date.now() / 1000));
  const ttl = BigInt(options.ttlSeconds ?? DEFAULT_ORDER_TTL_SECONDS);

  return {
    user: options.user,
    usdcIn: options.usdcIn,
    minHypeOut: options.minHypeOut,
    // Backdated a minute so a slow block clock cannot reject a fresh order.
    validAfter: now - 60n,
    validBefore: now + ttl,
    salt: options.salt ?? randomSalt(),
  };
}

/**
 * The EIP-712 payload for the user to sign, ready to hand to `signTypedData`.
 *
 * @param fuelAddress The HypeFuel contract, which becomes the authorisation's payee. USDC
 *   requires `msg.sender == to`, so a signed order can only ever be spent there.
 */
export function buildAuthorizationTypedData(order: Order, fuelAddress: Address) {
  return {
    domain: USDC_EIP712_DOMAIN,
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: order.user,
      to: fuelAddress,
      value: order.usdcIn,
      validAfter: order.validAfter,
      validBefore: order.validBefore,
      nonce: orderNonce(order),
    },
  } as const;
}

export function serializeOrder(order: Order): SerializedOrder {
  return {
    user: order.user,
    usdcIn: order.usdcIn.toString(),
    minHypeOut: order.minHypeOut.toString(),
    validAfter: order.validAfter.toString(),
    validBefore: order.validBefore.toString(),
    salt: order.salt,
  };
}

export function deserializeOrder(order: SerializedOrder): Order {
  return {
    user: order.user,
    usdcIn: BigInt(order.usdcIn),
    minHypeOut: BigInt(order.minHypeOut),
    validAfter: BigInt(order.validAfter),
    validBefore: BigInt(order.validBefore),
    salt: order.salt,
  };
}
