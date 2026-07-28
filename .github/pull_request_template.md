## What this changes

<!-- What it does and why. If it fixes an issue, link it. -->

## How it was verified

<!--
Which tests you ran, and any new ones you added. For a contract change, a test that fails before
the fix and passes after is the most useful thing here.
-->

## Checklist

- [ ] `pnpm test` and `pnpm typecheck` pass
- [ ] `pnpm lint` passes (no em dashes, en dashes or curly quotes)
- [ ] `forge fmt` run, if Solidity changed
- [ ] The diff covers one concern, with no unrelated reformatting
- [ ] Storage layout is append-only, if `HypeFuel.sol` gained state
