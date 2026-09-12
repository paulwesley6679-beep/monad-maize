// ---------------------------------------------------------------------------
// ethers v6 contract wiring for the Monad Maize app.
//
// A single place that maps the deployed addresses (config.ts) to typed
// Contract instances and small domain helpers. UI components never touch
// ethers internals directly — they go through useWallet/useContracts.
// ---------------------------------------------------------------------------

import { BrowserProvider, Contract, JsonRpcProvider, Signer, formatUnits, parseUnits } from "ethers";

import PriceOracleAbi from "../abis/PriceOracle.json";
import MockUSDAbi from "../abis/MockUSD.json";
import MzngnTokenAbi from "../abis/MzngnToken.json";
import CollateralVaultAbi from "../abis/CollateralVault.json";

import {
  COLLATERAL_VAULT_ADDRESS,
  MOCKUSD_ADDRESS,
  MZNGN_ADDRESS,
  PRICE_ORACLE_ADDRESS,
} from "../config";

/** An ethers "runner": a provider for reads, or a signer for writes. */
export type Runner = JsonRpcProvider | BrowserProvider | Signer;

export const oracleContract = (runner: Runner) =>
  new Contract(PRICE_ORACLE_ADDRESS, PriceOracleAbi, runner);

export const mockusdContract = (runner: Runner) =>
  new Contract(MOCKUSD_ADDRESS, MockUSDAbi, runner);

export const mzngnContract = (runner: Runner) =>
  new Contract(MZNGN_ADDRESS, MzngnTokenAbi, runner);

export const vaultContract = (runner: Runner) =>
  new Contract(COLLATERAL_VAULT_ADDRESS, CollateralVaultAbi, runner);

// ---------------------------------------------------------------------------
// Formatting helpers (18 dp mzNGN / 6 dp mUSD & prices both come out of
// BigInt raw units from ethers v6).
// ---------------------------------------------------------------------------

export function fmtMUSD(wei: bigint | null | undefined, digits = 2): string {
  if (wei === null || wei === undefined) return "—";
  const s = formatUnits(wei, 6);
  return Number(s).toFixed(digits);
}

export function fmtMZNGN(wei: bigint | null | undefined, digits = 4): string {
  if (wei === null || wei === undefined) return "—";
  const s = formatUnits(wei, 18);
  return Number(s).toFixed(digits);
}

export function fmtPrice(raw: bigint | null | undefined, digits = 2): string {
  if (raw === null || raw === undefined) return "—";
  const s = formatUnits(raw, 6);
  return Number(s).toFixed(digits);
}

export function parseMUSD(input: string): bigint {
  return parseUnits(input || "0", 6);
}

export function parseMZNGN(input: string): bigint {
  return parseUnits(input || "0", 18);
}

export function fmtTimestamp(sec: bigint | number | null | undefined): string {
  if (sec === null || sec === undefined) return "—";
  const n = typeof sec === "bigint" ? Number(sec) : sec;
  if (!Number.isFinite(n) || n === 0) return "—";
  return new Date(n * 1000).toLocaleString();
}