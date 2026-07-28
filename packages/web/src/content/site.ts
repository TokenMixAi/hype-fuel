/**
 * Copy that has to exist twice: once rendered for people, once mirrored into the document head as
 * structured data for search engines. Keeping both readings in one file is what stops them
 * drifting apart, and `vite.config.ts` reads from here at build time to emit the JSON-LD.
 *
 * Plain data only, no imports. The Vite config pulls this in outside a browser.
 */

export const SITE_URL = "https://hypefuel.me";

/** Re-exported by config.ts, so app code can keep importing it from there. */
export const PRODUCT_NAME = "HypeFuel";

/**
 * Titles lead with the problem rather than the brand, because nobody searches for a name they have
 * never heard. "no gas", "HyperEVM" and "USDC" are the words people actually type when they are
 * stranded.
 */
export const SITE_TITLE = "HypeFuel | Get HYPE for gas on HyperEVM using only USDC";

export const SITE_DESCRIPTION =
  "Stranded on HyperEVM with USDC and no HYPE for gas? Sign one message and native HYPE arrives " +
  "in seconds. No gas to pay, no approval, no bridging.";

/** Shorter and punchier, since social cards get far less room than a search result. */
export const SOCIAL_TITLE = "Out of gas on HyperEVM? Get HYPE using only USDC";

export const SOCIAL_DESCRIPTION =
  "Sign one message and native HYPE lands in your wallet seconds later. Nothing to approve and no " +
  "gas to pay, so an empty wallet is no longer a dead end.";

export const OG_IMAGE_ALT =
  "HypeFuel: get HYPE for gas on HyperEVM using only USDC, from $1 to $50 with a 3% fee.";

export interface Route {
  path: string;
  title: string;
  description: string;
  /** Weight for sitemap.xml, highest first. */
  priority: string;
  /** Shown on social cards for this route. Falls back to the site-wide pair. */
  socialTitle?: string;
  socialDescription?: string;
}

export const ROUTES: Route[] = [
  {
    path: "/",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    priority: "1.0",
  },
  {
    path: "/app",
    title: "Swap USDC for HYPE on HyperEVM | HypeFuel",
    description:
      "Swap USDC for native HYPE on HyperEVM without holding any gas. Connect a wallet, sign one " +
      "message, and HYPE arrives in seconds.",
    priority: "0.9",
    socialTitle: "Swap USDC for HYPE, no gas required",
  },
  {
    path: "/docs",
    title: "API and SDK docs | Gasless HYPE on HyperEVM | HypeFuel",
    description:
      "Integrate gasless HYPE top-ups on HyperEVM. Quote, sign an EIP-3009 authorisation and fill " +
      "through the public relayer API, or call the contract directly.",
    priority: "0.7",
    socialTitle: "HypeFuel docs: gasless HYPE top-ups on HyperEVM",
    socialDescription:
      "Quote, sign an EIP-3009 USDC authorisation and fill through the public relayer API, or skip " +
      "the relayer and call the contract yourself.",
  },
];

export interface FaqEntry {
  q: string;
  a: string;
}

/** Rendered on the landing page and emitted as FAQPage structured data. */
export const FAQ: FaqEntry[] = [
  {
    q: "How can I do this without any HYPE for gas?",
    a: "You never send a transaction. You sign a message, which happens entirely inside your wallet and touches no blockchain. We broadcast the resulting transaction and pay the gas from our own wallet.",
  },
  {
    q: "What exactly am I authorising?",
    a: "A single EIP-3009 transfer authorisation for the precise USDC amount you chose. It names our contract as the only possible recipient, expires in a few minutes, and can be used once. It is not a blanket approval, so we cannot come back for more later.",
  },
  {
    q: "How is the HYPE price decided?",
    a: "On-chain, by the contract itself. It reads HYPE's price directly from Hyperliquid's HyperCore oracle precompiles at the moment of execution and cross-checks the perp oracle against the spot market. We cannot choose the rate you get.",
  },
  {
    q: "What stops the price moving against me?",
    a: "Your signature commits to a minimum amount of HYPE. If the market moves so far that you would receive less than that, the transaction reverts and your USDC stays exactly where it is.",
  },
  {
    q: "Do I have to use this website?",
    a: "No. The contract is permissionless and the relayer is a plain HTTP API, so any wallet or app can integrate it directly. The docs cover the whole flow.",
  },
  {
    q: "Is this affiliated with Hyperliquid?",
    a: "No. HypeFuel is an independent project that happens to build on HyperEVM and read Hyperliquid's public oracle precompiles.",
  },
];
