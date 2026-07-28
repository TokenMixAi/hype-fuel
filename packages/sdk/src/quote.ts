import {BPS, HYPE_DECIMALS, USDC_DECIMALS, USDC_TO_HYPE_SCALE} from "./constants.js";
import type {FuelConfig, Quote} from "./types.js";

/**
 * Fee charged on an order: a percentage, floored at a flat minimum.
 *
 * The floor covers fixed per-fill costs on dust orders. Mirrors `HypeFuel.feeFor`.
 */
export function feeFor(
  usdcIn: bigint,
  config: Pick<FuelConfig, "feeBps" | "minFeeUsdc">,
): bigint {
  const percentageFee = (usdcIn * BigInt(config.feeBps)) / BPS;
  return percentageFee < config.minFeeUsdc ? config.minFeeUsdc : percentageFee;
}

/**
 * Prices an order. Mirrors `HypeFuel.quote` exactly, including integer truncation, so a
 * client-side preview always matches what the contract will pay out at the same price.
 */
export function quote(
  usdcIn: bigint,
  priceUsd1e8: bigint,
  config: Pick<FuelConfig, "feeBps" | "minFeeUsdc">,
): Quote {
  if (priceUsd1e8 <= 0n) throw new Error("Invalid HYPE price");

  const feeUsdc = feeFor(usdcIn, config);
  if (feeUsdc >= usdcIn) {
    throw new Error(
      `Order of ${formatUsdc(usdcIn)} USDC does not cover the ${formatUsdc(feeUsdc)} USDC fee`,
    );
  }

  const hypeOut = ((usdcIn - feeUsdc) * USDC_TO_HYPE_SCALE) / priceUsd1e8;

  return {
    usdcIn,
    feeUsdc,
    hypeOut,
    priceUsd1e8,
    effectiveFeePct: Number((feeUsdc * 1_000_000n) / usdcIn) / 10_000,
  };
}

/**
 * Applies a slippage tolerance to a quote to produce the `minHypeOut` to sign.
 *
 * Some tolerance is required because the fill is priced by the oracle at execution time,
 * which is necessarily later than the quote.
 *
 * @param slippageBps Tolerance in basis points. Defaults to 1%.
 */
export function minHypeOutFor(quoted: bigint, slippageBps = 100): bigint {
  if (slippageBps < 0 || slippageBps >= Number(BPS)) {
    throw new Error("slippageBps must be between 0 and 9999");
  }
  return (quoted * (BPS - BigInt(slippageBps))) / BPS;
}

/** Largest order the contract could currently fill, given its HYPE inventory. */
export function maxFillableUsdc(config: FuelConfig, priceUsd1e8: bigint): bigint {
  const affordable = (config.hypeBalance * priceUsd1e8) / USDC_TO_HYPE_SCALE;
  // Inventory bounds the net amount, so add the fee back to get the gross order size.
  const gross = (affordable * BPS) / (BPS - BigInt(config.feeBps));
  return gross < config.maxOrderUsdc ? gross : config.maxOrderUsdc;
}

/** Formats USDC base units as a decimal string. */
export function formatUsdc(amount: bigint, decimalPlaces = 2): string {
  return formatUnits(amount, USDC_DECIMALS, decimalPlaces);
}

/** Formats HYPE wei as a decimal string. */
export function formatHype(amount: bigint, decimalPlaces = 4): string {
  return formatUnits(amount, HYPE_DECIMALS, decimalPlaces);
}

/** Formats a 1e8-scaled USD price. */
export function formatPrice(priceUsd1e8: bigint): string {
  return formatUnits(priceUsd1e8, 8, 2);
}

function formatUnits(amount: bigint, decimals: number, decimalPlaces: number): string {
  const negative = amount < 0n;
  const value = negative ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = value / base;

  if (decimalPlaces === 0) return `${negative ? "-" : ""}${whole}`;

  const fraction = ((value % base) * 10n ** BigInt(decimalPlaces)) / base;
  const padded = fraction.toString().padStart(decimalPlaces, "0");
  return `${negative ? "-" : ""}${whole}.${padded}`;
}

/** Parses a decimal USDC string such as "12.50" into base units. */
export function parseUsdc(value: string): bigint {
  const trimmed = value.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    throw new Error(`Not a valid USDC amount: ${value}`);
  }
  const [whole, fraction = ""] = trimmed.split(".");
  const padded = fraction.padEnd(USDC_DECIMALS, "0").slice(0, USDC_DECIMALS);
  return BigInt(whole || "0") * 10n ** BigInt(USDC_DECIMALS) + BigInt(padded || "0");
}
