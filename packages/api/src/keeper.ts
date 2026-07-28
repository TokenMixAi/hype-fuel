import {
  createHyperEvmClient,
  fetchPendingRebalanceUsdc,
  formatHype,
  formatUsdc,
  hypeFuelAbi,
  type Hex,
} from "@hypefuel/sdk";

import {fuelAddress, type Env} from "./env.js";
import {createRelayer} from "./relayer.js";

/** Headroom over the estimate, since both the oracle and the pool are read at execution time. */
const GAS_LIMIT_MULTIPLIER = 130n;

export type KeeperResult =
  | {status: "idle"}
  | {status: "rebalanced"; transactionHash: Hex; usdcIn: bigint; hypeOut: bigint};

/**
 * Converts accumulated USDC back into HYPE inventory, on a schedule.
 *
 * `HypeFuel.rebalance` is permissionless and unrewarded, so this holds no privilege the contract
 * cares about, and only pays gas. That is why it runs on the relayer key rather than one of its
 * own: the same account already funds every fill, so there is one HYPE balance to watch instead
 * of two. The cost is that a rebalance can take a nonce a fill wanted, which {@link submitFill}
 * already retries through.
 *
 * The keeper is a convenience, not a dependency. If it stops, inventory still refills the moment
 * any user calls `rebalance` themselves.
 */
export async function runKeeper(env: Env, rpcUrl: string): Promise<KeeperResult> {
  const fuel = fuelAddress(env);
  const client = createHyperEvmClient(rpcUrl);

  // This one read reproduces every precondition in `rebalance`, so a zero means there is
  // genuinely nothing to do rather than something to retry.
  const pendingUsdc = await fetchPendingRebalanceUsdc(client, fuel);
  if (pendingUsdc === 0n) return {status: "idle"};

  const keeper = createRelayer(env.RELAYER_PRIVATE_KEY, rpcUrl);

  // Simulating first means a skewed pool, or a price that moved mid-block, costs nothing and
  // reports why, rather than burning gas to reach the same revert.
  const {result} = await keeper.simulateContract({
    address: fuel,
    abi: hypeFuelAbi,
    functionName: "rebalance",
    account: keeper.account,
  });
  const [usdcIn, hypeOut] = result;

  const estimate = await keeper.estimateContractGas({
    address: fuel,
    abi: hypeFuelAbi,
    functionName: "rebalance",
    account: keeper.account,
  });

  const transactionHash = await keeper.writeContract({
    address: fuel,
    abi: hypeFuelAbi,
    functionName: "rebalance",
    gas: (estimate * GAS_LIMIT_MULTIPLIER) / 100n,
  });

  return {status: "rebalanced", transactionHash, usdcIn, hypeOut};
}

/** One line per run, so the cron history reads as an audit log. */
export function describeKeeperResult(result: KeeperResult): string {
  if (result.status === "idle") return "keeper: inventory above the floor, nothing to do";
  return (
    `keeper: swapped $${formatUsdc(result.usdcIn)} for ${formatHype(result.hypeOut)} HYPE ` +
    `in ${result.transactionHash}`
  );
}
