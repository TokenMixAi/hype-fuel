import {http, createConfig} from "wagmi";
import {injected} from "wagmi/connectors";
import {hyperEvm} from "@hypefuel/sdk";

/**
 * Wallet configuration.
 *
 * Injected connectors only (MetaMask, Rabby, OKX and friends). WalletConnect would need a
 * project id from an external dashboard, so it is deliberately left out until that is set up.
 */
export const wagmiConfig = createConfig({
  chains: [hyperEvm],
  connectors: [injected()],
  transports: {
    [hyperEvm.id]: http(),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
