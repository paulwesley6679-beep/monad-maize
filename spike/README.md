# SPIKE: SPIKE token + Kuru market + executed trade on Monad testnet

Technical spike for the Monad Metropolis project. Everything here runs on
**Monad testnet (chain id `10143`)** — no mainnet, no real value.

Goal: on testnet, deploy a placeholder ERC-20 (`SPIKE`, 18 decimals) as the
_base_ and a second self-deployed, mintable, 6-decimal ERC-20 (`MOCKUSD`) as the
_quote_, create a Kuru orderbook market for `SPIKE/MOCKUSD` through the official
Router, place one post-only limit order (maker) and one fill-or-kill market
order (taker) so a real trade executes, and verify everything on-chain.

Using a self-deployed quote token removes the only external dependency (the
official testnet USDC has no public mint) — the only outside input needed is a
little testnet MON for gas.

```
┌─────────────┐   ┌──────────────────────────────────────────────────────┐
│ spike.ts    │──▶│ 1. Deploy SPIKE (SpikeToken.sol, 18 dec)             │
│ (npm run    │   │ 2. Deploy MOCKUSD (MockUSD.sol, 6 dec) — the quote   │
│  spike)     │   │ 3. Router.deployProxy → SPIKE/MOCKUSD market         │
│             │   │ 4. Deposit MOCKUSD into MarginAccount (maker bid)    │
│             │   │ 5. GTC.placeLimit  BUY 1000 SPIKE @ 0.001, postOnly  │
│             │   │ 6. IOC.placeMarket SELL 900 SPIKE (fill-or-kill)     │
│             │   │ 7. Verify: Trade events, L2 book, balances, s_orders │
└─────────────┘   └──────────────────────────────────────────────────────┘
```

## Status

- [x] All official Kuru testnet addresses verified live via `eth_getCode`
      (`scripts/probe.ts`)
- [x] SPIKE + MOCKUSD compile and deploy (`scripts/compile.ts`,
      `contracts/*.sol`)
- [x] Preflight + funding gate implemented and tested (script stops with
      clear instructions when the wallet has no MON)
- [x] **Full end-to-end executed on-chain** (2026-09-11) — see
      [Executed run](#executed-run--on-chain-artifacts)

## Executed run — on-chain artifacts

All deployed/traded by `npm run spike` on Monad testnet with the disposable
wallet `0x0f2a7EAd457b6bbe6d6a47f5470D722ABAcb58da`:

| Step | Address / tx | Notes |
|---|---|---|
| SPIKE token | `0xf006DfDa51cD5aA065D88D76FB2f334f55c8D4E4` | deploy `0xe9961f12…b03747` |
| MOCKUSD token | `0x528A2eB86BBf65C0FDD7d7811fc3a618B17A2934` | deploy `0x832e21f6…7cc875`, 1,000,000 minted to deployer |
| SPIKE/MOCKUSD market | `0x99304360eDd53451fd0A07316dDb00fdDA7B0F16` | deploy `0x8cb6c634…b0497937`; vault `0xA6D3E93963Ff1097bFf3ccBc83688FcB2aF92B77` |
| Margin deposit | `0xaebd525e…cf31b65` | 2 MOCKUSD into MarginAccount |
| Limit buy (maker) | `0xe8cb47f6…e479307` | orderId 3, 1000 SPIKE @ 0.001 post-only |
| Market sell (taker) | `0x1deb01d1…c54e79` | 900 SPIKE @ 0.001, filled 9000000 raw (= 900 SPIKE) |

Last run's verification output:

```
Order book after trade:  bids: [[0.001, 300]]   asks: []
wallet SPIKE   : 997300.0
wallet MOCKUSD : 999994.6919
maker order struct (s_orders): size 3000000 raw = 300 SPIKE, price 1000 raw = 0.001, isBuy true
```

The maker bid rests because we sell 900 of the 1000 bought (post-trade the
order holds the remaining 300 after previous runs' fills — each `npm run spike`
re-run places a fresh bid and sells against the old rest first, which is exactly
how a real book behaves). Balances reconcile exactly with the math in
[The trade plan](#the-trade-plan).

## Core product contracts — on-chain artifacts (Task 02)

The core mzNGN product contracts (`PriceOracle`, `MzngnToken`, `CollateralVault`,
plus a fresh `MockUSD` collateral instance) were deployed on Monad testnet by
`npm run core` with the same disposable wallet:

| Contract | Address | Deploy tx |
|---|---|---|
| PriceOracle | `0x914265f10042c56020205c4258ec19f99024e6a5` | `0xdeafaaa8…8888a7d` |
| MockUSD (collateral, 6 dp) | `0xe4d3bd26ab76f5e7a21122feeec0bc0d86547e2e` | `0xb00ea59f…e20bb5a` |
| MzngnToken (18 dp) | `0x7f895bf9bbe1ef044af95c3c6d1d842e96cda8f7` | `0x8a823baf…e0f43c` |
| CollateralVault | `0x5eee7da8bdb8680da889502f655c5c2a5bc9cddb` | `0x650a33fb…93e647d` |
| `setVault` (vault→token) | — | `0xa99507d2…b38b53d2` |
| initial price publish (50.00 mUSD/bag) | — | `0xdd66751b…c5fd2d` |

Product rule (from the spec): 1 mzNGN = current reference price of one 100 kg bag
of maize in mUSD; the vault mints mzNGN against mUSD at **150% collateralization**
with a **single authorized** oracle publisher.

Mint/redeem math (full-precision `mulDiv`, OZ 512-bit):
`minted18 = mulDiv(deposit6, 2e18, price6 * 3)`, `payout6 = mulDiv(burn18, price6 * 3, 2e18)`.
Worked example at price **50.00**: deposit **150 mUSD → 2.0 mzNGN** (tx
`0x7eef5ed2…39c150`, re-proven `0xfb33bb58…6daf7`); burn **1.0 mzNGN → 75.00
mUSD** (tx `0x642f814a…f27e74`, re-proven `0xb2f9a976…8bc22fa`). 2/3 of the
deposit is leverage, 1/3 is margin — exactly 150%.

Verified rejection cases (each reverted as intended, `eth_call` simulation +
custom-error/`Error(string)` shape check):

| Case | Expect | Result |
|---|---|---|
| oracle-unauthorized | `NotAuthorized` | ok |
| oracle-zero-price | `ZeroPrice` | ok |
| oracle-wild-up (>30% move) | `TooLargeMove` | ok |
| oracle-wild-down (>30% move) | `TooLargeMove` | ok |
| vault-mint-below-min (<1.00 mUSD) | `InsufficientCollateral` | ok |
| vault-mint-no-allowance | `MockUSD: allowance exceeded` | ok |
| vault-over-redeem (burn > balance) | `mzNGN: burn exceeds balance` | ok |

Staleness: enforced on **reads** — `getPrice()` reverts with `StalePrice` once
`block.timestamp - updatedAt > stalenessWindow` (48 h in production, 60 s in the
test probe). Proven with a 60 s-window probe oracle
(`0x2819f38a4aef2b219f5790450d8dcce201cb91f7`): an in-band +10% publish was
accepted, and `getPrice()` reverted after window expiry (runs 1–3).

Decisions & deviations (flagged for the orchestrator):

- `mockUSD` reuses the spike's `MockUSD.sol` source but was deployed as a
  **fresh instance** (the spike instance has a different role — market quote).
- `stalenessWindow` is constructor-injectable; production value 48 h.
- Initial price 50.00 mUSD/bag is a worked-example anchor (real NBS reference
  ≈ 53 mUSD/bag at ₦1,600/$) — publish an updated price via `updatePrice` when
  launching.
- `MIN_COLLATERAL = 1.00 mUSD` dust guard on mint.
- **No liquidation mechanism** — out of scope for this task, flagged as a known
  MVP limitation.
- Staleness enforced on reads, not as a hard cap on `updatePrice` (the publisher
  can bump the price even from a stale baseline — interpreted from the spec).

Gas note: the testnet gateway bills ~`gasLimit × (baseFee + priorityFee)` per
broadcast, so a low wallet balance blocks even small txs. The wallet
(`0x0f2a7EAd…b58da`) now holds **~19.38 MON** after completing this task. Fund
from `https://faucet.monad.xyz` when low.

## Task 05 — mzNGN on a real Kuru orderbook (on-chain)

Lists the real `MZNGN / MOCKUSD` market on the official Kuru testnet orderbook,
ties the Task 02 product contracts (PriceOracle, MockUSD, MzngnToken,
CollateralVault) into the Task 01 Kuru infrastructure, and executes a real
on-chain trade.

```
┌─────────────────┐   ┌───────────────────────────────────────────────────────────────┐
│ list-on-kuru.ts │──▶│ 1. Verify Task 02 contracts are live (eth_getCode)           │
│ (npm run        │   │ 2. Vault mint top-up: deposit mUSD → mint mzNGN (Task 03)    │
│  list-on-kuru)  │   │ 3. ParamCreator.deployMarket (Router.deployProxy)            │
│                 │   │ 4. MarginAccount deposits (mUSD for bid, mzNGN for ask)      │
│                 │   │ 5. GTC.placeLimit BUY 20 mzNGN @ 61.44 (post-only, maker)   │
│                 │   │ 6. GTC.placeLimit SELL 20 mzNGN @ 61.50144 (post-only)       │
│                 │   │ 7. IOC.placeMarket SELL 15 mzNGN (fill-or-kill, taker)       │
│                 │   │ 8. Verify: Trade events, L2 book, s_orders, balances         │
└─────────────────┘   └───────────────────────────────────────────────────────────────┘
```

### Market parameters

Anchor: `1 mzNGN = 61.44 mUSD`. The oracle last published **61.438026
mUSD/bag** (Task 02, staleness window 48 h). The anchor `61.44` is the nearest
book-aligned tick (0.003% above spot), computed via
`ParamCreator.calculatePrecisions(quote=6144, base=100, maxPrice=200, minSize=1, tickBps=10)`:

| Parameter | Value | Meaning |
|---|---|---|
| `pricePrecision` | `100_000` | 5 decimal places in mUSD per mzNGN |
| `sizePrecision` | `10_000_000` | 7 decimal places in mzNGN |
| `tickSize` | `6144` | `0.06144 mUSD` (0.1% = 10 bps) |
| `minSize` | `10_000_000` | `1 mzNGN` |
| `maxSize` | `1_000_000_000` | `100 mzNGN` per order |
| `takerFeeBps` / `makerFeeBps` | `30` / `10` | taker 0.3%, maker 0.1% |
| `kuruAmmSpread` | `100` | 1% AMM spread |

Grid check (on-chain): `61.44` = `tickSize × 1000` ✓ aligned;
`61.50144` = `tickSize × 1001` ✓ aligned.

### On-chain artifacts

Executed by `npm run list-on-kuru` on Monad testnet (2026-09-17):

| Step | Address / tx | Notes |
|---|---|---|
| Vault top-up (Task 03 path) | tx `0xb0a5da…212e04` | deposit 3000 mUSD → 32.55 mzNGN minted |
| MZNGN/MOCKUSD market | `0xad98efa71fa8f13cb7ed7d0a9fa43257077a7b17` | deploy tx `0x8062b9…a753f4` |
| AMM vault (Kuru) | `0xbff9Db42a9F35AC7b748721eFd83912CBCe0430C` | created with market |
| Margin deposit (quote) | tx `0x5743b7…eb279a3` | 1400 mUSD → funds maker bid |
| Margin deposit (base) | tx `0xfa10ff…0e11fe` | 25 mzNGN → funds maker ask |
| Limit BUY (maker, postOnly) | tx `0x30746d…58d71` | orderId 7, 20 mzNGN @ 61.44 |
| Limit SELL (maker, postOnly) | tx `0x3e3ed3…3020c6` | orderId 8, 20 mzNGN @ 61.50144 |
| Market SELL (taker, FoK) | tx `0x90bf1c…882be` | 15 mzNGN @ 61.44, filled 15e7 raw |

Trade result (from `Trade` event — `orderId=7`, `price=61440000000000000000`
= **61.44** in 18-dec "wei" scale):

```
Order book after trade:  bids: [[61.44, 5]]   asks: [[61.50144, 20]]
maker bid struct (s_orders): size 50000000 = 5.0 mzNGN, price 6144000 = 61.44, isBuy true
taker MOCKUSD gain: +918.8352 mUSD   (15 × 61.44 − 0.3% taker fee = 918.8352)
```

### Does Kuru have a testnet UI / explorer?

**No.** Kuru's product UI ([kuru.io](https://kuru.io), `kuru.io/markets`,
`exchange.kuru.io`) and WebSocket API (`ws.kuru.io`) are **mainnet-only** — they
do not expose a testnet interface. The Kuru documentation
([docs.kuru.io](https://docs.kuru.io)) documents contract addresses and the SDK
but does not list a testnet frontend or public API. The MZNGN/MOCKUSD market is
therefore **verifiable only on-chain**: via the contract/transaction links above
(MonadVision testnet explorer), the `getL2OrderBook` SDK reads, `s_orders`
structs, and `Trade` events — not via any Kuru-hosted web page.

### Re-runnability

```bash
npm run list-on-kuru   # each run places fresh orders; the book stacks
```

Set `MARKET_ADDRESS` to reuse an existing market instead of deploying a new one.
Set `LIST_FORCE_TOPUP=1` to always demonstrate the CollateralVault mint path
(deposit mUSD → mint mzNGN) even when the wallet already holds enough. All
other Task 02 contract addresses fall through to `src/config.ts` defaults (the
live deployments above) and can be overridden via `.env`.

## Addresses used (all from official docs)

| Item | Address / URL | Source |
|---|---|---|
| Monad testnet RPC | `https://testnet-rpc.monad.xyz` | https://docs.monad.xyz/developer-essentials/testnet |
| Chain id | `10143` (`0x279f`) | same |
| Explorer | `https://testnet.monadvision.com` | same |
| Kuru Router | `0x7EFbE105Ca7415dE98F96622173458ac1c054630` | https://docs.kuru.io/contracts/Contract-addresses |
| Kuru MarginAccount | `0xd029C2D98ff85D8F64799017fE00a59B1159CE02` | same |
| Kuru Forwarder | `0x681bB1508E14433b148a2549ba2726454aDc9BB4` | same |
| Kuru MonadDeployer | `0xDacd06372cEb638640c9D8466A023b7362324e1A` | same |
| KuruUtils | `0xE0841E0F06c5770C1D4930EC6C507ee33199C88C` | same |
| SPIKE token | deployed by the script | `contracts/SpikeToken.sol` |
| MOCKUSD token | deployed by the script | `contracts/MockUSD.sol` |
| SPIKE/MOCKUSD market | deployed by the script via Router | `ParamCreator.deployMarket` |

No address, RPC, or endpoint is invented: every constant in `src/config.ts`
carries its doc source in a comment.

## The trade plan

Market parameters (computed by `ParamCreator.calculatePrecisions(1, 1000, 0.01, 100, 10)`):

| Parameter | Value | Meaning |
|---|---|---|
| `pricePrecision` | `1_000_000` | price fixed at 6 decimals (MOCKUSD) |
| `sizePrecision` | `10_000` | size fixed at 4 decimals (SPIKE) |
| `tickSize` | `1` | `0.000001` MOCKUSD |
| `minSize` | `1_000_000` | `100` SPIKE |
| `maxSize` | `10_000_000_000` | `1_000_000` SPIKE |
| `takerFeeBps` / `makerFeeBps` | `30` / `10` | fees |
| `kuruAmmSpread` | `100` | 1% AMM spread |

Order flow:

1. Mint SPIKE (1,000,000) and MOCKUSD (1,000,000) to the wallet — both tokens
   are deployed by the script, nothing is needed from outside.
2. Deposit `2` MOCKUSD into the Kuru `MarginAccount` (powers the maker bid).
3. `GTC.placeLimit` — **maker**: BUY `1000` SPIKE @ `0.001` MOCKUSD,
   `postOnly: true` → `OrderCreated`, order rests in the book.
4. `IOC.placeMarket` — **taker**: SELL `900` SPIKE, `minAmountOut: 0.8`
   MOCKUSD, `fillOrKill: true` → fills `900` SPIKE @ `0.001` against the maker
   bid (`Trade` event: `filledSize = 9_000_000` raw, `price = 1000` raw).
5. Verify: `Trade` events on the sell receipt, L2 book (maker bid shrinks from
   `1000` to `100` SPIKE), wallet balances, and the maker order struct
   (`s_orders` — size/price are stored in precision units, i.e. `10^n`
   multipliers, so the reader formats with `log10(sizePrecision)` decimals).

Expected balances after one fresh run (approx):

- wallet SPIKE: `1_000_000 - 900 = 999_100`
- wallet MOCKUSD: `1_000_000 - 2 (deposit) + 0.8973 (900 × 0.001 − 0.3% taker fee) ≈ 999_998.8973`
- maker bid remaining: `100` SPIKE @ `0.001`

Fees observed: maker pays `makerFeeBps=10` on the fill, taker pays
`takerFeeBps=30`; both are deducted in the quote token.

## Funding prerequisites

The disposable test wallet (`0x0f2a7EAd457b6bbe6d6a47f5470D722ABAcb58da`,
see `.env`) only needs **testnet MON for gas**. It currently holds ~3 MON.
Funding is a one-time browser action:

- **Testnet MON (gas)** — `https://faucet.monad.xyz`. The faucet back-end
  (`https://faucet.molandak.org/api/v1/faucet`) requires a Cloudflare Turnstile
  token + FingerprintJS visitor id, so it cannot be automated with curl/CLI.

**No external USDC is needed** — the `SPIKE/MOCKUSD` market uses only the
self-deployed tokens that `spike.ts` mints itself.

> Earlier investigation (kept for context): the plan originally paired SPIKE
> against **Kuru's official testnet USDC** (`0x3bA3d39AFcf8bb994f7964B3e0171Ea2Ba361570`, the
> quote token of the official MON-USDC market), but that token has **no public
> mint** and its market/AMM are empty, so there was no scriptable way to acquire
> it. `scripts/usdc-check.ts` also proved the Circle/Monad-token-list USDC
> (`0x534b2f3A…`, a real FiatToken proxy) is a *different* token and cannot fund
> Kuru markets. Custom MOCKUSD removes the entire problem.

## How to run

```bash
cd spike
npm install          # already done; ethers 5.7.1, tsx, solc, @kuru-labs/kuru-sdk 0.0.95
cp .env.example .env # fill PRIVATE_KEY (disposable key already in .env)
npm run compile      # builds artifacts/*.json (all contracts in contracts/)
npm run spike        # end-to-end: deploy tokens+market, trade, verify
npm run core         # Task 02: deploy core product, mint/redeem loop, rejection harness
npm run list-on-kuru # Task 05: mzNGN on a real Kuru orderbook + executed trade
```

Re-runnability:

- Unfunded wallet → script stops at the preflight with funding instructions.
- Funded wallet → script deploys and trades, then writes
  `.spike-result.json` (token/market/trade hashes — gitignored).
- To continue a previous run instead of re-deploying, set
  `SPIKE_TOKEN_ADDRESS`, `MOCKUSD_ADDRESS` and/or `MARKET_ADDRESS` in `.env`;
  the script reuses them (minting is skipped when balances already suffice).
  Leftover resting orders from earlier runs can stack — cancel manually if you
  want a pristine book.

Known RPC quirks (all handled inside `spike.ts`):

- The public RPC intermittently drops connections (`ECONNRESET`/`ETIMEDOUT`);
  every `wait(1)` is wrapped in a retry, and a fixed `gasLimit` (2,000,000)
  skips the flakiest call (`eth_estimateGas`).
- **Do not hardcode a small `gasPrice`**: Monad rejects
  `Transaction fee too low` below ~102 gwei. The script leaves the gas price to
  `provider.getGasPrice()`.

## Supporting scripts

| Script | Purpose | Status |
|---|---|---|
| `scripts/compile.ts` | solc → `artifacts/*.json` (all contracts in `contracts/`) | works |
| `scripts/probe.ts` | docs-address audit (`eth_getCode`), market params, wallet balances | works |
| `scripts/usdc-check.ts` | historical: proves Kuru testnet USDC (`0x3bA3..570`) ≠ Circle/Monad-list USDC (`0x534b..3A3`) | works |
| `scripts/swap-probe.ts` | historical: whether MON→USDC is swappable via the empty official market | works |
| `scripts/l2.ts` | L2 book reader | works |
| `scripts/spike.ts` | the end-to-end script (this spike) | **works — executed end-to-end** |
| `scripts/scan.ts` | historical event scan | blocked by public-RPC `eth_getLogs` 100-block cap |
| `src/events.ts` | `OrderCreated` / `Trade` / `MarketRegistered` receipt parsers | works |

> `usdc-check.ts` / `swap-probe.ts` are retained as historical evidence from
> the earlier tUSDC investigation; the shipped spike does not touch tUSDC.

## Findings worth knowing

- **Docs discrepancy:** the SDK quickstart page (`docs.kuru.io/sdk/quickstart-sdk`)
  still ships `config.json` with *dead* addresses (Router
  `0x1f5A...7187`, MarginAccount `0xdDDa...2d9` — 0 code bytes). The
  Contract-addresses page is correct.
- **A custom quote token works through the official Router:** `Router.deployProxy`
  accepted `SPIKE/MOCKUSD` with no restrictions on the quote asset — you can
  create a market for *any* paired ERC-20s on Kuru.
- **`Trade` verification** is done from `Trade` events + `getL2OrderBook` +
  `s_orders` + ERC-20 balances; Kuru has no on-chain `getUserTrades` getter.
- **Units:** `IOC.placeMarket` sell `size` is parsed in **base** units (SPIKE,
  18 dec) with `minAmountOut` in **quote** units (6 dec). Order-book sizes are
  stored in `sizePrecision` units (`10^4`); prices in `pricePrecision` units
  (`10^6`). `formatUnits` needs the *decimal counts* (4 / 6), not the raw
  multipliers (a `decimals=10000` call throws `invalid decimal size`).
- **Monad public RPC** caps `eth_getLogs` at 100-block windows — batch scans
  must chunk.

## Files

```
spike/
  package.json / tsconfig.json / .env.example
  contracts/SpikeToken.sol        # placeholder mintable ERC-20 (18 dec, base)
  contracts/MockUSD.sol           # mock mintable ERC-20 (6 dec, quote)
  contracts/PriceOracle.sol       # Task 02: oracle (updater-restricted, band+stale checks)
  contracts/MzngnToken.sol        # Task 02: synthetic mzNGN (18 dec, vault-only mint/burn)
  contracts/CollateralVault.sol   # Task 02: 150% collateralized mint/redeem
  src/config.ts                   # every address + doc source + CORE_* knobs
  src/events.ts                   # event receipt parsers
  scripts/compile.ts, probe.ts, swap-probe.ts, l2.ts, spike.ts, scan.ts, core.ts, list-on-kuru.ts
  README.md                       # this report
```