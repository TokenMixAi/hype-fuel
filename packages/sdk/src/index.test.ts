import {describe, expect, it} from "vitest";
import {keccak256, toHex} from "viem";

import {NATIVE_USDC_ADDRESS, USDC_EIP712_DOMAIN} from "./constants.js";
import {
  ORDER_TYPEHASH,
  buildAuthorizationTypedData,
  buildOrder,
  deserializeOrder,
  orderNonce,
  randomSalt,
  serializeOrder,
} from "./orders.js";
import {
  feeFor,
  formatHype,
  formatPrice,
  formatUsdc,
  maxFillableUsdc,
  minHypeOutFor,
  parseUsdc,
  quote,
} from "./quote.js";
import type {Order} from "./types.js";

const CONFIG = {feeBps: 300, minFeeUsdc: 150_000n};

/** $55.147, matching the Solidity test fixtures. */
const PRICE_1E8 = 5_514_700_000n;

const FIXED_ORDER: Order = {
  user: "0x00000000000000000000000000000000000000A1",
  usdcIn: 10_000_000n,
  minHypeOut: 175_000_000_000_000_000n,
  validAfter: 1_700_000_000n,
  validBefore: 1_700_000_300n,
  salt: "0x00000000000000000000000000000000000000000000000000000000000000ab",
};

describe("order commitment", () => {
  // Generated independently with `cast keccak` against the Solidity type string.
  it("derives the typehash the contract uses", () => {
    expect(ORDER_TYPEHASH).toBe(
      "0xd192ad1848188705258a695bfe11d9a874fcd7cad62c16b4a34ed4fcfb53fadb",
    );
  });

  /**
   * The load-bearing cross-language check. This vector came from `cast abi-encode` plus
   * `cast keccak`, i.e. Foundry's encoder rather than viem's, and `HypeFuel.orderNonce` is
   * asserted against the same value in Solidity. If TypeScript and Solidity ever diverge
   * here, every signature the frontend produces would be rejected on-chain.
   */
  it("matches the Solidity nonce for a known order", () => {
    expect(orderNonce(FIXED_ORDER)).toBe(
      "0x88617cefca486877573b0f731489b6fc12e46eaaa72ebf023d47f8ac762163f5",
    );
  });

  it("changes when any field changes", () => {
    const baseline = orderNonce(FIXED_ORDER);
    const mutations: Array<Partial<Order>> = [
      {user: "0x00000000000000000000000000000000000000A2"},
      {usdcIn: 10_000_001n},
      {minHypeOut: 175_000_000_000_000_001n},
      {validAfter: 1_700_000_001n},
      {validBefore: 1_700_000_301n},
      {salt: "0x00000000000000000000000000000000000000000000000000000000000000ac"},
    ];

    for (const mutation of mutations) {
      expect(orderNonce({...FIXED_ORDER, ...mutation})).not.toBe(baseline);
    }
  });

  it("is deterministic", () => {
    expect(orderNonce(FIXED_ORDER)).toBe(orderNonce({...FIXED_ORDER}));
  });
});

describe("buildOrder", () => {
  it("backdates validAfter so a lagging block clock cannot reject a fresh order", () => {
    const order = buildOrder({
      user: FIXED_ORDER.user,
      usdcIn: 10_000_000n,
      minHypeOut: 0n,
      nowSeconds: 1_700_000_000,
    });

    expect(order.validAfter).toBe(1_699_999_940n);
    expect(order.validBefore).toBe(1_700_000_300n);
  });

  it("honours a custom ttl", () => {
    const order = buildOrder({
      user: FIXED_ORDER.user,
      usdcIn: 1n,
      minHypeOut: 0n,
      nowSeconds: 1_000,
      ttlSeconds: 30,
    });
    expect(order.validBefore).toBe(1_030n);
  });

  it("generates distinct salts", () => {
    expect(randomSalt()).not.toBe(randomSalt());
  });
});

describe("authorization typed data", () => {
  const fuel = "0x00000000000000000000000000000000000000FF" as const;

  it("targets the USDC domain verified on mainnet", () => {
    const typedData = buildAuthorizationTypedData(FIXED_ORDER, fuel);

    expect(typedData.domain).toEqual({
      name: "USDC",
      version: "2",
      chainId: 999,
      verifyingContract: NATIVE_USDC_ADDRESS,
    });
    expect(USDC_EIP712_DOMAIN.verifyingContract).toBe(NATIVE_USDC_ADDRESS);
  });

  /** USDC enforces `msg.sender == to`, so this field is what makes the signature safe to publish. */
  it("names the fuel contract as the only possible payee", () => {
    const typedData = buildAuthorizationTypedData(FIXED_ORDER, fuel);
    expect(typedData.message.to).toBe(fuel);
    expect(typedData.message.from).toBe(FIXED_ORDER.user);
  });

  it("carries the commitment nonce", () => {
    const typedData = buildAuthorizationTypedData(FIXED_ORDER, fuel);
    expect(typedData.message.nonce).toBe(orderNonce(FIXED_ORDER));
  });
});

describe("fees", () => {
  it("charges the percentage above the crossover", () => {
    expect(feeFor(10_000_000n, CONFIG)).toBe(300_000n);
    expect(feeFor(50_000_000n, CONFIG)).toBe(1_500_000n);
  });

  it("applies the floor to dust", () => {
    expect(feeFor(1_000_000n, CONFIG)).toBe(150_000n);
    expect(feeFor(5_000_000n, CONFIG)).toBe(150_000n);
    expect(feeFor(6_000_000n, CONFIG)).toBe(180_000n);
  });
});

describe("quote", () => {
  /**
   * Must equal the value asserted in `HypeFuel.t.sol`, since the frontend previews with this
   * function and the contract pays out with its Solidity twin.
   */
  it("reproduces the Solidity result exactly", () => {
    const result = quote(10_000_000n, PRICE_1E8, CONFIG);

    expect(result.feeUsdc).toBe(300_000n);
    expect(result.hypeOut).toBe(175_893_520_953_089_016n);
  });

  it("reports the effective fee percentage", () => {
    expect(quote(10_000_000n, PRICE_1E8, CONFIG).effectiveFeePct).toBeCloseTo(3, 5);
    // The floor makes dust proportionally more expensive.
    expect(quote(1_000_000n, PRICE_1E8, CONFIG).effectiveFeePct).toBeCloseTo(15, 5);
  });

  it("rejects orders that cannot cover the fee", () => {
    expect(() => quote(100_000n, PRICE_1E8, CONFIG)).toThrow(/does not cover/);
  });

  it("rejects a nonsensical price", () => {
    expect(() => quote(10_000_000n, 0n, CONFIG)).toThrow(/Invalid HYPE price/);
  });

  it("never returns more HYPE than the input is worth", () => {
    for (const usdcIn of [1_000_000n, 7_500_000n, 10_000_000n, 50_000_000n]) {
      const result = quote(usdcIn, PRICE_1E8, CONFIG);
      const valueOut = (result.hypeOut * PRICE_1E8) / 10n ** 20n;
      expect(valueOut).toBeLessThanOrEqual(usdcIn - result.feeUsdc);
    }
  });
});

describe("minHypeOutFor", () => {
  it("applies the tolerance", () => {
    expect(minHypeOutFor(1_000_000n, 100)).toBe(990_000n);
    expect(minHypeOutFor(1_000_000n, 0)).toBe(1_000_000n);
  });

  it("defaults to one percent", () => {
    expect(minHypeOutFor(1_000_000n)).toBe(990_000n);
  });

  it("rejects nonsense tolerances", () => {
    expect(() => minHypeOutFor(1n, -1)).toThrow();
    expect(() => minHypeOutFor(1n, 10_000)).toThrow();
  });
});

describe("maxFillableUsdc", () => {
  const config = {
    usdc: NATIVE_USDC_ADDRESS,
    feeBps: 300,
    minFeeUsdc: 150_000n,
    minOrderUsdc: 1_000_000n,
    maxOrderUsdc: 50_000_000n,
    maxOracleDeviationBps: 500,
    maxFeeBps: 500,
    paused: false,
    hypeBalance: 0n,
  };

  it("is capped by the configured maximum when inventory is deep", () => {
    expect(maxFillableUsdc({...config, hypeBalance: 1_000n * 10n ** 18n}, PRICE_1E8)).toBe(
      50_000_000n,
    );
  });

  it("is capped by inventory when HYPE is scarce", () => {
    // 0.1 HYPE at $55.147 is about $5.51.
    const result = maxFillableUsdc({...config, hypeBalance: 10n ** 17n}, PRICE_1E8);
    expect(result).toBeGreaterThan(5_400_000n);
    expect(result).toBeLessThan(5_700_000n);
  });
});

describe("formatting", () => {
  it("formats USDC", () => {
    expect(formatUsdc(10_000_000n)).toBe("10.00");
    expect(formatUsdc(150_000n)).toBe("0.15");
    expect(formatUsdc(1_234_567n)).toBe("1.23");
  });

  it("formats HYPE", () => {
    expect(formatHype(175_893_520_953_089_016n)).toBe("0.1758");
    expect(formatHype(10n ** 18n)).toBe("1.0000");
  });

  it("formats prices", () => {
    expect(formatPrice(PRICE_1E8)).toBe("55.14");
  });

  it("round-trips through parseUsdc", () => {
    expect(parseUsdc("10")).toBe(10_000_000n);
    expect(parseUsdc("10.50")).toBe(10_500_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
    // Excess precision is truncated rather than rounded, matching the contract's integers.
    expect(parseUsdc("1.23456789")).toBe(1_234_567n);
  });

  it("rejects junk", () => {
    expect(() => parseUsdc("abc")).toThrow();
    expect(() => parseUsdc("")).toThrow();
    expect(() => parseUsdc("1.2.3")).toThrow();
  });
});

describe("serialization", () => {
  it("round-trips an order through JSON", () => {
    const json = JSON.parse(JSON.stringify(serializeOrder(FIXED_ORDER)));
    expect(deserializeOrder(json)).toEqual(FIXED_ORDER);
  });

  it("preserves the nonce across the round trip", () => {
    const restored = deserializeOrder(serializeOrder(FIXED_ORDER));
    expect(orderNonce(restored)).toBe(orderNonce(FIXED_ORDER));
  });
});

describe("typehash derivation", () => {
  it("is the keccak of the struct signature", () => {
    expect(ORDER_TYPEHASH).toBe(
      keccak256(
        toHex(
          "HypeFuelOrder(address user,uint256 usdcIn,uint256 minHypeOut,uint256 validAfter,uint256 validBefore,bytes32 salt)",
        ),
      ),
    );
  });
});
