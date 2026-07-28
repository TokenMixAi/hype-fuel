import {NATIVE_USDC_ADDRESS, type Address} from "@hypefuel/sdk";

/**
 * Relayer API base URL. Override per environment with `VITE_API_URL`.
 *
 * The deployed values are the defaults so a plain `pnpm build` produces a working site; both
 * are public information.
 */
export const API_URL: string = (
  import.meta.env.VITE_API_URL ?? "https://api.hypefuel.me"
).replace(/\/+$/, "");

/** Deployed HypeFuel proxy. The app reads the authoritative value from `/v1/config`. */
export const FUEL_ADDRESS = (import.meta.env.VITE_FUEL_ADDRESS ??
  "0x42b06b1d9a07Fc3925C518dbf9475E7cA80DC8DF") as Address;

export const USDC_ADDRESS = NATIVE_USDC_ADDRESS;

/** Defined in content/site.ts, which the build also reads, and re-exported so callers have one import. */
export {PRODUCT_NAME} from "./content/site";

export const GITHUB_URL = "https://github.com/chase-mew/hype-fuel";

/** Amounts offered as one-tap presets, in whole USDC. */
export const PRESET_AMOUNTS = [2, 5, 10, 25] as const;

/** Amount prefilled on load. Reduced automatically when inventory cannot cover it. */
export const DEFAULT_AMOUNT = "10";
