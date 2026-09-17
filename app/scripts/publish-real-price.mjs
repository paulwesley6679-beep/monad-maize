// ---------------------------------------------------------------------------
// publish-real-price.mjs — publish a REAL, sourced Nigerian maize price to the
// deployed PriceOracle on Monad Testnet (chain 10143), replacing the demo
// "50.00 mUSD (example)" placeholder.
//
// SOURCE (NBS — National Bureau of Statistics, Nigeria):
//   NBS "Selected Food Price Watch" report, May 2026 edition:
//   https://microdata.nigerianstat.gov.ng/index.php/catalog/162/download/1427
//   File     : "selected food table May 26.xlsx" (from the ZIP above)
//   Series   : Maize (Corn) Grains (White), sold loose
//   Measure  : national average retail price, column "Average of May-26"
//   Value    : 815.8250150106671 NGN per kg
//   Notes    : The NFPT dashboard (nigeriafoodpricetracking.ng) is a Tableau
//              embed with no API; its downloadable pilot CSV ends 2026-06-25.
//              The World Bank HFCP microdata (catalog 8197) is login-gated and
//              the WB API source-88 endpoints hang from this network. The NBS
//              monthly report above is the most current public, authoritative
//              series and the same underlying data family the oracle's
//              "NBS Food Price Tracker" label refers to.
//
// CONVERSION (documented, recomputed every run):
//   1. 100 kg bag        = 100 × 815.8250150106671 = 81,582.50150106671 NGN
//   2. live FX           = NGN per 1 USD from https://open.er-api.com/v6/latest/USD
//                          (free mid-market feed; fetched at run time)
//      reference value at time of writing: 1327.882853 NGN/USD (2026-09-17)
//   3. price mUSD/bag    = NGN/bag ÷ NGN_per_USD
//      reference result: ~61.438 — well inside the oracle's ±30% (3000 bps)
//      move band around the current 50.00 mUSD baseline ([35.00, 65.00]).
//   4. oracle raw units  = round(price × 1e6)   (PriceOracle PRICE_DECIMALS = 6)
//
// SAFETY:
//   - Preflight re-reads the live oracle price/source and enforces the
//     MAX_CHANGE_BPS = 3000 band before anything is signed.
//   - Aborts unless the updater wallet balance covers the gas reserve.
//   - Runs in read-only mode with:   node scripts/publish-real-price.mjs --dry-run
//   - Requires VITE_DEV_WALLET_KEY (the authorized updater key) in app/.env.
//
// Broadcast pattern mirrors spike/scripts/core.ts (clamped EIP-1559 fees,
// explicit gasLimit to avoid the flaky estimateGas path, resilient wait).
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, Wallet } from "ethers";
import { ResilientRpcProvider } from "../src/lib/provider.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.join(__dirname, "..");

const ORACLE_ADDRESS = "0x914265f10042c56020205c4258ec19f99024e6a5";
const CHAIN_ID = 10143;
const PRICE_DECIMALS = 6;
const MAX_CHANGE_BPS = 3000n;
const BPS_DENOMINATOR = 10000n;
const GAS_LIMIT = 500_000n; // updatePrice(string) is small; generous like core.ts
const PRIORITY_FEE = 2_000_000_000n; // 2 gwei
const MIN_MAX_FEE = 115_000_000_000n; // floor, same as core.ts

// --- Source data (see header) ----------------------------------------------
const NBS_MAIZE_NGN_PER_KG = 815.8250150106671;
const BAG_KG = 100;
const FX_API_URL = "https://open.er-api.com/v6/latest/USD";
// On-chain source label for the frontend (must stay reasonably short).
const SOURCE_LABEL =
  "NBS Selected Food Price Watch May 2026: maize (white) national avg retail; FX open.er-api.com 2026-09-17";

const ABIS_DIR = path.join(APP_DIR, "src", "abis");

function loadEnv() {
  const envPath = path.join(APP_DIR, ".env");
  if (!fs.existsSync(envPath)) throw new Error(`Missing ${envPath}`);
  const out = {};
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function readAbi(name) {
  return JSON.parse(
    fs.readFileSync(path.join(ABIS_DIR, `${name}.json`), "utf8").replace(/^\uFEFF/, "")
  );
}

async function fetchNgnPerUsd() {
  const res = await fetch(FX_API_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`FX API HTTP ${res.status}`);
  const j = await res.json();
  const ngn = j?.rates?.NGN;
  if (typeof ngn !== "number" || !(ngn > 0)) throw new Error("FX API: no NGN rate in response");
  return { ngn, updated: j?.time_last_update_utc ?? "unknown" };
}

/** Clamped EIP-1559 overrides; mirrors core.ts makeTxOptions. */
async function makeTxOptions(provider) {
  let baseFee = 100_000_000_000n;
  try {
    const block = await provider.getBlock("latest");
    if (block?.baseFeePerGas != null) baseFee = block.baseFeePerGas;
  } catch {
    // keep default
  }
  const maxFeePerGas = baseFee * 5n / 4n + PRIORITY_FEE;
  return {
    gasLimit: GAS_LIMIT,
    maxFeePerGas: maxFeePerGas < MIN_MAX_FEE ? MIN_MAX_FEE : maxFeePerGas,
    maxPriorityFeePerGas: PRIORITY_FEE,
    type: 2,
  };
}

/** Retry a read-only RPC call on transient failures (core.ts withRetry pattern). */
async function readRetry(label, fn, tries = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= tries) throw e;
      const note = String(e?.message ?? e).slice(0, 120);
      console.warn(`  (${label} flaked: ${note} — retry ${attempt}/${tries - 1})`);
      await new Promise((r) => setTimeout(r, Math.min(attempt * 2500, 10000)));
    }
  }
}

/** Wait() that survives transient public-RPC poll errors (core.ts pattern). */
async function waitResilient(tx, confirmations = 1) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await tx.wait(confirmations);
    } catch (e) {
      const code = e?.code;
      if (code !== "SERVER_ERROR" && code !== "TIMEOUT" && code !== "NETWORK_ERROR") throw e;
      if (attempt >= 6) throw e;
      const delay = Math.min(attempt * 3000, 15000);
      console.warn(`  (receipt poll error: ${String(e?.message ?? e).slice(0, 120)} — retry ${attempt}/5 in ${delay}ms)`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const env = loadEnv();
  const privateKey = env.VITE_DEV_WALLET_KEY;
  if (!privateKey) throw new Error("VITE_DEV_WALLET_KEY not set in app/.env");

  const urls = [
    (env.VITE_RPC_URL || "https://testnet-rpc.monad.xyz").trim(),
    (env.VITE_RPC_FALLBACK_URL || "https://monad-testnet.drpc.org").trim(),
  ];
  const provider = new ResilientRpcProvider(urls, { maxAttempts: 3, timeoutMs: 20_000 });
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(CHAIN_ID)) throw new Error(`Unexpected chain ${network.chainId}`);

  const wallet = new Wallet(privateKey, provider);
  console.log("chain   :", CHAIN_ID, "| block:", await provider.getBlockNumber());
  console.log("updater :", wallet.address);

  const oracle = new Contract(ORACLE_ADDRESS, readAbi("PriceOracle"), provider);
  const G = { gasLimit: 300_000n }; // drpc rejects eth_call without explicit gas

  // --- Preflight reads (all with explicit gas; sequential + retried because
  // drpc intermittently rejects eth_call even with gas) ---------------------
  const authorizedUpdater = await readRetry("authorizedUpdater", () => oracle.authorizedUpdater(G));
  const currentPrice = await readRetry("price", () => oracle.price(G));
  const currentSource = await readRetry("source", () => oracle.source(G));
  const updatedAt = await readRetry("updatedAt", () => oracle.updatedAt(G));
  const staleness = await readRetry("stalenessWindow", () => oracle.stalenessWindow(G));
  if (authorizedUpdater.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(
      `Wallet ${wallet.address} is NOT the oracle updater (${authorizedUpdater}). Aborting.`
    );
  }
  console.log("price now:", Number(currentPrice) / 1e6, "mUSD/bag | source:", JSON.stringify(currentSource));
  console.log("updatedAt:", new Date(Number(updatedAt) * 1000).toISOString(), "| window:", Number(staleness), "s");

  // --- FX + conversion ------------------------------------------------------
  console.log("\nFetching NGN/USD from", FX_API_URL);
  const fx = await fetchNgnPerUsd();
  console.log("FX rate :", fx.ngn, "NGN/USD (feed updated", fx.updated + ")");

  const ngnPerBag = NBS_MAIZE_NGN_PER_KG * BAG_KG;
  const usdPerBag = ngnPerBag / fx.ngn;
  const raw = BigInt(Math.round(usdPerBag * 10 ** PRICE_DECIMALS));
  console.log("NBS      :", NBS_MAIZE_NGN_PER_KG, "NGN/kg →", ngnPerBag.toFixed(6), "NGN/100kg bag");
  console.log("convert  :", usdPerBag.toFixed(6), "USD/bag → raw", raw.toString(), `(${Number(raw) / 1e6} mUSD)`);

  // --- Band preflight (MAX_CHANGE_BPS = 3000) ------------------------------
  const maxUp = (currentPrice * (BPS_DENOMINATOR + MAX_CHANGE_BPS)) / BPS_DENOMINATOR;
  const maxDown = (currentPrice * (BPS_DENOMINATOR - MAX_CHANGE_BPS)) / BPS_DENOMINATOR;
  console.log(
    `band    : [${Number(maxDown) / 1e6}, ${Number(maxUp) / 1e6}] mUSD (±30% of ${Number(currentPrice) / 1e6})`
  );
  if (raw < maxDown || raw > maxUp) {
    throw new Error(`New price ${Number(raw) / 1e6} outside ±30% band — refusing to publish.`);
  }
  if (raw === 0n) throw new Error("Zero price — refusing.");

  // --- Gas reserve check ----------------------------------------------------
  const balance = await readRetry("getBalance", () => provider.getBalance(wallet.address));
  const reserve = GAS_LIMIT * (await makeTxOptions(provider)).maxFeePerGas;
  console.log("MON bal :", Number(balance) / 1e18, "| gas reserve ~", Number(reserve) / 1e18, "MON");
  if (balance < reserve) {
    throw new Error("Updater wallet balance below gas reserve — fund it (faucet.monad.xyz) and re-run.");
  }

  if (dryRun) {
    console.log("\nDRY-RUN — no transaction sent. Ready to publish:");
    console.log("  price :", Number(raw) / 1e6, "mUSD/bag (raw", raw.toString() + ")");
    console.log("  source:", JSON.stringify(SOURCE_LABEL));
    return;
  }

  // --- Broadcast ------------------------------------------------------------
  console.log("\nBroadcasting updatePrice(...) with clamped EIP-1559 fees...");
  const signer = new Wallet(privateKey, provider);
  const wOracle = new Contract(ORACLE_ADDRESS, readAbi("PriceOracle"), signer);
  const tx = await wOracle.updatePrice(raw, SOURCE_LABEL, await makeTxOptions(provider));
  console.log("tx sent :", tx.hash);
  const receipt = await waitResilient(tx, 1);
  console.log("receipt : status", receipt.status, "| block", receipt.blockNumber);
  if (receipt.status !== 1) throw new Error(`Transaction failed: ${tx.hash}`);
  console.log("explorer:", `https://testnet.monadvision.com/tx/${tx.hash}`);

  // --- On-chain verification ------------------------------------------------
  const [p, s, t] = await readRetry("getPrice", () => oracle.getPrice(G));
  console.log("\nVERIFY  : getPrice() ->", Number(p) / 1e6, "mUSD/bag");
  console.log("          updatedAt ->", new Date(Number(t) * 1000).toISOString());
  console.log("          source    ->", JSON.stringify(s));
  if (p !== raw) throw new Error(`On-chain price mismatch: ${p} != ${raw}`);
  if (s !== SOURCE_LABEL) throw new Error("On-chain source mismatch");
  console.log("\nDONE — real maize price is live on PriceOracle.");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nPUBLISH FAILED:", e?.message ?? e);
    process.exit(1);
  });