import {encodeAbiParameters, toFunctionSelector, type Hex} from "viem";
import {afterEach, describe, expect, it, vi} from "vitest";

import type {Env} from "./env.js";
import {describeKeeperResult, runKeeper} from "./keeper.js";

const RPC_URL = "https://rpc.example.invalid/evm";

const PENDING_SELECTOR = toFunctionSelector("pendingRebalanceUsdc() view returns (uint256)");
const REBALANCE_SELECTOR = toFunctionSelector("rebalance() returns (uint256, uint256)");

const SENT_TRANSACTION_HASH = `0x${"ab".repeat(32)}` as Hex;

/** Values from the first production rebalance, so the numbers here are real ones. */
const USDC_IN = 20_000_000n;
const HYPE_OUT = 365_013_514_398_910_610n;

const env: Env = {
  RELAYER_PRIVATE_KEY: `0x${"11".repeat(32)}`,
  FUEL_ADDRESS: "0x42b06b1d9a07Fc3925C518dbf9475E7cA80DC8DF",
  RPC_URL,
};

interface RpcCall {
  method: string;
  params: unknown[];
}

/**
 * Stands in for HyperEVM at the JSON-RPC boundary.
 *
 * Stubbing `fetch` rather than injecting a transport keeps the keeper's own wiring under test: it
 * really does read the precondition, simulate, sign and broadcast here.
 *
 * @param pendingUsdc What `pendingRebalanceUsdc` should report.
 * @param calls Collects every request, so tests can assert on what was *not* sent.
 */
function mockRpc(pendingUsdc: bigint, calls: RpcCall[] = []) {
  const uint256s = (...values: bigint[]) =>
    encodeAbiParameters(
      values.map(() => ({type: "uint256"}) as const),
      values,
    );

  return vi.fn(async (_url: unknown, init?: {body?: string}) => {
    const {method, params = []} = JSON.parse(init?.body ?? "{}") as {
      method: string;
      params?: unknown[];
    };
    calls.push({method, params});

    const respond = (result: unknown) =>
      new Response(JSON.stringify({jsonrpc: "2.0", id: 1, result}), {
        headers: {"content-type": "application/json"},
      });

    switch (method) {
      case "eth_chainId":
        return respond("0x3e7");
      case "eth_call": {
        const {data} = params[0] as {data: Hex};
        if (data.startsWith(PENDING_SELECTOR)) return respond(uint256s(pendingUsdc));
        if (data.startsWith(REBALANCE_SELECTOR)) return respond(uint256s(pendingUsdc, HYPE_OUT));
        throw new Error(`unexpected eth_call ${data}`);
      }
      case "eth_estimateGas":
        return respond("0x28323"); // 164,643, what a real rebalance costs.
      case "eth_getTransactionCount":
        return respond("0x1");
      case "eth_gasPrice":
        return respond("0x5f5e100");
      case "eth_getBlockByNumber":
        return respond({number: "0x1", baseFeePerGas: null, gasLimit: "0x2dc6c0"});
      case "eth_sendRawTransaction":
        return respond(SENT_TRANSACTION_HASH);
      default:
        // A real node answers an unsupported method rather than dropping the connection, and
        // viem probes a few optional ones. Throwing here would make it retry instead.
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: {code: -32601, message: `the method ${method} does not exist`},
          }),
          {headers: {"content-type": "application/json"}},
        );
    }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runKeeper", () => {
  it("does nothing, and spends nothing, while inventory is above the floor", async () => {
    const calls: RpcCall[] = [];
    vi.stubGlobal("fetch", mockRpc(0n, calls));

    expect(await runKeeper(env, RPC_URL)).toEqual({status: "idle"});

    // The point of leaning on a single precondition: an idle run must not simulate, estimate or
    // broadcast anything.
    expect(calls.map((call) => call.method)).toEqual(["eth_call"]);
  });

  it("rebalances when the contract reports pending USDC", async () => {
    vi.stubGlobal("fetch", mockRpc(USDC_IN));

    expect(await runKeeper(env, RPC_URL)).toEqual({
      status: "rebalanced",
      transactionHash: SENT_TRANSACTION_HASH,
      usdcIn: USDC_IN,
      hypeOut: HYPE_OUT,
    });
  });

  it("simulates before broadcasting, so a doomed rebalance costs no gas", async () => {
    const calls: RpcCall[] = [];
    vi.stubGlobal("fetch", mockRpc(USDC_IN, calls));

    await runKeeper(env, RPC_URL);

    const methods = calls.map((call) => call.method);
    expect(methods).toContain("eth_sendRawTransaction");
    expect(methods.indexOf("eth_call")).toBeLessThan(methods.indexOf("eth_sendRawTransaction"));
  });

  it("refuses to run without a valid contract address", async () => {
    vi.stubGlobal("fetch", mockRpc(0n));

    await expect(runKeeper({...env, FUEL_ADDRESS: "not-an-address"}, RPC_URL)).rejects.toThrow(
      /contract address/,
    );
  });
});

describe("describeKeeperResult", () => {
  it("names the no-op case plainly", () => {
    expect(describeKeeperResult({status: "idle"})).toContain("nothing to do");
  });

  it("reports the amounts and the transaction, for an audit trail", () => {
    const line = describeKeeperResult({
      status: "rebalanced",
      transactionHash: SENT_TRANSACTION_HASH,
      usdcIn: USDC_IN,
      hypeOut: HYPE_OUT,
    });

    expect(line).toContain("$20.00");
    expect(line).toContain("0.3650 HYPE");
    expect(line).toContain(SENT_TRANSACTION_HASH);
  });
});
