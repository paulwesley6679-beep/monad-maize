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