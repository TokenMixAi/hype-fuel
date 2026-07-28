# HypeFuel

**Swap USDC for native HYPE on HyperEVM without holding any gas.**

HyperEVM charges gas in HYPE. Bridge in stablecoins and hold no HYPE, and you are stuck: you
cannot swap for HYPE, because swapping needs gas. Gas.zip and SmolRefuel do not cover HyperEVM,
so people end up with a wallet full of money they cannot move.

HypeFuel fixes that. The user signs one message — no transaction, no gas — and a relayer
broadcasts it, taking their USDC and delivering native HYPE in the same transaction.

| | |
|---|---|
| App | https://hypefuel-web.chase-63b.workers.dev |
| API | https://hypefuel-api.chase-63b.workers.dev |
| Contract | [`0x38454AF33e64bf74789e2d4d9b80E4F90ff0D861`](https://hyperevmscan.io/address/0x38454AF33e64bf74789e2d4d9b80E4F90ff0D861) |
| Chain | HyperEVM mainnet (999) |

## How it works

The central constraint is that a wallet with no gas cannot send a transaction, so it cannot
emit an on-chain event either. Watching the chain for user intent is therefore impossible; the
authorization has to reach us off-chain, which is what the relayer API is for.

```
User                       Relayer API                  HypeFuel contract
 |                              |                              |
 |-- POST /v1/quote ----------->|-- quote() ------------------->| reads HYPE price from
 |<-- order + price ------------|<------------------------------| HyperCore precompiles
 |                              |                              |
 | sign EIP-3009 (no gas)       |                              |
 |-- POST /v1/fill ------------>|-- fill(order, sig) --------->| pulls USDC via EIP-3009,
 |                              |   (relayer pays gas)         | sends HYPE to the signer
 |<-- HYPE in wallet -----------|                              |
```

### One signature covers the whole order

Payment uses **EIP-3009 `receiveWithAuthorization`** rather than EIP-2612 `permit`. It moves
tokens in a single atomic step, carries its own expiry, and refuses to execute unless the caller
is the named payee — so the signature is safe to hand to a relayer, because only the HypeFuel
contract can ever spend it.

EIP-3009 signs over a fixed set of fields: `(from, to, value, validAfter, validBefore, nonce)`.
None of them can carry order data such as `minHypeOut`. HypeFuel resolves this by **deriving the
authorization's `nonce` from a hash of the entire order**:

```solidity
nonce = keccak256(abi.encode(ORDER_TYPEHASH, user, usdcIn, minHypeOut, validAfter, validBefore, salt));
```

Because the token verifies the signature over that nonce, tampering with any field changes the
nonce and invalidates the signature. One signature commits to the whole order, and the token's
own `authorizationState` mapping provides replay protection for free.

### Pricing

The contract reads HYPE's price on-chain from Hyperliquid's HyperCore precompiles at execution
time, via [`hyper-evm-lib`](https://github.com/hyperliquid-dev/hyper-evm-lib):

- `oraclePx` (`0x…807`) for the HYPE perp — the validator-median price, expensive to manipulate.
- `spotPx` (`0x…808`) for HYPE/USDC spot — a cross-check.

Fills revert if the two feeds disagree by more than `maxOracleDeviationBps`, and the contract
prices at the **higher** of the two, so pushing either feed down cannot extract extra HYPE. An
attacker would have to move both feeds at once.

### Fees

**3% of the amount, with a $0.15 minimum**, capped on-chain at 5% and $1.00 by immutable
constants that governance cannot exceed.

The flat floor exists because per-fill costs do not scale with order size. A live mainnet fill
costs about **$0.0009** in gas (159k gas at ~0.3 gwei), so the floor is not really about gas —
it is about making a $1 top-up worth processing at all. The percentage takes over above $5.

| Order | Fee | Effective |
|---|---|---|
| $1 | $0.15 | 15% |
| $5 | $0.15 | 3% (crossover) |
| $10 | $0.30 | 3% |
| $50 | $1.50 | 3% |

## Layout

```
packages/
  contracts/   Foundry. HypeFuel.sol plus 48 tests, including fork tests against real USDC.
  sdk/         @hypefuel/sdk — order encoding, typed data, quote math. Browser/Node/Workers.
  api/         Cloudflare Worker relayer. Quote, simulate, broadcast.
  web/         Vite + React app: landing page, swap UI, integration docs.
```

The SDK is shared by the API and the web app, so the order encoding and quote arithmetic exist
in exactly one place on the TypeScript side.

## Development

Requires [Foundry](https://getfoundry.sh), Node 22+ and pnpm 9+. Wrangler 4 refuses to run on
older Node versions, so deploying needs 22.

```bash
git clone --recurse-submodules https://github.com/chase-mew/hype-fuel
cd hype-fuel
pnpm install
pnpm --filter @hypefuel/sdk build   # the API and web app import the built SDK

pnpm test                            # contracts + SDK
pnpm dev:web                         # web app on :5173
pnpm dev:api                         # relayer on :8787
```

### Testing

```bash
cd packages/contracts
forge test --no-match-path 'test/*.fork.t.sol'   # hermetic, no network
forge test --match-path 'test/*.fork.t.sol'      # against real mainnet USDC and live oracles
```

Two suites, deliberately:

- **Hermetic tests** run against `MockUSDC`, a faithful reimplementation of Circle's
  FiatTokenV2_2 behaviour. Fast and offline.
- **Fork tests** run the same scenarios against the real token and live precompiles. These exist
  to prove the mock is faithful — both suites assert the same output values, so a divergence
  from mainnet shows up as a failure rather than a surprise in production.

The order commitment hash is pinned to a shared vector asserted in **both**
`HypeFuel.t.sol` and the SDK's test suite. If the Solidity and TypeScript encoders ever
diverge, that fails in CI instead of silently rejecting every signature the frontend produces.

There are also two live scripts that spend real funds:

```bash
PRIVATE_KEY=0x… FUEL_ADDRESS=0x… bun packages/api/scripts/live-fill.ts 2      # direct contract
PRIVATE_KEY=0x… API_URL=https://…  bun packages/api/scripts/live-api-fill.ts 3 # through the API
```

## Deployment

### Contract

```bash
cd packages/contracts
PRIVATE_KEY=0x… forge script script/Deploy.s.sol:Deploy --rpc-url hyperevm --broadcast
```

Deployment costs ~1.54M gas, which fits inside HyperEVM's 2M small-block limit, so no big-block
toggle is needed.

### Relayer and web app

```bash
cd packages/api
wrangler secret put RELAYER_PRIVATE_KEY     # never committed, never exposed to CI
wrangler deploy

cd ../web
pnpm build && wrangler deploy
```

Set `FUEL_ADDRESS` in `packages/api/wrangler.jsonc` after deploying the contract.
`.github/workflows/deploy.yml` does both automatically on push to `main`, given
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets.

`CLOUDFLARE_ACCOUNT_ID` is already set. To finish wiring up automatic deploys, create a token
with the **Edit Cloudflare Workers** template at
<https://dash.cloudflare.com/profile/api-tokens> and add it:

```bash
gh secret set CLOUDFLARE_API_TOKEN
```

Until then, deploy by hand with the commands above; the workflow reaches Cloudflare and stops
there.

## Operating it

The contract holds HYPE inventory and accumulates USDC from fills.

```bash
# Add HYPE inventory (plain transfer)
cast send $FUEL --value 1ether --private-key $PK --rpc-url hyperevm

# Collect USDC revenue
cast send $FUEL "withdrawUsdc(address,uint256)" $TREASURY $AMOUNT --private-key $PK

# Recover HYPE
cast send $FUEL "withdrawHype(address,uint256)" $TREASURY $AMOUNT --private-key $PK

# Emergency stop; withdrawals keep working while paused
cast send $FUEL "setPaused(bool)" true --private-key $PK
```

Two balances need watching: the **contract's HYPE** (inventory, quoted as `insufficient_liquidity`
when short) and the **relayer EOA's HYPE** (gas). At ~$0.0009 per fill, a small relayer balance
lasts a long time.

## Design decisions worth knowing

**HYPE always goes to the signer.** There is no separate recipient field. Adding one would let a
malicious integrator redirect a user's funds while showing them a legitimate-looking prompt;
locking the destination to the payer makes that impossible.

**`fill` is permissionless.** Every fill is profitable for the contract by construction, so
anyone can relay one. That removes us as a liveness bottleneck — if our relayer goes down, users
or integrators can submit orders themselves with any funded wallet.

**Fee ceilings are immutable.** `MAX_FEE_BPS` and `MAX_MIN_FEE_USDC` are constants, so a signer
can bound their worst case without trusting the owner.

**Smart-contract wallets work.** USDC's `bytes`-signature overload validates through a checker
that understands ERC-1271, so Safe and ERC-4337 accounts can sign too.

## Security notes

Not audited. The contract is small and covered by 48 tests, but it holds funds — treat the
inventory as at-risk capital and keep it sized to demand.

The main economic risk is oracle manipulation, mitigated by using the validator-median perp
oracle, cross-checking it against spot, pricing at the higher feed, and capping order size.
`setPaused` is the emergency stop.

## Licence

MIT
