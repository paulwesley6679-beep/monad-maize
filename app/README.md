# Monad Maize — web app

Minimal React frontend for the Monad Maize hackathon MVP: connect a wallet,
see the live maize reference price, watch your balances, and mint/redeem
mzNGN against the deployed contracts on **Monad Testnet (chain id 10143)**.

## What it does

- **Connect wallet** — MetaMask (or any EIP-1193 wallet). If the wallet
  doesn't know Monad Testnet yet, the app offers to add it and switches
  automatically.
- **Live price** — reads `PriceOracle` (public RPC, works before connect),
  shows source, timestamp and how much of the freshness window has been used.
  Mint/redeem pause automatically if the price goes stale (contract-enforced).
- **Live balances** — mUSD collateral, mzNGN maize tokens, MON (gas) and the
  vault allowance, refreshed every 10 s.
- **Mint** — deposit mUSD, see exactly how much mzNGN you'll get, confirm.
  If your vault allowance is lower than the deposit, the app requests one
  approval first and then mints straight away.
- **Redeem** — burn mzNGN, see exactly how much mUSD pays out (150% ratio).
- **Tx status** — busy states while confirming, success/failure banners with a
  MonadVision explorer link, and a Dismiss button.

## Requirements

- Node.js 18+ and npm
- MetaMask (or another EIP-1193 wallet) to sign transactions

## Running locally

```bash
npm install
npm run dev        # http://localhost:5173
```

Open `http://localhost:5173`, connect your wallet, approve adding Monad
Testnet if prompted, and you're in. Fund the account with testnet MON from
https://faucet.monad.xyz — every mint/redeem is a real transaction.

### Dev-only: browser-less wallet shim

If you're testing without MetaMask (or inside a headless browser), load the
page with `?dev-wallet=1` and set `VITE_DEV_WALLET_KEY` in `app/.env` to a
testnet private key:

```
VITE_DEV_WALLET_KEY=0x...
```

The app then simulates a wallet with that key. It prints a warning to the
console and must never be used against anything but throwaway testnet funds.
`.env` is gitignored.

## Live price & publishing real data

The `PriceOracle` is fed by a simple manual-publish script
(`scripts/publish-real-price.mjs`). The currently live price is a **real,
sourced value** — not a demo placeholder:

- **Price:** `61.438026` mUSD per 100 kg bag (raw `61438026`), published
  `2026-09-17` (tx
  `0x030ff96853a4e08c844d83edde1e79baa6803bb609631bfebc64fcc18058ab96`).
- **Source:** NBS "Selected Food Price Watch" report, May 2026 edition
  (`https://microdata.nigerianstat.gov.ng/index.php/catalog/162/download/1427`)
  — maize (white) national average retail price, `815.8250150106671` NGN/kg.
- **Conversion:** 100 kg bag → `81,582.50150106671` NGN, divided by the NGN/USD
  mid-market rate from `https://open.er-api.com/v6/latest/USD`
  (`1327.882853` NGN/USD on 2026-09-17) → `61.438026` mUSD/bag. The rate is
  fetched fresh on every run and the computed price is validated against the
  oracle's ±30% (`MAX_CHANGE_BPS = 3000`) move band before anything is signed.
- Why not the other candidates: the NFPT dashboard
  (`nigeriafoodpricetracking.ng`) is a Tableau embed with no API and its pilot
  CSV ends 2026-06-25; the World Bank HFCP microdata is login-gated and the WB
  API food-price endpoints hang from this network. The NBS monthly report is
  the most current public, authoritative series.

Re-publish a fresh price anytime (needs the authorized updater key in
`app/.env`, `--dry-run` skips the broadcast):

```bash
node scripts/publish-real-price.mjs --dry-run   # preflight only
node scripts/publish-real-price.mjs             # broadcast + verify
```

## Building for production

```bash
npm run build      # type-check + bundle into dist/
npm run preview    # serve the production build locally
```

## Deployed contracts (Monad Testnet, chain 10143)

| Contract        | Address                                      |
| --------------- | -------------------------------------------- |
| PriceOracle     | `0x914265f10042c56020205c4258ec19f99024e6a5` |
| MockUSD         | `0xe4d3bd26ab76f5e7a21122feeec0bc0d86547e2e` |
| MzngnToken      | `0x7f895bf9bbe1ef044af95c3c6d1d842e96cda8f7` |
| CollateralVault | `0x5eee7da8bdb8680da889502f655c5c2a5bc9cddb` |

## Project structure

```
app/
  index.html / vite.config.ts / tsconfig.json
  src/
    config.ts          # chain + RPC + addresses + decimals
    lib/contracts.ts   # ethers v6 wiring + formatting (no ethers in components)
    lib/errors.ts      # thrown errors → friendly on-screen messages
    hooks/useWallet.ts # connect / network switch / wallet events
    hooks/useContracts.ts # oracle, balances, previews, mint/redeem, tx state
    components/        # ConnectWallet, OraclePanel, BalancePanel, MintRedeem
    abis/              # contract ABIs extracted from spike/artifacts
```

## Known rough edges

- **RPC flakiness** — `https://testnet-rpc.monad.xyz` intermittently times
  out (a known Monad testnet quirk, also noted in the spike README). Reads
  retry on the next 10 s poll; a failed tx just shows a retry-able banner.
- This is a hackathon MVP: testnet only, funds are play-money, no accounts
  system, no automated price feed (the oracle carries a real NBS-sourced value
  published via `scripts/publish-real-price.mjs`; it must be refreshed within
  the 48 h staleness window to keep mint/redeem active).