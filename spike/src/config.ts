import * as dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

// ---------------------------------------------------------------------------
// Every address / endpoint below is sourced from official docs. Do not change
// them without re-checking the source page. Sources:
//
// - Monad testnet RPC + chain id + explorers:
//     https://docs.monad.xyz/developer-essentials/testnet
//       RPC  : https://testnet-rpc.monad.xyz
//       Chain: 10143 (0x279f)
//       Explorer: https://testnet.monadvision.com | https://testnet.monadscan.com
//
// - Kuru testnet contracts + official testnet USDC + MON-USDC market:
//     https://docs.kuru.io/contracts/Contract-addresses
// ---------------------------------------------------------------------------

export const CHAIN_ID = 10143;
export const EXPLORER = "https://testnet.monadvision.com";

export const RPC_URL =
  process.env.RPC_URL || "https://testnet-rpc.monad.xyz";

export const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
export const WALLET_ADDRESS = process.env.WALLET_ADDRESS || "";

// --- Kuru testnet contracts (https://docs.kuru.io/contracts/Contract-addresses) ---
export const KURU_ROUTER_TESTNET = "0x7EFbE105Ca7415dE98F96622173458ac1c054630";
export const KURU_MARGIN_TESTNET = "0xd029C2D98ff85D8F64799017fE00a59B1159CE02";
export const KURU_FORWARDER_TESTNET = "0x681bB1508E14433b148a2549ba2726454aDc9BB4";
export const KURU_DEPLOYER_TESTNET = "0xDacd06372cEb638640c9D8466A023b7362324e1A";
export const KURU_UTILS_TESTNET = "0xE0841E0F06c5770C1D4930EC6C507ee33199C88C";

// --- Official Kuru testnet tokens / markets (https://docs.kuru.io/contracts/Contract-addresses) ---
export const TESTNET_USDC = "0x3bA3d39AFcf8bb994f7964B3e0171Ea2Ba361570";
export const TESTNET_USDC_DECIMALS = 6;
export const KURU_MON_USDC_MARKET_TESTNET = "0xa241896A7Dbe8a550D2E5fF7A914bB1989ceD2D9";

// --- Token / market parameters for the spike ---
export const SPIKE_NAME = "Spike Test Token";
export const SPIKE_SYMBOL = "SPIKE";
export const SPIKE_DECIMALS = 18;
export const SPIKE_INITIAL_SUPPLY = "1000000"; // 1M SPIKE to the deployer

// QUOTE token for the spike market: a self-deployed, mintable mock (6 decimals).
// Chosen so the spike is self-sufficient - no external testnet USDC needed.
export const MOCKUSD_NAME = "Mock USD";
export const MOCKUSD_SYMBOL = "MOCKUSD";
export const MOCKUSD_DECIMALS = 6;
export const MOCKUSD_INITIAL_SUPPLY = "1000000"; // 1M MOCKUSD to the deployer
export const MOCKUSD_MINT_TO_SELF = "10000"; // extra MOCKUSD minted to the wallet if short

// Market: 1 SPIKE = 0.001 USDC at creation
export const MARKET_TYPE = 0; // NO_NATIVE: both base and quote are ERC-20
export const TARGET_PRICE_QUOTE = 1; // 1 USDC
export const TARGET_PRICE_BASE = 1000; // per 1000 SPIKE  -> 0.001 USDC/SPIKE
export const MAX_PRICE = 0.01; // max expected price in USDC
export const MIN_SIZE = 100; // min order size in SPIKE
export const TICK_SIZE_BPS = 10; // 0.1%
export const TAKER_FEE_BPS = 30;
export const MAKER_FEE_BPS = 10;
export const KURU_AMM_SPREAD = ethers.BigNumber.from(100); // 1%

// Order sizes for the spike (human units). Note: IOC.placeMarket SELL size is in
// BASE units (SPIKE), minAmountOut is in QUOTE units (MOCKUSD).
export const LIMIT_BUY_SIZE = "1000"; // SPIKE to buy (maker, uses margin)
export const LIMIT_BUY_PRICE = "0.001"; // MOCKUSD per SPIKE
export const MARKET_SELL_SIZE = "900"; // SPIKE to sell (taker, from wallet)
export const MARKET_SELL_MIN_OUT = "0.8"; // min MOCKUSD received (gross ≈ 0.9, net ≈ 0.8973)
export const MARGIN_DEPOSIT_QUOTE = "2"; // margin deposit for the limit buy (1.0 + buffer)
export const SPIKE_MINT_TO_SELF = "1000000"; // SPIKE minted to the wallet for selling

export function getWalletAddress(): string {
  if (WALLET_ADDRESS) return WALLET_ADDRESS;
  if (!PRIVATE_KEY) throw new Error("PRIVATE_KEY not set in .env");
  return new ethers.Wallet(PRIVATE_KEY).address;
}

// ---------------------------------------------------------------------------
// Core product (Task 02): PriceOracle + MzngnToken + CollateralVault.
// All on MONAD TESTNET only. Numbers below are the mzNGN product parameters.
// ---------------------------------------------------------------------------

// Initial reference price published to the oracle: mUSD per 100kg bag of
// Nigerian maize. 50.00 mUSD chosen as a clean worked-example anchor; real
// NBS-style quotes (e.g. ~NGN 85,000/bag ~= 53 mUSD at ~NGN 1,600/USD) slot
// right in here. Price is stored with 6 decimals (mUSD scale).
export const CORE_INITIAL_PRICE_MUSD = "50.00";
export const CORE_INITIAL_SOURCE = "NBS Food Price Tracker (example)";
export const CORE_ORACLE_STALENESS_HOURS = 48; // fresh window before reads revert

// The mint/redeem loop proven on-chain by scripts/core.ts:
export const CORE_MINT_DEPOSIT_MUSD = "150"; // deposit 150.00 mUSD -> expect 2.0 mzNGN @ 50.00
export const CORE_REDEEM_MZNGN = "1"; // burn 1.0 mzNGN @ 50.00 -> expect 75.00 mUSD
export const CORE_MOCKUSD_MINT_TO_SELF = "1000"; // extra MOCKUSD minted if the wallet is short

// Dedicated tiny-window oracle probe used to prove that getPrice() rejects
// STALE prices on-chain (wait ~= probe window, then expect a revert).
// This avoids waiting the full 48h production window.
export const CORE_STALE_PROBE_WINDOW_SECONDS = 60;

// ---------------------------------------------------------------------------
// Task 05: mzNGN on a real Kuru orderbook market (MZNGN / MOCKUSD).
// Uses the Task 02 deployed contracts on MONAD TESTNET (chain 10143) only.
// ---------------------------------------------------------------------------

// Task 02 deployed addresses (live on chain 10143, verified via eth_getCode).
// Env overrides: MOCKUSD_ADDRESS / MZNGN_TOKEN_ADDRESS / COLLATERAL_VAULT_ADDRESS /
// PRICE_ORACLE_ADDRESS / MARKET_ADDRESS (all in .env, same slots as scripts/core.ts).
export const CORE_MOCKUSD_DEFAULT = "0xe4d3bd26ab76f5e7a21122feeec0bc0d86547e2e"; // MockUSD (6 dec)
export const MZNGN_TOKEN_DEFAULT = "0x7f895bf9bbe1ef044af95c3c6d1d842e96cda8f7"; // MzngnToken (18 dec)
export const COLLATERAL_VAULT_DEFAULT = "0x5eee7da8bdb8680da889502f655c5c2a5bc9cddb"; // CollateralVault
export const PRICE_ORACLE_DEFAULT = "0x914265f10042c56020205c4258ec19f99024e6a5"; // PriceOracle

// Market anchor: 1 mzNGN = 61.44 mUSD (oracle last published 61.438026 mUSD/bag;
// 61.44 is the nearest book-aligned tick and is 0.003% above the oracle spot).
// calculatePrecisions(quote=6144, base=100, maxPrice=200, minSize=1, tickBps=10)
// yields pricePrecision=1e5, sizePrecision=1e7, tickSize=6144 raw (0.06144 mUSD),
// minSize=1e7 raw (1 mzNGN), maxSize=1e9 raw (100 mzNGN).
export const LIST_MARKET_TYPE = 0; // NO_NATIVE: both base and quote are ERC-20
export const LIST_TARGET_PRICE_QUOTE = 6144; // 61.44 mUSD * 100
export const LIST_TARGET_PRICE_BASE = 100; // per 100 mzNGN -> 61.44 mUSD/mzNGN
export const LIST_MAX_PRICE = 200; // max expected price in mUSD per mzNGN
export const LIST_MIN_SIZE = 1; // min order size in mzNGN
export const LIST_TICK_SIZE_BPS = 10; // 0.1% tick
export const LIST_TAKER_FEE_BPS = 30;
export const LIST_MAKER_FEE_BPS = 10;
export const LIST_KURU_AMM_SPREAD = ethers.BigNumber.from(100); // 1%

// Orders (human units). Limit orders are backed by MarginAccount balances:
// the bid locks 20*61.44 = 1228.80 mUSD, the ask locks 20 mzNGN (plus buffers).
export const LIST_MARGIN_QUOTE = "1400"; // mUSD -> MarginAccount (funds the bid)
export const LIST_MARGIN_BASE = "25"; // mzNGN -> MarginAccount (funds the ask)
export const LIST_BID_SIZE = "20"; // mzNGN to buy @ 61.44 (maker, post-only)
export const LIST_BID_PRICE = "61.44"; // mUSD per mzNGN (1000 * tickSize, aligned)
export const LIST_ASK_SIZE = "20"; // mzNGN to sell @ 61.50144 (maker, post-only)
export const LIST_ASK_PRICE = "61.50144"; // mUSD per mzNGN (1001 * tickSize, aligned)
export const LIST_TAKER_SELL_SIZE = "15"; // mzNGN taker market SELL (wallet balance)
export const LIST_TAKER_SELL_MIN_OUT = "915"; // min mUSD out (gross 921.60; net after 0.3% taker fee ~918.84)
export const LIST_TOPUP_MUSD = "3000"; // vault mint top-up when short (or LIST_FORCE_TOPUP=1): ~32.55 mzNGN @ 61.438