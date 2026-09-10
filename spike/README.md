# SPIKE: SPIKE token + Kuru market + executed trade on Monad testnet

Technical spike for the Monad Metropolis project. Everything here runs on
**Monad testnet (chain id `10143`)** — no mainnet, no real value.

Goal: on testnet, deploy a placeholder ERC-20 (`SPIKE`), create a Kuru orderbook
market pairing `SPIKE` against **Kuru's official testnet USDC**, place one
post-only limit order and one fill-or-kill market order so a real trade
executes, and verify the trade on-chain.

```
┌─────────────┐   ┌──────────────────────────────────────────────────┐
│ spike.ts    │──▶│ 1. Deploy SPIKE (SpikeToken.sol)                  │
│ (npm run    │   │ 2. Router.deployProxy → SPIKE/USDC market         │
│  spike)     │   │    quote = official testnet USDC  (Contract-      │
│             │   │    addresses page)                                │
│             │   │ 3. Deposit USDC into MarginAccount (maker bid)    │
│             │   │ 4. GTC.placeLimit  BUY 1000 SPIKE @ 0.001, post   │
│             │   │ 5. IOC.placeMarket SELL 900 SPIKE (fill-or-kill)  │
│             │   │ 6. Verify: Trade events, L2 book, balances        │
└─────────────┘   └──────────────────────────────────────────────────┘
```

## Status

- [x] All official Kuru testnet addresses verified live via `eth_getCode`
      (`scripts/probe.ts`)
- [x] SPIKE token compiles and deploys (`scripts/compile.ts`,
      `contracts/SpikeToken.sol`)
- [x] Preflight + funding gates implemented and tested
      (`scripts/spike.ts` stops with clear instructions when the wallet is
      unfunded)
- [ ] **Full trade execution blocked on wallet funding** (see
      [Funding prerequisites](#funding-prerequisites)) — the runnable script is
      complete; a funded wallet is the only missing input.

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
| Official testnet USDC | `0x3bA3d39AFcf8bb994f7964B3e0171Ea2Ba361570` (6 dec) | same |
| Official MON/USDC market | `0xa241896A7Dbe8a550D2E5fF7A914bB1989ceD2D9` | same |
| SPIKE token | deployed by the script | `contracts/SpikeToken.sol` |
| SPIKE/USDC market | deployed by the script via Router | `ParamCreator.deployMarket` |

No address, RPC, or endpoint is invented: every constant in `src/config.ts`
carries its doc source in a comment.

## The trade plan

Market parameters (computed by `ParamCreator.calculatePrecisions(1, 1000, 0.01, 100, 10)`):

| Parameter | Value | Meaning |
|---|---|---|
| `pricePrecision` | `1_000_000` | price fixed at 6 decimals |
| `sizePrecision` | `10_000` | size fixed at 4 decimals |
| `tickSize` | `1` | `0.000001` USDC |
| `minSize` | `1_000_000` | `100` SPIKE |
| `maxSize` | `10_000_000_000` | `1_000_000` SPIKE |
| `takerFeeBps` / `makerFeeBps` | `30` / `10` | fees |
| `kuruAmmSpread` | `100` | 1% AMM spread |

Order flow:

1. Deposit `2` testnet USDC into the Kuru `MarginAccount` (powers the maker bid).
2. `GTC.placeLimit` — **maker**: BUY `1000` SPIKE @ `0.001` USDC, `postOnly: true`
   → `OrderCreated`, order rests in the book.
3. `IOC.placeMarket` — **taker**: SELL `900` SPIKE, `minAmountOut: 0.8` USDC,
   `fillOrKill: true` → fills `900` SPIKE @ `0.001` against the maker bid
   (`Trade` event: `filledSize = 9_000_000` in sizePrecision units, `price = 1000`
   in pricePrecision units).
4. Verify: `Trade` events on the sell receipt, L2 book (maker bid shrinks from
   `1000` to `100` SPIKE), wallet balances, and the maker order struct
   (`s_orders`).

Expected balances after the trade (approx):

- wallet SPIKE: `1_000_000 - 900 = 999_100`
- wallet USDC: `~0.8973` (900 × 0.001 − 0.3% taker fee)
- maker bid remaining: `100` SPIKE @ `0.001`

## Funding prerequisites

The disposable test wallet (`0x0f2a7EAd457b6bbe6d6a47f5470D722ABAcb58da`,
see `.env`) currently holds **0 MON / 0 USDC**, which blocks the on-chain part.
Funding is intentionally human/browser-in-the-loop:

1. **Testnet MON (gas)** — `https://faucet.monad.xyz`. The faucet back-end
   (`https://faucet.molandak.org/api/v1/faucet`) requires a Cloudflare Turnstile
   token + FingerprintJS visitor id, so it cannot be automated with curl/CLI.
2. **Testnet USDC** — Kuru's official tUSDC has **no public mint**. It must come
   from an existing holder or the Kuru app (testnet faucet / Lite Swap
   MON→USDC at `https://www.kuru.io`). Send `>= 2` tUSDC to the wallet above.

> Note: Monad reset its testnet from genesis on 2025-12-16 (current version
> v0.15.2). The token list at
> `raw.githubusercontent.com/monad-crypto/token-list/main/tokenlist-testnet.json`
> lists a *different* USDC (`0x534b2f3A...`); the **Kuru official testnet USDC**
> (`0x3bA3d39AFcf8bb994f7964B3e0171Ea2Ba361570`) is the one this spike trades
> against, per the Kuru contract-addresses page.

## How to run

```bash
cd spike
npm install          # already done; ethers 5.7.1, tsx, solc, @kuru-labs/kuru-sdk 0.0.95
cp .env.example .env # fill PRIVATE_KEY (disposable key already in .env)
npm run compile      # builds artifacts/SpikeToken.json
npm run spike        # end-to-end: deploy token+market, trade, verify
```

Re-runnability:

- Unfunded wallet → script stops at the preflight with funding instructions.
- Funded wallet → script deploys and trades, then writes
  `.spike-result.json` (token/market/trade hashes).
- To continue a previous partially-run deployment, set
  `SPIKE_TOKEN_ADDRESS` and/or `MARKET_ADDRESS` in `.env`; the script reuses
  them and skips redeployment (leftover resting orders from earlier runs can
  stack — cancel manually if needed for a pristine book).

## Supporting scripts

| Script | Purpose | Status |
|---|---|---|
| `scripts/compile.ts` | solc → `artifacts/SpikeToken.json` | works |
| `scripts/probe.ts` | docs-address audit (`eth_getCode`), market params, USDC mint probe, wallet balances | works |
| `scripts/swap-probe.ts` | check whether MON→USDC is swappable through the official MON/USDC market (`anyToAnySwap` eth_call); proved the market + AMM vault are empty | works |
| `scripts/l2.ts` | L2 book reader | works |
| `scripts/spike.ts` | the end-to-end script (this spike) | works; needs funded wallet |
| `scripts/scan.ts` | historical event scan | blocked by public-RPC `eth_getLogs` 100-block cap |
| `src/events.ts` | `OrderCreated` / `Trade` / `MarketRegistered` receipt parsers | works |

## Findings worth knowing

- **Docs discrepancy:** the SDK quickstart page (`docs.kuru.io/sdk/quickstart-sdk`)
  still ships `config.json` with *dead* addresses (Router
  `0x1f5A...7187`, MarginAccount `0xdDDa...2d9` — 0 code bytes). The
  Contract-addresses page is correct.
- **Official MON/USDC market is empty:** its L2 book *and* AMM vault have zero
  liquidity, so `Router.anyToAnySwap` MON→USDC reverts — there is currently no
  scriptable path to acquire tUSDC on testnet.
- **No mint on tUSDC:** the doc-published USDC is a bare ERC-20 with no
  `mint`/`faucet`/`grab`/`drip` entry points (probed).
- **Monad public RPC** caps `eth_getLogs` at 100-block windows — batch scans
  must chunk (multi-sig/registry enumeration not done for this spike).
- Trade verification is done from `Trade` events + `getL2OrderBook` +
  `s_orders` + ERC-20 balances; Kuru has no on-chain `getUserTrades` getter.
- `IOC.placeMarket` sell `size` is parsed in **base** units (SPIKE) with
  `minAmountOut` in **quote** units (USDC) — the config documents this.

## Files

```
spike/
  package.json / tsconfig.json / .env.example
  contracts/SpikeToken.sol        # placeholder mintable ERC-20
  src/config.ts                   # every address + doc source
  src/events.ts                   # event receipt parsers
  scripts/compile.ts, probe.ts, swap-probe.ts, l2.ts, spike.ts, scan.ts
  README.md                       # this report
```