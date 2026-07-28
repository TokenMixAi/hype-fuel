import {defineChain} from "viem";
import {HYPEREVM_CHAIN_ID, HYPEREVM_RPC_URL} from "@hypefuel/sdk";

export function hyperEvmChain(rpcUrl: string = HYPEREVM_RPC_URL) {
  return defineChain({
    id: HYPEREVM_CHAIN_ID,
    name: "HyperEVM",
    nativeCurrency: {name: "HYPE", symbol: "HYPE", decimals: 18},
    rpcUrls: {default: {http: [rpcUrl]}},
    blockExplorers: {default: {name: "HyperEVMScan", url: "https://hyperevmscan.io"}},
  });
}
