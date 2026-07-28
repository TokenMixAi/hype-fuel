# Security

HypeFuel holds funds. The contract custodies a HYPE float and the USDC it takes in, and the relayer
holds a hot key that pays gas for every fill. Please treat findings accordingly.

## Reporting a vulnerability

Report privately first. Do not open a public issue, and do not demonstrate an exploit against
mainnet.

- Use GitHub's [private vulnerability reporting](https://github.com/chase-mew/hype-fuel/security/advisories/new).
- If that is unavailable, email chase@manning.dev with "HypeFuel security" in the subject.

Please include what you need to make the finding reproducible: the affected component, the
conditions required, and the impact you believe it has. A failing Foundry test against a fork is the
most useful thing you can send.

Expect an acknowledgement within 72 hours. There is no bug bounty programme, so this rests on
goodwill; credit in the advisory is offered to anyone who wants it.

## Scope

In scope:

- `packages/contracts/src/` and the deployed proxy at
  [`0x42b06b1d9a07Fc3925C518dbf9475E7cA80DC8DF`](https://hyperevmscan.io/address/0x42b06b1d9a07Fc3925C518dbf9475E7cA80DC8DF).
- The relayer API at `api.hypefuel.me` and its source in `packages/api/`.
- `packages/sdk/`, where a signing or quoting bug would mislead an integrator.

Out of scope:

- Vendored dependencies under `packages/contracts/lib/`. Report those upstream.
- The economics of the fee itself, and the fact that the owner can pause, withdraw and upgrade.
  Those are documented properties rather than defects. See the trust assumptions below.
- Denial of service that requires flooding the public RPC or Cloudflare.

## What a user is trusting

Worth stating plainly, because it frames what actually counts as a vulnerability:

- **The owner key can upgrade the implementation.** A UUPS proxy means the owner can change the
  logic behind a fixed address, so users are trusting that key not to be misused or lost. This is
  the largest trust assumption in the system.
- **The owner can pause fills and withdraw contract funds.** Neither can take USDC that a user has
  not already signed away.
- **A signature cannot be stretched.** Each EIP-3009 authorisation names the contract as the only
  payee, covers one exact amount, works once, and expires within minutes. The order's fields are
  bound into the authorisation nonce, so altering any of them invalidates the signature.
- **Pricing is not ours to choose.** Rates come from HyperCore oracle precompiles read during the
  swap, and the signed `minHypeOut` is the user's floor. If it cannot be met, the fill reverts.
- **The relayer is not a dependency.** `fill` is permissionless. If the relayer disappears, a user
  can submit their own authorisation, and `rebalance()` can be called by anyone.

## Not audited

No third-party audit has been done. The contract is small and covered by the test suite in
`packages/contracts/test/`, including fork tests against live oracles, but that is not a substitute.
Size your usage accordingly.
